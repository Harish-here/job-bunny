#!/bin/bash
# scripts/ops/run_scheduled.sh — launchd entrypoint for scheduled /run invocations.
# Usage: scripts/ops/run_scheduled.sh <profile1> [<profile2> ...]
# Runs profiles strictly sequentially (never concurrently) to share one Chrome/CDP session.

# Export PATH with both the claude CLI and Node.
# Note: Other Job Bunny users should adjust the node path line below to match their own install location.
export PATH="$HOME/.local/bin:$HOME/.local/node-v20.18.1/bin:$PATH"

# Resolve repo root reliably.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Strict error handling: -u (error on unset vars), -o pipefail (propagate pipe errors).
# Deliberately NOT -e, so one profile's failure doesn't abort remaining profiles.
set -uo pipefail

# Enable job control (monitor mode) even though this script runs non-interactively — without
# it, a backgrounded command shares the script's own process group, so signaling just its PID
# on timeout would NOT reach any child processes it spawned (they'd be orphaned, still running,
# still holding files/connections open). With -m, `claude &` gets its own process group, so a
# watchdog can signal the whole group (`kill -TERM -- -$pid`) and actually take down the tree.
set -m

# Kill a hung headless run instead of blocking this profile's slot indefinitely — a genuine
# hang (not a clean stage failure) would otherwise never trigger any of the Telegram/doctor
# alerts, since those all fire on a stage *completing* with an error, not on the process never
# finishing. One observed full real run took ~12 minutes, but a slow-to-render LinkedIn session
# (card fields timing out at Playwright's 30s default before the CARD_FIELD_TIMEOUT_MS fix) has
# pushed a real run past 20 min; 30 min gives headroom for that while still catching a genuine
# hang well before the next scheduled slot. Override with JOBBUNNY_RUN_TIMEOUT_SECONDS if needed.
#
# Not using GNU coreutils `timeout`/`gtimeout` — neither ships on stock macOS. Portable
# bash equivalent: background the orchestrate.js process, run a watchdog subshell that SIGTERMs
# (then SIGKILLs) it if it's still alive past the deadline, and `wait` for whichever finishes.
TIMEOUT_SECONDS="${JOBBUNNY_RUN_TIMEOUT_SECONDS:-1800}"

# Runs one attempt of `node orchestrate.js --profile <profile>`, tee'd to $2. orchestrate.js
# now owns the retry/stall/heartbeat/timeout logic and Telegram notification internally — this
# is only a coarse backstop for a genuine hang orchestrate itself never recovers from. Sets
# ATTEMPT_EXIT_CODE and ATTEMPT_TIMED_OUT as globals for the caller to read; does not itself
# decide PASS/FAIL or notify.
run_attempt() {
  local profile="$1" log_file="$2"
  local orchestrate_pid timeout_watchdog_pid caffeinate_pid timed_out_flag
  local backstop_seconds=$(( ${JOBBUNNY_RUN_TIMEOUT_SECONDS:-1800} + 300 ))

  timed_out_flag="$(mktemp)"; rm -f "$timed_out_flag"

  # orchestrate.js IS the pipeline runner now — it spawns each stage as a foreground child and
  # owns retry/stall/timeout/failure-capture. --dangerously-skip-permissions is no longer passed
  # here: orchestrate spawns `claude -p /structure ... --dangerously-skip-permissions` itself.
  JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/ops/orchestrate.js" --profile "$profile" \
    > >(tee "$log_file") 2>&1 &
  orchestrate_pid=$!

  # Keep the machine awake for the run (launchd does not); -w releases on the pid's exit.
  caffeinate -i -s -w "$orchestrate_pid" &
  caffeinate_pid=$!

  # Coarse backstop only: if orchestrate is still alive past the deadline, group-kill it (stages
  # are non-detached, so they share its group and get the signal too).
  (
    sleep "$backstop_seconds"
    if kill -0 "$orchestrate_pid" 2>/dev/null; then
      touch "$timed_out_flag"
      kill -TERM -- "-$orchestrate_pid" 2>/dev/null
      sleep 20
      kill -KILL -- "-$orchestrate_pid" 2>/dev/null
    fi
  ) &
  timeout_watchdog_pid=$!

  wait "$orchestrate_pid" 2>/dev/null
  ATTEMPT_EXIT_CODE=$?

  kill "$timeout_watchdog_pid" 2>/dev/null; wait "$timeout_watchdog_pid" 2>/dev/null
  kill "$caffeinate_pid" 2>/dev/null; wait "$caffeinate_pid" 2>/dev/null

  sleep 1  # let the tee subshell flush before anyone greps the log

  if [ -f "$timed_out_flag" ]; then ATTEMPT_TIMED_OUT=1; else ATTEMPT_TIMED_OUT=0; fi
  rm -f "$timed_out_flag"
}

