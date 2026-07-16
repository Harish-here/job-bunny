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
# finishing. One observed full real run took ~12 minutes; 45 min gives generous headroom for a
# heavier day while still catching a real hang well before the next scheduled slot. Override
# with JOBBUNNY_RUN_TIMEOUT_SECONDS if needed.
#
# Not using GNU coreutils `timeout`/`gtimeout` — neither ships on stock macOS. Portable
# bash equivalent: background the claude process, run a watchdog subshell that SIGTERMs
# (then SIGKILLs) it if it's still alive past the deadline, and `wait` for whichever finishes.
TIMEOUT_SECONDS="${JOBBUNNY_RUN_TIMEOUT_SECONDS:-1200}"

# Second, much shorter watchdog: how long to wait for /extract's start marker
# (extract_started.json, written by extract.js as literally its first action — see
# check_extract_started.js) before concluding /extract never actually started. This exists
# because of a real incident: run.md explicitly forbids backgrounding /extract in headless
# mode (a backgrounded stage's promised "I'll be notified when it finishes" can never arrive,
# since the single-shot `claude -p` process exits at the end of that turn) — but a fresh
# headless agent violated that rule anyway, and the run just hung until the full 45-min
# timeout above killed it, with no useful signal until then. 5 min is comfortably longer than
# doctor+reconcile ever take alone, so a healthy run's marker is always in place well before
# this fires. Override with JOBBUNNY_EXTRACT_HEARTBEAT_SECONDS if needed.
HEARTBEAT_SECONDS="${JOBBUNNY_EXTRACT_HEARTBEAT_SECONDS:-300}"

# How long extract's progress file (data/extract_progress.json) may go without an update before
# the run is declared STALLED (as opposed to never-started, above) and killed. extract.js
# rewrites this file at every checkpoint — stage boundary, per-URL start/end, every 5 JD
# captures — so a healthy run updates it far more often than this; only a genuine hang (e.g. a
# wedged page load) would go this long between checkpoints. Override with
# JOBBUNNY_EXTRACT_STALL_SECONDS if needed.
STALL_SECONDS="${JOBBUNNY_EXTRACT_STALL_SECONDS:-600}"

