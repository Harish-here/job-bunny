import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { wireDaemonDeferredSlots } from './daemon_deferred.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-wire-daemon-deferred-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedProfileDir(name: string): Promise<string> {
  const dbDir = join(root, 'profiles', name, 'data');
  await mkdir(dbDir, { recursive: true });
  return join(dbDir, 'jobbunny.db');
}

test('wireDaemonDeferredSlots.recordDeferral: writes a row that listForDate for the SAME profile+date then returns', () => {
  const { recordDeferral, listForDate } = wireDaemonDeferredSlots({ root });
  recordDeferral('deferred-basic', {
    runDate: '2026-08-05',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'host was asleep at the scheduled slot',
    decidedAt: '2026-08-05T09:05:00.000Z',
  });
  assert.deepEqual(listForDate('deferred-basic', '2026-08-05'), [
    {
      runDate: '2026-08-05',
      slot: '09:00',
      reasonCode: 'host-asleep',
      reason: 'host was asleep at the scheduled slot',
      decidedAt: '2026-08-05T09:05:00.000Z',
      notifiedAt: null,
    },
  ]);
});

test('wireDaemonDeferredSlots.recordDeferral: called twice for the same (profile, runDate, slot) produces exactly one row, reachable through this wiring layer (not just the adapter layer)', () => {
  const { recordDeferral, listForDate } = wireDaemonDeferredSlots({ root });
  const entry = {
    runDate: '2026-08-06',
    slot: '10:00',
    reasonCode: 'network-unreachable' as const,
    reason: 'no network at the scheduled slot',
    decidedAt: '2026-08-06T10:05:00.000Z',
  };
  recordDeferral('deferred-idempotent', entry);
  recordDeferral('deferred-idempotent', entry);
  assert.equal(listForDate('deferred-idempotent', '2026-08-06').length, 1);
});

test('wireDaemonDeferredSlots: listUnnotifiedDatesBefore and markNotified round-trip through this wiring layer', () => {
  const { recordDeferral, listUnnotifiedDatesBefore, markNotified } =
    wireDaemonDeferredSlots({ root });
  recordDeferral('deferred-roundtrip', {
    runDate: '2026-08-04',
    slot: '08:00',
    reasonCode: 'daemon-unavailable',
    reason: 'daemon was down at the scheduled slot',
    decidedAt: '2026-08-04T08:05:00.000Z',
  });
  assert.deepEqual(listUnnotifiedDatesBefore('deferred-roundtrip', '2026-08-05'), [
    '2026-08-04',
  ]);
  markNotified('deferred-roundtrip', '2026-08-04', '2026-08-05T09:00:00.000Z');
  assert.deepEqual(listUnnotifiedDatesBefore('deferred-roundtrip', '2026-08-05'), []);
});

test('wireDaemonDeferredSlots: listForDate and listUnnotifiedDatesBefore create no db file for a profile that has never run', async () => {
  const dbPath = await seedProfileDir('deferred-noread-create');
  const { listForDate, listUnnotifiedDatesBefore } = wireDaemonDeferredSlots({ root });
  assert.deepEqual(listForDate('deferred-noread-create', '2026-08-05'), []);
  assert.equal(existsSync(dbPath), false, 'listForDate must never create the db file');
  assert.deepEqual(listUnnotifiedDatesBefore('deferred-noread-create', '2026-08-05'), []);
  assert.equal(
    existsSync(dbPath),
    false,
    'listUnnotifiedDatesBefore must never create the db file',
  );
});

test('wireDaemonDeferredSlots: a profile whose db file does not exist yet degrades reads to [] and never throws on a write', () => {
  const { recordDeferral, listForDate, listUnnotifiedDatesBefore, markNotified } =
    wireDaemonDeferredSlots({ root });
  assert.deepEqual(listForDate('deferred-ghost', '2026-08-05'), []);
  assert.deepEqual(listUnnotifiedDatesBefore('deferred-ghost', '2026-08-05'), []);
  assert.doesNotThrow(() =>
    recordDeferral('deferred-ghost', {
      runDate: '2026-08-05',
      slot: '09:00',
      reasonCode: 'host-asleep',
      reason: 'host was asleep at the scheduled slot',
      decidedAt: '2026-08-05T09:05:00.000Z',
    }),
  );
  assert.doesNotThrow(() =>
    markNotified('deferred-ghost', '2026-08-05', '2026-08-05T09:10:00.000Z'),
  );
});
