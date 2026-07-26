#!/bin/sh
# Stub standing in for the real `claude` CLI: never exits on its own. Uses
# `exec` so `sleep` replaces this shell process (same pid) instead of
# running as an un-exec'd child — otherwise killing the shell would leave
# an orphaned `sleep` holding the stdio pipes open, and Node's 'close'
# event (which waits for stdio to actually close) would hang until the
# full sleep elapsed even though the process was killed. Used to assert
# complete() kills the child and rejects on abort, well before this sleep
# would otherwise return.
exec sleep 30