# Runs one attempt of `claude -p "/run $profile"`, tee'd to $2, racing two independent
# watchdogs against the same process — the heartbeat watchdog above, and the full-timeout
# watchdog as the final backstop for any other kind of hang. Sets ATTEMPT_EXIT_CODE,
# ATTEMPT_TIMED_OUT, ATTEMPT_HEARTBEAT_FAILED, ATTEMPT_STALLED, ATTEMPT_RUN_START_EPOCH as
# globals for the caller to read; does not itself decide PASS/FAIL or notify.
run_attempt() {
  local profile="$1" log_file="$2"
  local timed_out_flag heartbeat_failed_flag stalled_flag run_start_epoch
  local claude_pid timeout_watchdog_pid heartbeat_watchdog_pid

  # Flags' presence (not content) is the signal a watchdog fired — avoids inferring "did it
  # fire?" from a magic signal-derived exit code.
  timed_out_flag="$(mktemp)"; rm -f "$timed_out_flag"
  heartbeat_failed_flag="$(mktemp)"; rm -f "$heartbeat_failed_flag"
  stalled_flag="$(mktemp)"; rm -f "$stalled_flag"

  # Recorded before launching claude — check_run_result.js / check_extract_started.js both use
  # this to reject a stale marker left over from an earlier run.
  run_start_epoch=$(date +%s)

  # Background claude directly (not as part of a `|` pipe) so $! is its own PID, not tee's.
  # Process substitution still tees its stdout+stderr to both the terminal and the log file.
  # JOBBUNNY_HEADLESS=1 tells run.md's own forwarding instructions to skip their own Telegram
  # send, since this script sends its own digest below once claude exits — without this, both
  # layers fire and every scheduled run double-notifies (found via live testing).
  JOBBUNNY_HEADLESS=1 claude -p "/run $profile" --dangerously-skip-permissions > >(tee "$log_file") 2>&1 &
  claude_pid=$!

  (
    sleep "$TIMEOUT_SECONDS"
    if kill -0 "$claude_pid" 2>/dev/null; then
      touch "$timed_out_flag"
      # Negative PID = signal the whole process group (claude + any children it spawned),
      # not just the top-level PID — see the `set -m` comment above for why this matters.
      kill -TERM -- "-$claude_pid" 2>/dev/null
      # extract's SIGTERM teardown kills Chrome itself (SIGTERM + up-to-5s grace + SIGKILL);
      # 5s here guillotined it mid-teardown and leaked Chrome outside the process group.
      sleep 20
      kill -KILL -- "-$claude_pid" 2>/dev/null
    fi
  ) &
  timeout_watchdog_pid=$!

  # Polling stall watchdog: after the initial grace window (time for /doctor + /reconcile to
  # run before /extract even gets a chance to write its start marker), poll the 3-arg
  # check_extract_started.js every 60s for as long as claude is alive. rc=1 means never-started
  # (the original failure mode this watchdog was built for); rc=2 means the run DID start but
  # its progress file has gone stale for longer than STALL_SECONDS — a mid-run hang. A finished
  # extract writes done:true to its progress file, so a completed run keeps polling healthy
  # (rc=0) until claude itself exits and this loop's `kill -0` check ends it.
  (
    sleep "$HEARTBEAT_SECONDS"          # grace window for doctor+reconcile before the first check
    while kill -0 "$claude_pid" 2>/dev/null; do
      node "$ROOT/scripts/ops/check_extract_started.js" "$profile" "$run_start_epoch" "$STALL_SECONDS"
      rc=$?
      if [ "$rc" -ne 0 ]; then
        touch "$heartbeat_failed_flag"
        [ "$rc" -eq 2 ] && touch "$stalled_flag"
        kill -TERM -- "-$claude_pid" 2>/dev/null
        # extract's SIGTERM teardown kills Chrome itself (SIGTERM + up-to-5s grace + SIGKILL);
        # 5s here guillotined it mid-teardown and leaked Chrome outside the process group.
        sleep 20
        kill -KILL -- "-$claude_pid" 2>/dev/null
        break
      fi
      sleep 60
    done
  ) &
  heartbeat_watchdog_pid=$!

  wait "$claude_pid" 2>/dev/null
  ATTEMPT_EXIT_CODE=$?

  # Run finished (or was killed) — stop whichever watchdog didn't fire rather than leave it ticking.
  kill "$timeout_watchdog_pid" 2>/dev/null; wait "$timeout_watchdog_pid" 2>/dev/null
  kill "$heartbeat_watchdog_pid" 2>/dev/null; wait "$heartbeat_watchdog_pid" 2>/dev/null

  # Brief grace period for the tee process substitution to flush its last lines before anyone greps it.
  sleep 1

  if [ -f "$timed_out_flag" ]; then ATTEMPT_TIMED_OUT=1; else ATTEMPT_TIMED_OUT=0; fi
  if [ -f "$heartbeat_failed_flag" ]; then ATTEMPT_HEARTBEAT_FAILED=1; else ATTEMPT_HEARTBEAT_FAILED=0; fi
  if [ -f "$stalled_flag" ]; then ATTEMPT_STALLED=1; else ATTEMPT_STALLED=0; fi
  rm -f "$timed_out_flag" "$heartbeat_failed_flag" "$stalled_flag"

  ATTEMPT_RUN_START_EPOCH="$run_start_epoch"
}

