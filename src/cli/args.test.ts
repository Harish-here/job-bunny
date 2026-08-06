/**
 * args.test.ts (Task 12) — colocated coverage for `buildOptions`'s new
 * `'runs'` case (`jobbunny runs` / `jobbunny runs show <id>`). No
 * pre-existing colocated test covered `buildOptions` before this task
 * (every other command's argv → options translation is exercised only
 * indirectly through `main.test.ts`'s end-to-end dispatch); this file adds
 * direct unit coverage for the new case only, rather than retrofitting the
 * whole module.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOptions, COMMAND_NAMES, USAGE } from './args.ts';

const NO_VALUES = {};

test('runs: registered in COMMAND_NAMES and mentioned in USAGE', () => {
  assert.ok(COMMAND_NAMES.has('runs'));
  assert.ok(USAGE.includes('runs'));
});

test('runs: bare invocation without --profile errors', () => {
  const result = buildOptions('runs', [], NO_VALUES);
  assert.deepEqual(result, { error: 'missing required --profile' });
});

test('runs: bare invocation with --profile lists (no runId)', () => {
  const result = buildOptions('runs', [], { profile: 'rajni' });
  assert.deepEqual(result, { profile: 'rajni' });
});

test('runs show: missing run id errors', () => {
  const result = buildOptions('runs', ['show'], { profile: 'rajni' });
  assert.deepEqual(result, { error: 'runs show: missing run id' });
});

test('runs show: non-numeric run id errors', () => {
  const result = buildOptions('runs', ['show', 'abc'], { profile: 'rajni' });
  assert.deepEqual(result, {
    error: 'runs show: run id must be a positive integer, got "abc"',
  });
});

test('runs show: zero/negative run id errors', () => {
  assert.deepEqual(buildOptions('runs', ['show', '0'], { profile: 'rajni' }), {
    error: 'runs show: run id must be a positive integer, got "0"',
  });
  assert.deepEqual(buildOptions('runs', ['show', '-3'], { profile: 'rajni' }), {
    error: 'runs show: run id must be a positive integer, got "-3"',
  });
});

test('runs show: missing --profile errors even with a valid id', () => {
  const result = buildOptions('runs', ['show', '7'], NO_VALUES);
  assert.deepEqual(result, { error: 'missing required --profile' });
});

test('runs show: valid id + profile returns { profile, runId }', () => {
  const result = buildOptions('runs', ['show', '7'], { profile: 'rajni' });
  assert.deepEqual(result, { profile: 'rajni', runId: 7 });
});

test('runs: unknown sub-action errors', () => {
  const result = buildOptions('runs', ['bogus'], { profile: 'rajni' });
  assert.deepEqual(result, {
    error: 'runs takes no sub-action, or "show <id>"',
  });
});

test('state: bare invocation with no sub-action errors', () => {
  const result = buildOptions('state', [], { profile: 'rajni' });
  assert.deepEqual(result, { error: 'state takes "read" or "write"' });
});

test('state read: unknown key errors, naming the valid keys', () => {
  const result = buildOptions('state', ['read', 'badkey'], { profile: 'rajni' });
  assert.deepEqual(result, {
    error:
      'state read: key must be one of table, decisions, decisions-partial ' +
      '(this is not a general DB tool)',
  });
});

test('state write table: rejected at the buildOptions layer, before state.ts is reached', () => {
  const result = buildOptions('state', ['write', 'table'], { profile: 'rajni' });
  assert.deepEqual(result, {
    error:
      'state write: key must be one of decisions, decisions-partial ' +
      '(this is not a general DB tool)',
  });
});

test('state read table --profile p: parses to { profile, action, key }', () => {
  const result = buildOptions('state', ['read', 'table'], { profile: 'p' });
  assert.deepEqual(result, { profile: 'p', action: 'read', key: 'table' });
});

test('state: missing --profile errors even with a valid read key', () => {
  const result = buildOptions('state', ['read', 'table'], {});
  assert.deepEqual(result, { error: 'missing required --profile' });
});