# Turns the ATTEMPT_* globals from the most recent run_attempt call into STATUS/REASON/MESSAGE.
determine_status() {
  local profile="$1" log_file="$2"

  if [ "$ATTEMPT_TIMED_OUT" -eq 1 ]; then
    STATUS="FAILED"
    REASON="timeout"
    MESSAGE="Job Bunny run TIMED OUT for $profile (backstop killed orchestrate) — check log: $log_file"
  elif [ "$ATTEMPT_EXIT_CODE" -eq 0 ]; then
    STATUS="PASSED"
    REASON="passed"
    MESSAGE="Job Bunny run completed successfully for $profile. Log: $log_file"
  else
    STATUS="FAILED"
    REASON="other"
    MESSAGE="Job Bunny run failed for $profile. Check log: $log_file"
  fi
}

# Loop over profiles strictly sequentially.
for profile in "$@"; do
  # Ensure the logs directory exists.
  mkdir -p "$ROOT/profiles/$profile/data/logs"

  timestamp=$(date +%Y%m%d_%H%M%S)
  log_file="$ROOT/profiles/$profile/data/logs/run_${timestamp}.log"

  echo "[run_scheduled.sh] Starting profile: $profile (timeout: ${TIMEOUT_SECONDS}s)" >&2
  run_attempt "$profile" "$log_file"
  determine_status "$profile" "$log_file"

  # Fire macOS notification.
  osascript -e "display notification \"$MESSAGE\" with title \"Job Bunny $STATUS\""

  echo "[run_scheduled.sh] Finished profile: $profile (status: $STATUS, reason: $REASON)" >&2
done

# All scheduled profiles for this invocation are done — close the debug Chrome instead of
# leaving it idle until the next slot (as little as 2.5h away on a multi-fire schedule). It's
# relaunched fresh by doctor.js at the start of the next run; the LinkedIn session lives in
# the on-disk .chrome-debug profile, not the running process, so nothing is lost by closing
# it. Scoped to scheduled runs only — an interactive /run leaves Chrome open on purpose, e.g.
# to inspect a page after a selector-drift failure. That scoping is enforced here, not just
# assumed: skip the close if any OTHER `claude -p` process is currently alive (our own has
# already been waited on and is done by this point in the script), since scheduled
# invocations never overlap each other — any live one found here can only be a manual/
# interactive session actively using this same shared Chrome.
#
# This is now a BACKSTOP, not the primary Chrome-lifecycle owner: extract.js itself kills
# Chrome on every exit path (success, error, and signal handlers alike — see teardown() in
# extract.js), so a normally-finishing run (including one killed cleanly via SIGTERM by either
# watchdog above) has already closed it by the time we get here. This block only still matters
# for a SIGKILLed run (extract's own signal handler never got to run) or a manual
# JOBBUNNY_KEEP_BROWSER=1 run whose Chrome was deliberately left open and then abandoned. The
# pgrep guard and kill logic below are unchanged.
if pgrep -f "claude -p " >/dev/null 2>&1; then
  echo "[run_scheduled.sh] Another claude invocation is active — leaving debug Chrome open" >&2
else
  chrome_pid=$(lsof -ti :9222 -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -n "${chrome_pid:-}" ]; then
    echo "[run_scheduled.sh] Closing debug Chrome (pid $chrome_pid)" >&2
    kill -TERM "$chrome_pid" 2>/dev/null
    sleep 3
    if kill -0 "$chrome_pid" 2>/dev/null; then
      kill -KILL "$chrome_pid" 2>/dev/null
    fi
  fi
fi
