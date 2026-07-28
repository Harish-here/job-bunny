import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeCliProvider } from './provider.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const HANG = `${FIXTURES}hang.sh`;
const CLOSE_STDIN = `${FIXTURES}close-stdin.sh`;
const IGNORE_SIGTERM = `${FIXTURES}ignore-sigterm.sh`;

// ECHO_STDIN/PRINT_ARGS/FAIL used to be `#!/bin/sh` fixture scripts like the
// three above, but windows-latest can't spawn a shell script directly
// (`spawn EFTYPE`). These three are the only tests that assert on the
// resolved VALUE (stdout content / argv shape / a specific stderr message),
// so a wrong-reason pass isn't available to them the way it is for the
// reject-only tests below — they need a fixture "binary" that actually runs
// cross-platform. `process.execPath` is always a real, spawnable executable
// on every OS, so each points `command` there and drives an inline `-e`
// script via `argsPrefix` (see `ClaudeCliProviderOptions.argsPrefix`) — still
// a real child process, proving the same stdout-capture / stdin-piping /
// argv-shape / stderr-on-nonzero behavior the original shell scripts did.
function nodeFixture(script: string): { command: string; argsPrefix: string[] } {
  return { command: process.execPath, argsPrefix: ['-e', script, '--'] };
}

// Mirrors echo-stdin.sh: `cat` — echo stdin back to stdout, exit 0.
const ECHO_STDIN = nodeFixture('process.stdin.pipe(process.stdout);');

// Mirrors print-args.sh: `echo "$@"; cat >/dev/null; exit 0` — print the
// argv received (everything after the `--`, via `process.argv.slice(1)`),
// then drain and discard stdin.
const PRINT_ARGS = nodeFixture(
  "process.stdout.write(process.argv.slice(1).join(' ') + '\\n'); " +
    "process.stdin.resume(); process.stdin.on('data', () => {}); " +
    "process.stdin.on('end', () => process.exit(0));",
);

// Mirrors fail.sh: drain stdin, write to stderr, exit 1.
const FAIL = nodeFixture(
  "process.stdin.resume(); process.stdin.on('data', () => {}); " +
    "process.stdin.on('end', () => { process.stderr.write('boom: something broke\\n'); " +
    'process.exitCode = 1; });',
);

test('name is exactly "claude-cli"', () => {
  const provider = new ClaudeCliProvider();
  assert.equal(provider.name, 'claude-cli');
});

test('constructor defaults: command "claude", timeoutMs 300_000', () => {
  // No public getters on the port — this just asserts construction with no
  // args doesn't throw, and behavior is exercised via complete() below with
  // explicit overrides (real defaults would spawn the real `claude` binary).
  assert.doesNotThrow(() => new ClaudeCliProvider());
});

test('happy path: resolves with the child process stdout', async () => {
  const provider = new ClaudeCliProvider({ ...ECHO_STDIN, timeoutMs: 5_000 });
  const result = await provider.complete('Say OK', {
    signal: new AbortController().signal,
  });
  assert.equal(result, 'Say OK');
});

test('spawns `claude -p --output-format text --bare` with the prompt via stdin, not argv', async () => {
  const provider = new ClaudeCliProvider({ ...PRINT_ARGS, timeoutMs: 5_000 });
  const result = await provider.complete('irrelevant prompt text', {
    signal: new AbortController().signal,
  });
  assert.equal(result.trim(), '-p --output-format text --bare');
});

test('non-zero exit rejects with stderr text in the error message', async () => {
  const provider = new ClaudeCliProvider({ ...FAIL, timeoutMs: 5_000 });
  await assert.rejects(
    () => provider.complete('Say OK', { signal: new AbortController().signal }),
    /boom: something broke/,
  );
});

test('abort via signal kills the child and rejects', async () => {
  const provider = new ClaudeCliProvider({ command: HANG, timeoutMs: 10_000 });
  const controller = new AbortController();
  const start = Date.now();
  const pending = provider.complete('Say OK', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test abort')), 50);

  await assert.rejects(() => pending);
  const elapsedMs = Date.now() - start;
  // hang.sh sleeps 30s; a real kill on abort resolves far sooner than that.
  assert.ok(elapsedMs < 5_000, `expected quick rejection, took ${elapsedMs}ms`);
});

test('already-aborted signal rejects without spawning', async () => {
  const provider = new ClaudeCliProvider({ command: HANG, timeoutMs: 10_000 });
  const controller = new AbortController();
  controller.abort(new Error('already gone'));
  const start = Date.now();
  await assert.rejects(() => provider.complete('Say OK', { signal: controller.signal }));
  const elapsedMs = Date.now() - start;
  // No child should ever be spawned for an already-aborted signal — this
  // should reject near-instantly, not wait on hang.sh's 30s sleep. Bounds a
  // regression that drops the early `if (signal.aborted)` guard.
  assert.ok(elapsedMs < 1_000, `expected near-instant rejection, took ${elapsedMs}ms`);
});

test('stdin write failure (EPIPE) rejects complete() instead of crashing the process', async () => {
  const provider = new ClaudeCliProvider({ command: CLOSE_STDIN, timeoutMs: 5_000 });
  // close-stdin.sh exits immediately without reading stdin. A prompt bigger
  // than the OS pipe buffer (64KB) forces the write to span more than one
  // internal flush, so it reliably lands after the child has already closed
  // its read end — reproducing EPIPE instead of racing a still-open fd.
  const bigPrompt = 'x'.repeat(10 * 1024 * 1024);
  await assert.rejects(() =>
    provider.complete(bigPrompt, { signal: new AbortController().signal }),
  );
});

test('abort escalates to SIGKILL when the child ignores SIGTERM, and complete() still settles', async () => {
  // Short killGraceMs so the test doesn't wait out the real default —
  // proves the escalation path fires without needing a long sleep.
  const provider = new ClaudeCliProvider({
    command: IGNORE_SIGTERM,
    timeoutMs: 10_000,
    killGraceMs: 200,
  });
  const controller = new AbortController();
  const start = Date.now();
  const pending = provider.complete('Say OK', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test abort')), 50);

  await assert.rejects(() => pending);
  const elapsedMs = Date.now() - start;
  // ignore-sigterm.sh traps SIGTERM and sleeps 30s; without SIGKILL
  // escalation this would hang for the full 30s (or forever). A bounded
  // grace period followed by SIGKILL should settle well under that.
  assert.ok(
    elapsedMs < 5_000,
    `expected SIGKILL-escalated rejection, took ${elapsedMs}ms`,
  );
});

test('ctor timeoutMs enforces a deadline independent of the passed signal', async () => {
  const provider = new ClaudeCliProvider({ command: HANG, timeoutMs: 100 });
  const start = Date.now();
  await assert.rejects(() =>
    provider.complete('Say OK', { signal: new AbortController().signal }),
  );
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 5_000, `expected timeout-driven rejection, took ${elapsedMs}ms`);
});
