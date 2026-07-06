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

# Loop over profiles strictly sequentially.
for profile in "$@"; do
  # Ensure the logs directory exists.
  mkdir -p "$ROOT/profiles/$profile/data/logs"

  # Run the /run stage sequence, capture both stdout and stderr, and tee to a timestamped log file.
  timestamp=$(date +%Y%m%d_%H%M%S)
  log_file="$ROOT/profiles/$profile/data/logs/run_${timestamp}.log"

  echo "[run_scheduled.sh] Starting profile: $profile" >&2

  # Run claude and tee output to both stdout and the log file.
  # Use ${PIPESTATUS[0]} to capture the exit code of the claude command (before the pipe).
  claude -p "/run $profile" --dangerously-skip-permissions 2>&1 | tee "$log_file"
  exit_code=${PIPESTATUS[0]}

  # Check for success marker in the log file, and that claude itself exited cleanly.
  if [ "$exit_code" -eq 0 ] && grep -q "## Run Summary" "$log_file"; then
    status="PASSED"
    message="Job Bunny run completed successfully for $profile. Log: $log_file"
  else
    status="FAILED"
    message="Job Bunny run failed for $profile. Check log: $log_file"
  fi

  # Fire macOS notification.
  osascript -e "display notification \"$message\" with title \"Job Bunny $status\""

  echo "[run_scheduled.sh] Finished profile: $profile (status: $status)" >&2
done
