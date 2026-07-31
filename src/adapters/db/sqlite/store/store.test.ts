import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD } from '../../../../core/jd/index.ts';
import { openJobsDb } from './migrations.ts';
import { SqliteStore } from './store.ts';

function makeJd(id: string, overrides: Partial<JD> = {}): JD {
  return {
    identity: {
      id,
      lane: 'linkedin',
      url: `https://www.linkedin.com/jobs/view/${id.replace('li-', '')}`,
      company: 'Acme Corp',
      title: 'Staff Frontend Engineer',
      scrapedAt: '2026-08-01T10:00:00.000Z',
    },
    ...overrides,
  };
}

function freshStore(): SqliteStore {
  return new SqliteStore(openJobsDb(':memory:'));
}

test('upsertJobs + listCacheEntries: round-trips a job; pageId is the job id', () => {
  const store = freshStore();
  const jd = makeJd('li-1', {
    structured: {
      titleParts: { seniority: 'Staff' },
      locations: [{ city: 'Chennai' }],
      skills: ['React', 'TypeScript'],
    },
  });
  store.upsertJobs([jd], '2026-08-01T11:00:00.000Z');

  assert.deepEqual(store.listCacheEntries(), [
    {
      id: 'li-1',
      company: 'Acme Corp',
      title: 'Staff Frontend Engineer',
      pageId: 'li-1',
      city: 'Chennai',
    },
  ]);
});

test('listCacheEntries: city key is absent (not undefined) when the job has no city', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-2')], '2026-08-01T11:00:00.000Z');

  const [entry] = store.listCacheEntries();
  assert.ok(
    entry && !('city' in entry),
    'city key must be absent, not present-as-undefined',
  );
});

test('upsertJobs: conflict on id updates automated columns and revives an archived row', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-3')], '2026-08-01T11:00:00.000Z');
  store.markArchived(['li-3'], '2026-08-01T12:00:00.000Z');
  assert.equal(store.listCacheEntries().length, 0);

  const updated = makeJd('li-3');
  updated.identity.title = 'Principal Frontend Engineer';
  store.upsertJobs([updated], '2026-08-02T09:00:00.000Z');

  const [entry] = store.listCacheEntries();
  assert.equal(entry?.title, 'Principal Frontend Engineer');
});

test('markArchived returns the count and hides rows from listCacheEntries', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-4'), makeJd('li-5')], '2026-08-01T11:00:00.000Z');

  assert.equal(store.markArchived(['li-4'], '2026-08-01T12:00:00.000Z'), 1);
  assert.deepEqual(
    store.listCacheEntries().map((e) => e.id),
    ['li-5'],
  );
});

test('listArchiveCandidates: joins tracking status, null when no tracking row', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-6'), makeJd('li-7')], '2026-08-01T11:00:00.000Z');
  store.db
    .prepare('INSERT INTO tracking (job_id, status, updated_at) VALUES (?, ?, ?)')
    .run('li-6', 'Passed', '2026-08-01T12:00:00.000Z');

  const candidates = store.listArchiveCandidates();
  assert.deepEqual(
    candidates.map((c) => ({ id: c.id, status: c.status })),
    [
      { id: 'li-6', status: 'Passed' },
      { id: 'li-7', status: null },
    ],
  );
  assert.equal(candidates[0]?.dateFound, '2026-08-01T10:00:00.000Z');
});

test('upsertJobs and markArchived work inside an outer transaction (savepoints, not BEGIN)', () => {
  const store = freshStore();
  store.db.exec('BEGIN');
  store.upsertJobs([makeJd('li-8')], '2026-08-01T11:00:00.000Z');
  store.markArchived(['li-8'], '2026-08-01T12:00:00.000Z');
  store.db.exec('COMMIT');
  assert.equal(store.listCacheEntries().length, 0);
  assert.equal(store.listArchiveCandidates().length, 0);
});
