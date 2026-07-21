import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boardsToFetch,
  probeCandidates,
  recordFetchFailure,
  recordProbe,
  upsertSeen,
} from './registry.ts';
import type { CompanyRecord, RegistryPolicy } from './schema.ts';

const NOW = '2026-07-21T00:00:00.000Z';
const POLICY: RegistryPolicy = {
  reprobeNotFoundAfterDays: 30,
  maxProbeFailures: 3,
  staleAfterFetchFailures: 3,
};

function makeRecord(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    name: 'Acme Corp',
    normalizedKey: 'acme-corp',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z',
    seenBy: ['linkedin'],
    probes: {},
    curated: false,
    ...overrides,
  };
}

// ---- upsertSeen ----

test('upsertSeen: creates a new record via companyKey, unprobed for every lane (empty probes)', () => {
  const out = upsertSeen([], ['Acme Corp Pvt Ltd'], 'linkedin', NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.normalizedKey, 'acme-corp');
  assert.equal(out[0]?.name, 'Acme Corp Pvt Ltd');
  assert.equal(out[0]?.firstSeen, NOW);
  assert.equal(out[0]?.lastSeen, NOW);
  assert.deepEqual(out[0]?.seenBy, ['linkedin']);
  assert.deepEqual(out[0]?.probes, {});
});

test('upsertSeen: existing company bumps lastSeen but never firstSeen', () => {
  const reg = [makeRecord()];
  const out = upsertSeen(reg, ['Acme Corp'], 'greenhouse', NOW);
  assert.equal(out[0]?.firstSeen, '2026-01-01T00:00:00.000Z');
  assert.equal(out[0]?.lastSeen, NOW);
});

test('upsertSeen: dedups seenBy — re-adding the same lane does not duplicate', () => {
  const reg = [makeRecord({ seenBy: ['linkedin'] })];
  const out = upsertSeen(reg, ['Acme Corp'], 'linkedin', NOW);
  assert.deepEqual(out[0]?.seenBy, ['linkedin']);
});

test('upsertSeen: adds a new lane to seenBy alongside existing ones', () => {
  const reg = [makeRecord({ seenBy: ['linkedin'] })];
  const out = upsertSeen(reg, ['Acme Corp'], 'greenhouse', NOW);
  assert.deepEqual(out[0]?.seenBy, ['linkedin', 'greenhouse']);
});

test('upsertSeen: merges names that map to the same key within one call', () => {
  const out = upsertSeen([], ['Acme Corp', 'Acme Corp Inc'], 'linkedin', NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.name, 'Acme Corp'); // first name wins
});

test('upsertSeen: does not mutate input records or array', () => {
  const reg = [makeRecord()];
  const frozenSeenBy = reg[0]?.seenBy;
  const out = upsertSeen(reg, ['Acme Corp'], 'greenhouse', NOW);
  assert.deepEqual(reg[0]?.seenBy, ['linkedin']); // original untouched
  assert.notEqual(out, reg); // new array
  assert.notEqual(out[0]?.seenBy, frozenSeenBy);
});

// ---- probeCandidates ----

test('probeCandidates: a record with no probe entry for the lane is a candidate (unprobed)', () => {
  const reg = [makeRecord()];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 1);
});

test('probeCandidates: explicit status "unprobed" is a candidate', () => {
  const reg = [
    makeRecord({ probes: { greenhouse: { status: 'unprobed', failCount: 0 } } }),
  ];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 1);
});

test('probeCandidates: not-found probe older than TTL is a candidate (re-probe)', () => {
  const reg = [
    makeRecord({
      probes: {
        greenhouse: {
          status: 'not-found',
          probedAt: '2026-06-01T00:00:00.000Z', // 50 days before NOW
          failCount: 0,
        },
      },
    }),
  ];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 1);
});

test('probeCandidates: not-found probe inside TTL is NOT a candidate', () => {
  const reg = [
    makeRecord({
      probes: {
        greenhouse: {
          status: 'not-found',
          probedAt: '2026-07-10T00:00:00.000Z', // 11 days before NOW
          failCount: 0,
        },
      },
    }),
  ];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 0);
});

test('probeCandidates: not-found probe exactly at the TTL boundary is NOT yet a candidate (strict >)', () => {
  const reg = [
    makeRecord({
      probes: {
        greenhouse: {
          status: 'not-found',
          probedAt: '2026-06-21T00:00:00.000Z', // exactly 30 days before NOW
          failCount: 0,
        },
      },
    }),
  ];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 0);
});

test('probeCandidates: error under the failure cap is a candidate (retry)', () => {
  const reg = [makeRecord({ probes: { greenhouse: { status: 'error', failCount: 2 } } })];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 1);
});

test('probeCandidates: error at the failure cap is NOT a candidate', () => {
  const reg = [makeRecord({ probes: { greenhouse: { status: 'error', failCount: 3 } } })];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 0);
});

test('probeCandidates: found and stale probes are excluded', () => {
  const reg = [
    makeRecord({
      normalizedKey: 'found-co',
      probes: { greenhouse: { status: 'found', boardRef: 'x', failCount: 0 } },
    }),
    makeRecord({
      normalizedKey: 'stale-co',
      probes: { greenhouse: { status: 'stale', boardRef: 'y', failCount: 3 } },
    }),
  ];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 0);
});

test('probeCandidates: curated records are probe-eligible under the identical rules', () => {
  const reg = [makeRecord({ curated: true })];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 1);
});

