/**
 * run_failure_notice.test.ts — pure-function coverage for
 * `normalizeFailureText`/`extractFailureError`/`prettySignature`.
 * End-to-end proof that the normalization actually reaches `run.ts`'s own
 * notify call site (direction 1 / direction 2 of blueprint-be.md step
 * 1.16) lives in `run.test.ts` via `runCommand` itself, per the brief's
 * own "proven end-to-end through run.ts's own notify call site, not just
 * at the pure-function level" requirement.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractFailureError,
  normalizeFailureText,
  prettySignature,
} from './run_failure_notice.ts';

test('normalizeFailureText: collapses digit runs so two elapsed-ms occurrences of the same cause match', () => {
  const a = normalizeFailureText('stalled: no beat() within 360000ms');
  const b = normalizeFailureText('stalled: no beat() within 420000ms');
  assert.equal(a, 'stalled: no beat() within <N>ms');
  assert.equal(a, b);
});

test('normalizeFailureText: a URL query string is stripped but a different path still differs', () => {
  const withQuery = normalizeFailureText(
    'GET https://api.greenhouse.io/v1/boards/x?page=2&ts=169000 failed',
  );
  const sameQueryDifferentTimestamp = normalizeFailureText(
    'GET https://api.greenhouse.io/v1/boards/x?page=2&ts=555000 failed',
  );
  assert.equal(withQuery, sameQueryDifferentTimestamp);
  // Digit-run collapse (step 2) applies to the WHOLE string, including the
  // URL's own already-reduced origin+pathname — "v1" in the path becomes
  // "v<N>" too, per the exact two-step order in blueprint-be.md step 1.16.
  assert.equal(withQuery, 'GET https://api.greenhouse.io/v<N>/boards/x failed');

  const differentPath = normalizeFailureText(
    'GET https://api.greenhouse.io/v1/boards/y?page=2&ts=169000 failed',
  );
  assert.notEqual(withQuery, differentPath);
});

test('normalizeFailureText: a genuinely different error template stays different (no over-normalization)', () => {
  assert.notEqual(
    normalizeFailureText('stalled: no beat() within 360000ms'),
    normalizeFailureText('HTTP 429 from greenhouse'),
  );
});

test('normalizeFailureText: an unparseable "URL-shaped" substring is left untouched, never throws', () => {
  assert.equal(normalizeFailureText('https://[bad'), 'https://[bad');
});

test('extractFailureError: reads back a well-formed RunFailure-shaped blob', () => {
  assert.equal(
    extractFailureError({ stage: 'farm', error: 'boom', elapsedMs: 5 }),
    'boom',
  );
});

test('extractFailureError: falls back to a stable placeholder for null/non-object/missing-field shapes, never throws', () => {
  assert.equal(extractFailureError(null), 'unknown error');
  assert.equal(extractFailureError(undefined), 'unknown error');
  assert.equal(extractFailureError('a string'), 'unknown error');
  assert.equal(extractFailureError({ stage: 'farm' }), 'unknown error');
  assert.equal(extractFailureError({ error: 42 }), 'unknown error');
});

test('prettySignature: splits the stage::error join back into "stage \\"X\\" — error" display text', () => {
  assert.equal(
    prettySignature('farm::stalled: no beat() within <N>ms'),
    'stage "farm" — stalled: no beat() within <N>ms',
  );
});

test('prettySignature: a signature with no separator falls back to a bare stage label', () => {
  assert.equal(prettySignature('farm'), 'stage "farm"');
});
