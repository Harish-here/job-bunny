#!/bin/sh
# Stub standing in for the real `claude` CLI: consumes stdin, writes an
# error message to stderr, and exits non-zero. Used to assert complete()
# rejects with the stderr text in its error message.
cat >/dev/null
echo "boom: something broke" >&2
exit 1