# Turns the ATTEMPT_* globals from the most recent run_attempt call into STATUS/REASON/MESSAGE.
# REASON drives both the retry decision and which notify title to use below.
determine_status() {
  local profile="$1" log_file="$2"

  if [ "${ATTEMPT_STALLED:-0}" -eq 1 ]; then
    STATUS="FAILED"
    REASON="stalled"
    MESSAGE="Job Bunny run for $profile: /extract started but its progress file went stale for >${STALL_SECONDS}s — killed. It can be resumed: rerunning the same day skips already-completed search URLs. Check log: $log_file"
  elif [ "$ATTEMPT_HEARTBEAT_FAILED" -eq 1 ]; then
    STATUS="FAILED"
    REASON="heartbeat"
    MESSAGE="Job Bunny run for $profile: /extract never started within ${HEARTBEAT_SECONDS}s (likely backgrounded against run.md's no-backgrounding rule) — killed. Check log: $log_file"
  elif [ "$ATTEMPT_TIMED_OUT" -eq 1 ]; then
    STATUS="FAILED"
    REASON="timeout"
    MESSAGE="Job Bunny run TIMED OUT after ${TIMEOUT_SECONDS}s for $profile (killed) — check log: $log_file"
  # PASS/FAIL otherwise comes from profiles/<profile>/data/last_run_result.json (written
  # explicitly by the /run orchestration via mark_run_result.js — see run.md), NOT from
  # grepping the log for a literal "## Run Summary" heading. That grep depended on a fresh
  # headless agent's exact text-template compliance, which isn't guaranteed run to run — a
  # genuinely successful run that printed a slightly different completion sentence would be
  # misreported as FAILED (and fire a false "run failed" alert) purely because the wording
  # didn't match. check_run_result.js is deterministic: a mechanical script call, not freeform
  # prose, plus a staleness check against run_start_epoch so a crash before ever reaching the
  # marker doesn't reuse an old "success" from a prior day.
  elif [ "$ATTEMPT_EXIT_CODE" -eq 0 ] && node "$ROOT/scripts/ops/check_run_result.js" "$profile" "$ATTEMPT_RUN_START_EPOCH"; then
    STATUS="PASSED"
    REASON="passed"
    MESSAGE="Job Bunny run completed successfully for $profile. Log: $log_file"
  else
    STATUS="FAILED"
    # A transient API-side disconnect (e.g. "API Error: Connection closed mid-response") isn't
    # a real pipeline problem — it's worth one immediate retry rather than losing the whole
    # day's run for this profile over it. Anchored to "^API Error:" — the claude CLI's own
    # error-line prefix — rather than a bare content grep, so a scraped job posting whose
    # description happens to mention "network error" or "connection closed" can't be
    # misread as a transient API disconnect. Anything else falls through as a normal failure.
    if grep -qiE "^API Error:.*(connection closed|econnreset|network error)" "$log_file" 2>/dev/null; then
      REASON="transient_api"
    else
      REASON="other"
    fi
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

  # One immediate retry, same slot, in two cases:
  #   - heartbeat: by definition /extract's start marker never appeared, so nothing was
  #     scraped — always safe to retry, including the case that caused this fix (a healthy
  #     run whose /doctor+/reconcile just ran long and tripped the heartbeat early).
  #   - transient_api: only retried if /extract also hadn't started yet in the failed
  #     attempt (checked against that attempt's own start time) — a transient disconnect
  #     surfacing after /extract already ran is NOT retried here, to avoid doubling that
  #     slot's LinkedIn scrape traffic over a blip late in the pipeline.
  # A stall (REASON="stalled") is deliberately NOT retried, even though it also touches
  # heartbeat_failed_flag internally (see the watchdog loop above — rc=2 sets both flags):
  # scraping had already begun, so an immediate retry would double that slot's LinkedIn
  # traffic rather than avoid it, and per-URL resume (extract_resume.json) means nothing is
  # lost by waiting for the next scheduled slot or a manual rerun instead — the resumed run
  # skips every search URL /extract had already finished before it stalled.
  # determine_status() checks ATTEMPT_STALLED before ATTEMPT_HEARTBEAT_FAILED, so REASON is
  # only ever "heartbeat" when ATTEMPT_STALLED is NOT 1 for that same attempt — but the
  # ATTEMPT_STALLED guard below is kept anyway as a second, independent line of defense
  # against a stall ever being misclassified as a plain heartbeat retry.
  # Never retries a timeout/genuine-failure outcome, and never retries more than once.
  retry=0
  if [ "$STATUS" = "FAILED" ] && [ "$REASON" = "heartbeat" ] && [ "${ATTEMPT_STALLED:-0}" -ne 1 ]; then
    retry=1
  elif [ "$STATUS" = "FAILED" ] && [ "$REASON" = "transient_api" ] \
    && ! node "$ROOT/scripts/ops/check_extract_started.js" "$profile" "$ATTEMPT_RUN_START_EPOCH"; then
    retry=1
  fi

  if [ "$retry" -eq 1 ]; then
    echo "[run_scheduled.sh] $profile failed ($REASON, extract hadn't started) — retrying once" >&2
    retry_log_file="$ROOT/profiles/$profile/data/logs/run_$(date +%Y%m%d_%H%M%S)_retry.log"
    run_attempt "$profile" "$retry_log_file"
    log_file="$retry_log_file"
    determine_status "$profile" "$log_file"
  fi

  # Fire macOS notification.
  osascript -e "display notification \"$MESSAGE\" with title \"Job Bunny $STATUS\""

  # Forward the same digest to Telegram (best-effort — notify.js never throws/exits non-zero).
  # On success, the body is the log's "## Run Summary" block onward; on failure, a plain message.
  # Title/profile no longer repeat "Job Bunny .. — $profile" — the Telegram formatter's own
  # banner already carries both, per telegram_format.js. No --title on success either: the
  # Run Summary body already opens with its own bold heading, so a separate "Run complete"
  # title was just a redundant second headline stacked right above it.
  if [ "$STATUS" = "PASSED" ]; then
    notify_body=$(sed -n '/## Run Summary/,$p' "$log_file")
    if [ -z "$notify_body" ]; then
      notify_body="$MESSAGE"
    fi
    JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/notify/notify.js" --severity success --body "$notify_body"
  elif [ "$REASON" = "timeout" ]; then
    JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/notify/notify.js" --severity blocking --title "Run timed out" --body "$MESSAGE"
  elif [ "$REASON" = "stalled" ]; then
    JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/notify/notify.js" --severity blocking --title "Extract stalled mid-run" --body "$MESSAGE"
  elif [ "$REASON" = "heartbeat" ]; then
    JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/notify/notify.js" --severity blocking --title "Extract did not start" --body "$MESSAGE"
  else
    JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/notify/notify.js" --severity blocking --title "Run failed" --body "$MESSAGE"
  fi

  echo "[run_scheduled.sh] Finished profile: $profile (status: $STATUS)" >&2
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
