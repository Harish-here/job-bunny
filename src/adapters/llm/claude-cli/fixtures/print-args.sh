#!/bin/sh
# Stub standing in for the real `claude` CLI: prints the argv it received
# (not stdin) so a test can assert ClaudeCliProvider invokes
# `claude -p --output-format text` with the prompt piped via stdin, not argv.
echo "$@"
cat >/dev/null
exit 0
