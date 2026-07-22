#!/bin/sh
# Stub standing in for the real `claude` CLI: exits immediately without
# reading stdin, closing the read end before the parent's (deliberately
# oversized, from the test) prompt write can fully flush. Reproduces EPIPE on
# the parent's child.stdin.write() so a test can assert complete() rejects
# instead of the unhandled stream 'error' event crashing the whole process.
exit 0
