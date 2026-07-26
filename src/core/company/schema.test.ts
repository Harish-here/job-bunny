import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanyRecordSchema, ProbeStateSchema, RegistrySchema } from './schema.ts';

test('ProbeStateSchema: minimal unprobed state parses with failCount default 0', () => {
  const state = ProbeStateSchema.parse({ status: 'unprobed' });
  assert.equal(state.failCount, 0);
  assert.equal(state.boardRef, undefined);
  assert.equal(state.probedAt, undefined);
});

test('ProbeStateSchema: found state carries boardRef + probedAt', () => {
  const state = ProbeStateSchema.parse({
    status: 'found',
    boardRef: 'acme',
    probedAt: '2026-07-01T00:00:00.000Z',
    failCount: 0,
  });
  assert.equal(state.boardRef, 'acme');
});

test('ProbeStateSchema: rejects unknown status', () => {
  assert.throws(() => ProbeStateSchema.parse({ status: 'bogus' }));
});

test('ProbeStateSchema: rejects negative failCount', () => {
  assert.throws(() => ProbeStateSchema.parse({ status: 'error', failCount: -1 }));
});

test('CompanyRecordSchema: minimal record parses with defaults', () => {
  const rec = CompanyRecordSchema.parse({
    name: 'Acme Corp',
    normalizedKey: 'acme-corp',
    firstSeen: '2026-07-01T00:00:00.000Z',
    lastSeen: '2026-07-01T00:00:00.000Z',
    seenBy: ['linkedin'],
  });
  assert.deepEqual(rec.probes, {});
  assert.equal(rec.curated, false);
});

test('CompanyRecordSchema: probes map keyed by api lane name', () => {
  const rec = CompanyRecordSchema.parse({
    name: 'Acme Corp',
    normalizedKey: 'acme-corp',
    firstSeen: '2026-07-01T00:00:00.000Z',
    lastSeen: '2026-07-01T00:00:00.000Z',
    seenBy: ['linkedin'],
    probes: { greenhouse: { status: 'found', boardRef: 'acme' } },
    curated: true,
  });
  assert.equal(rec.probes.greenhouse?.status, 'found');
  assert.equal(rec.curated, true);
});

test('CompanyRecordSchema: rejects empty name/normalizedKey', () => {
  assert.throws(() =>
    CompanyRecordSchema.parse({
      name: '',
      normalizedKey: 'x',
      firstSeen: '2026-07-01T00:00:00.000Z',
      lastSeen: '2026-07-01T00:00:00.000Z',
      seenBy: [],
    }),
  );
});

test('CompanyRecordSchema: rejects non-datetime firstSeen/lastSeen', () => {
  assert.throws(() =>
    CompanyRecordSchema.parse({
      name: 'Acme',
      normalizedKey: 'acme',
      firstSeen: '2026-07-01',
      lastSeen: '2026-07-01T00:00:00.000Z',
      seenBy: [],
    }),
  );
});

test('RegistrySchema: array of records, empty array valid', () => {
  assert.deepEqual(RegistrySchema.parse([]), []);
});
