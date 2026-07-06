#!/bin/bash
# scripts/run_scheduled.sh — launchd entrypoint for scheduled /run invocations.
# Usage: scripts/run_scheduled.sh <profile1> [<profile2> ...]
# Runs profiles strictly sequentially (never concurrently) to share one Chrome/CDP session.

# Export PATH with both the claude CLI and Node.
# Note: Other Job Bunny users should adjust the node path line below to match their own install location.
export PATH="$HOME/.local/bin:$HOME/.local/node-v20.18.1/bin:$PATH"

# Resolve repo root reliably.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Strict error handling: -u (error on unset vars), -o pipefail (propagate pipe errors).
# Deliberately NOT -e, so one profile's failure doesn't abort remaining profiles.
set -uo pipefail

# Enable job control (monitor mode) even though this script runs non-interactively — without
# it, a backgrounded command shares the script's own process group, so signaling just its PID
# on timeout would NOT reach any child processes it spawned (they'd be orphaned, still running,
# still holding files/connections open). With -m, `claude &` gets its own process group, so the
# watchdog can signal the whole group (`kill -TERM -- -$pid`) and actually take down the tree.
set -m

# Kill a hung headless run instead of blocking this profile's slot indefinitely — a genuine
# hang (not a clean stage failure) would otherwise never trigger any of the Telegram/doctor
# alerts, since those all fire on a stage *completing* with an error, not on the process never
# finishing. One observed full real run took ~12 minutes; 45 min gives generous headroom for a
# heavier day while still catching a real hang well before the next scheduled slot. Override
# with JOBBUNNY_RUN_TIMEOUT_SECONDS if needed.
#
# Not using GNU coreutils `timeout`/`gtimeout` — neither ships on stock macOS. Portable
# bash equivalent: background the claude process, run a watchdog subshell that SIGTERMs
# (then SIGKILLs) it if it's still alive past the deadline, and `wait` for whichever finishes.
TIMEOUT_SECONDS="${JOBBUNNY_RUN_TIMEOUT_SECONDS:-2700}"

# Loop over profiles strictly sequentially.
for profile in "$@"; do
  # Ensure the logs directory exists.
  mkdir -p "$ROOT/profiles/$profile/data/logs"

  # Run the /run stage sequence, capture both stdout and stderr, and tee to a timestamped log file.
  timestamp=$(date +%Y%m%d_%H%M%S)
  log_file="$ROOT/profiles/$profile/data/logs/run_${timestamp}.log"

  echo "[run_scheduled.sh] Starting profile: $profile (timeout: ${TIMEOUT_SECONDS}s)" >&2

  # timed_out_flag's presence (not its content) is the signal the watchdog fired — avoids
  # inferring "did we time out?" from a magic signal-derived exit code.
  timed_out_flag="$(mktemp)"
  rm -f "$timed_out_flag"

  # Background claude directly (not as part of a `|` pipe) so $! is its own PID, not tee's.
  # Process substitution still tees its stdout+stderr to both the terminal and the log file.
  claude -p "/run $profile" --dangerously-skip-permissions > >(tee "$log_file") 2>&1 &
  claude_pid=$!

  (
    sleep "$TIMEOUT_SECONDS"
    if kill -0 "$claude_pid" 2>/dev/null; then
      touch "$timed_out_flag"
      # Negative PID = signal the whole process group (claude + any children it spawned),
      # not just the top-level PID — see the set -m comment above for why this matters.
      kill -TERM -- "-$claude_pid" 2>/dev/null
      sleep 5
      kill -KILL -- "-$claude_pid" 2>/dev/null
    fi
  ) &
  watchdog_pid=$!

  wait "$claude_pid" 2>/dev/null
  exit_code=$?

  # Run finished on its own — stop the now-pointless watchdog rather than leave it ticking.
  kill "$watchdog_pid" 2>/dev/null
  wait "$watchdog_pid" 2>/dev/null

  # Brief grace period for the tee process substitution to flush its last lines before we grep it.
  sleep 1

  if [ -f "$timed_out_flag" ]; then
    timed_out=1
    rm -f "$timed_out_flag"
  else
    timed_out=0
  fi

  # Check for success marker in the log file, and that claude itself exited cleanly.
  if [ "$timed_out" -eq 1 ]; then
    status="FAILED"
    message="Job Bunny run TIMED OUT after ${TIMEOUT_SECONDS}s for $profile (killed) — check log: $log_file"
  elif [ "$exit_code" -eq 0 ] && grep -q "## Run Summary" "$log_file"; then
    status="PASSED"
    message="Job Bunny run completed successfully for $profile. Log: $log_file"
  else
    status="FAILED"
    message="Job Bunny run failed for $profile. Check log: $log_file"
  fi

  # Fire macOS notification.
  osascript -e "display notification \"$message\" with title \"Job Bunny $status\""

  # Forward the same digest to Telegram (best-effort — notify.js never throws/exits non-zero).
  # On success, the body is the log's "## Run Summary" block onward; on failure, a plain message.
  # Title/profile no longer repeat "Job Bunny .. — $profile" — the Telegram formatter's own
  # banner already carries both, per telegram_format.js.
  if [ "$status" = "PASSED" ]; then
    notify_body=$(sed -n '/## Run Summary/,$p' "$log_file")
    if [ -z "$notify_body" ]; then
      notify_body="$message"
    fi
    JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/notify.js" --severity success --title "Run complete" --body "$notify_body"
  elif [ "$timed_out" -eq 1 ]; then
    JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/notify.js" --severity blocking --title "Run timed out" --body "$message"
  else
    JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/notify.js" --severity blocking --title "Run failed" --body "$message"
  fi

  echo "[run_scheduled.sh] Finished profile: $profile (status: $status)" >&2
done
