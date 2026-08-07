/**
 * guard.test.ts (P8 data-home) — TDD for `nodeGuardMessage`: a pure,
 * zero-I/O check on `process.versions.node` (or an injected string in
 * tests), so old-Node consumers get one readable line instead of a stack
 * trace.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeGuardMessage } from './guard.ts';

test('nodeGuardMessage: returns undefined on Node 24', () => {
  assert.equal(nodeGuardMessage('24.0.0'), undefined);
});

test('nodeGuardMessage: returns undefined on a newer major', () => {
  assert.equal(nodeGuardMessage('25.3.1'), undefined);
});

test('nodeGuardMessage: names the found version on an older major', () => {
  assert.equal(nodeGuardMessage('22.18.0'), 'jobbunny needs Node >= 24 (found 22.18.0)');
});

test('nodeGuardMessage: an unparseable version does not block', () => {
  // A runtime whose version string can't be parsed is not evidence of an
  // old Node — blocking on it would be worse than letting the real
  // failure (whatever it is) speak for itself. Fail open, not closed.
  assert.equal(nodeGuardMessage('not-a-version'), undefined);
});
