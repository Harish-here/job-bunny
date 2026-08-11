import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunEventRow } from '../../../ports/run_store.ts';
import { groupSoftErrors } from './soft_errors.ts';

function row(msg: string, data?: Record<string, unknown>): RunEventRow {
  return { ts: '2026-08-10T00:00:00.000Z', level: 'warn', msg, data };
}

test('groupSoftErrors: empty input', () => {
  const summary = groupSoftErrors([]);
  assert.deepEqual(summary, { total: 0, groups: [], breakerOpen: false });
});

test('groupSoftErrors: single group', () => {
  const events: RunEventRow[] = [
    row('linkedin lane: url failed', { scope: 'source.linkedin', lane: 'linkedin' }),
    row('linkedin lane: url failed', { scope: 'source.linkedin', lane: 'linkedin' }),
    row('linkedin lane: url failed', { scope: 'source.linkedin', lane: 'linkedin' }),
  ];
  const summary = groupSoftErrors(events);
  assert.equal(summary.total, 3);
  assert.equal(summary.groups.length, 1);
  const group = summary.groups[0];
  assert.ok(group);
  assert.equal(group.count, 3);
  assert.equal(group.key, 'source.linkedin·linkedin');
  assert.ok(events.some((e) => e.msg === group.sample));
});

test('groupSoftErrors: multi-group sort-by-count (real corpus shapes)', () => {
  const events: RunEventRow[] = [
    ...Array.from({ length: 44 }, () =>
      row('linkedin lane: page identity loss', { scope: 'farm.linkedin' }),
    ),
    ...Array.from({ length: 13 }, () =>
      row('linkedin lane: url failed', { scope: 'source.linkedin', lane: 'linkedin' }),
    ),
    ...Array.from({ length: 8 }, () =>
      row('board fetch failed', { scope: 'source', company: 'acme corp' }),
    ),
    ...Array.from({ length: 6 }, () =>
      row('harvest: harvested 0 cards', { scope: 'farm' }),
    ),
    ...Array.from({ length: 3 }, () => row('stage attempt failed', { scope: 'source' })),
  ];
  const summary = groupSoftErrors(events);
  assert.equal(summary.total, 44 + 13 + 8 + 6 + 3);
  // 5 distinct keys: farm.linkedin, source.linkedin·linkedin, source·acme corp, farm, source
  assert.equal(summary.groups.length, 5);
  const counts = summary.groups.map((g) => g.count);
  const sorted = [...counts].sort((a, b) => b - a);
  assert.deepEqual(counts, sorted);
  assert.equal(summary.groups[0]?.count, 44);
  assert.equal(summary.groups[0]?.sample, 'linkedin lane: page identity loss');
  assert.equal(summary.groups[1]?.count, 13);
  assert.equal(summary.groups[4]?.count, 3);
});

test('groupSoftErrors: missing data field degrades to unknown bucket', () => {
  const events: RunEventRow[] = [row('mystery failure')];
  const summary = groupSoftErrors(events);
  assert.equal(summary.total, 1);
  assert.equal(summary.groups.length, 1);
  const group = summary.groups[0];
  assert.ok(group);
  assert.equal(group.key, 'unknown');
  assert.match(group.label, /unknown/i);
});

test('groupSoftErrors: data present but missing scope degrades to unknown bucket', () => {
  const events: RunEventRow[] = [
    row('weird event', { reopenAt: '2026-08-10T00:00:00.000Z', tripCount: 3 }),
  ];
  assert.doesNotThrow(() => groupSoftErrors(events));
  const summary = groupSoftErrors(events);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0]?.key, 'unknown');
});

test('groupSoftErrors: no breaker warn present -> breakerOpen is false', () => {
  const events: RunEventRow[] = [
    row('linkedin lane: page identity loss', { scope: 'farm' }),
    row('harvest: harvested 0 cards', { scope: 'farm' }),
  ];
  const summary = groupSoftErrors(events);
  assert.equal(summary.breakerOpen, false);
});

// Real event order (pipeline/runner/run.ts's withScope(logger, stage.name) —
// every farm-stage warn, including the breaker-open warn itself, carries
// `data.scope === 'farm'`, never a dedicated 'linkedin' scope): several
// unrelated farm warns land in `run_events` BEFORE the breaker-open warn.
// `groupSoftErrors`'s bucketing keys all of them into the SAME 'farm'
// group (no company/lane in `data`), and a group's `sample` is the FIRST
// event's msg — so a `group.sample`-substring detector (the old,
// fix-round-finding-#3-broken approach) would miss the breaker warn
// entirely here. `breakerOpen` must still fire because it scans every raw
// event's `msg`, never a group's single `sample`.
test('groupSoftErrors: breakerOpen fires even when the breaker warn is bucketed under the SAME scope key as unrelated warns and is not the group sample (real ScopedLogger order)', () => {
  const events: RunEventRow[] = [
    row('linkedin lane: page identity loss', { scope: 'farm' }),
    row('linkedin lane: page identity loss', { scope: 'farm' }),
    row(
      'linkedin lane: throttle breaker is open — skipping this fire without launching a browser',
      { scope: 'farm', reopenAt: '2026-08-10T10:00:00.000Z', tripCount: 1 },
    ),
  ];
  const summary = groupSoftErrors(events);
  // Bucketing precondition this test depends on: all 3 events land in one
  // 'farm' group, whose sample is the FIRST event's msg — NOT the breaker
  // warn's text.
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0]?.sample, 'linkedin lane: page identity loss');
  assert.equal(summary.breakerOpen, true);
});

test('groupSoftErrors: breakerOpen also detects the trip and probe-re-open breaker messages, not just the open-skip one', () => {
  const trip = groupSoftErrors([
    row(
      'linkedin lane: 3 consecutive server-withheld JD shells — the session is throttled; opening the breaker and stopping this fire, keeping every capture so far',
      { scope: 'farm' },
    ),
  ]);
  assert.equal(trip.breakerOpen, true);

  const reopen = groupSoftErrors([
    row(
      'linkedin lane: half-open probe still got a server-withheld shell — breaker re-opened, ending this fire',
      { scope: 'farm' },
    ),
  ]);
  assert.equal(reopen.breakerOpen, true);
});