test('probeCandidates: probes for a different lane do not affect candidacy', () => {
  const reg = [
    makeRecord({ probes: { keka: { status: 'found', boardRef: 'x', failCount: 0 } } }),
  ];
  const out = probeCandidates(reg, 'greenhouse', POLICY, NOW);
  assert.equal(out.length, 1); // greenhouse has no entry — still unprobed for greenhouse
});

// ---- recordProbe ----

test('recordProbe: "found" sets boardRef, probedAt, resets failCount to 0', () => {
  const reg = [makeRecord({ probes: { greenhouse: { status: 'error', failCount: 2 } } })];
  const out = recordProbe(
    reg,
    'acme-corp',
    'greenhouse',
    { status: 'found', boardRef: 'acme' },
    NOW,
  );
  assert.deepEqual(out[0]?.probes.greenhouse, {
    status: 'found',
    boardRef: 'acme',
    probedAt: NOW,
    failCount: 0,
  });
});

test('recordProbe: "not-found" sets probedAt, resets failCount to 0, no boardRef', () => {
  const reg = [makeRecord()];
  const out = recordProbe(reg, 'acme-corp', 'greenhouse', { status: 'not-found' }, NOW);
  assert.deepEqual(out[0]?.probes.greenhouse, {
    status: 'not-found',
    probedAt: NOW,
    failCount: 0,
  });
});

test('recordProbe: "error" increments the prior failCount', () => {
  const reg = [makeRecord({ probes: { greenhouse: { status: 'error', failCount: 1 } } })];
  const out = recordProbe(
    reg,
    'acme-corp',
    'greenhouse',
    { status: 'error', message: 'timeout' },
    NOW,
  );
  assert.equal(out[0]?.probes.greenhouse?.failCount, 2);
  assert.equal(out[0]?.probes.greenhouse?.status, 'error');
});

test('recordProbe: "error" from a fresh (no prior probe) record starts failCount at 1', () => {
  const reg = [makeRecord()];
  const out = recordProbe(
    reg,
    'acme-corp',
    'greenhouse',
    { status: 'error', message: 'timeout' },
    NOW,
  );
  assert.equal(out[0]?.probes.greenhouse?.failCount, 1);
});

test('recordProbe: unknown key returns the registry unchanged (same reference)', () => {
  const reg = [makeRecord()];
  const out = recordProbe(reg, 'nonexistent', 'greenhouse', { status: 'not-found' }, NOW);
  assert.equal(out, reg);
});

test('recordProbe: does not mutate the input record', () => {
  const reg = [makeRecord()];
  recordProbe(reg, 'acme-corp', 'greenhouse', { status: 'found', boardRef: 'acme' }, NOW);
  assert.deepEqual(reg[0]?.probes, {});
});

// ---- boardsToFetch ----

test('boardsToFetch: returns only found-with-boardRef entries, carrying curated flag', () => {
  const reg = [
    makeRecord({
      normalizedKey: 'found-co',
      curated: true,
      probes: { greenhouse: { status: 'found', boardRef: 'found-board', failCount: 0 } },
    }),
    makeRecord({
      normalizedKey: 'unprobed-co',
      probes: {},
    }),
    makeRecord({
      normalizedKey: 'stale-co',
      probes: { greenhouse: { status: 'stale', boardRef: 'stale-board', failCount: 3 } },
    }),
    makeRecord({
      normalizedKey: 'not-found-co',
      probes: { greenhouse: { status: 'not-found', failCount: 0 } },
    }),
  ];
  const out = boardsToFetch(reg, 'greenhouse');
  assert.deepEqual(out, [{ key: 'found-co', boardRef: 'found-board', curated: true }]);
});

// ---- recordFetchFailure ----

test('recordFetchFailure: non-curated record becomes stale once failCount hits the threshold', () => {
  const reg = [
    makeRecord({
      probes: { greenhouse: { status: 'found', boardRef: 'x', failCount: 2 } },
    }),
  ];
  const out = recordFetchFailure(reg, 'acme-corp', 'greenhouse', POLICY);
  assert.deepEqual(out[0]?.probes.greenhouse, {
    status: 'stale',
    boardRef: 'x',
    failCount: 3,
  });
});

test('recordFetchFailure: non-curated record below threshold stays "found", failCount increments', () => {
  const reg = [
    makeRecord({
      probes: { greenhouse: { status: 'found', boardRef: 'x', failCount: 0 } },
    }),
  ];
  const out = recordFetchFailure(reg, 'acme-corp', 'greenhouse', POLICY);
  assert.deepEqual(out[0]?.probes.greenhouse, {
    status: 'found',
    boardRef: 'x',
    failCount: 1,
  });
});

test('recordFetchFailure: curated record never goes stale, even far past the threshold (flag-only)', () => {
  const reg = [
    makeRecord({
      curated: true,
      probes: { greenhouse: { status: 'found', boardRef: 'x', failCount: 10 } },
    }),
  ];
  const out = recordFetchFailure(reg, 'acme-corp', 'greenhouse', POLICY);
  assert.deepEqual(out[0]?.probes.greenhouse, {
    status: 'found',
    boardRef: 'x',
    failCount: 11,
  });
});

test('recordFetchFailure: no-op when there is no probe state for that lane', () => {
  const reg = [makeRecord()];
  const out = recordFetchFailure(reg, 'acme-corp', 'greenhouse', POLICY);
  assert.deepEqual(out[0]?.probes, {});
});
