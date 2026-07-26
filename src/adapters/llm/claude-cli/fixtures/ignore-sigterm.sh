#!/bin/sh
# Stub standing in for the real `claude` CLI: traps and ignores SIGTERM, then
# sleeps well past any reasonable grace period. Uses `exec` (see hang.sh) so
# the trap applies to the actual pid Node kills and sleep's stdio-holding
# doesn't outlive it as an un-exec'd child. Used to assert that on abort,
# after a bounded grace period, the provider escalates to SIGKILL so
# complete() still settles instead of hanging forever.
trap '' TERM
exec sleep 30
