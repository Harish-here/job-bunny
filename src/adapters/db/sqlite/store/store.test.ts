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

test('importJobs inserts new rows, returns the count, and NEVER touches an existing row', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-30')], '2026-08-01T10:00:00.000Z');
  const before = store.db.prepare('SELECT * FROM jobs WHERE id = ?').get('li-30');

  const richer = makeJd('li-30');
  richer.identity.title = 'DIFFERENT TITLE FROM NOTION';
  const n = store.importJobs([richer, makeJd('li-31')], '2026-08-02T10:00:00.000Z');

  assert.equal(n, 1); // only li-31 inserted
  const after = store.db.prepare('SELECT * FROM jobs WHERE id = ?').get('li-30');
  assert.deepEqual(after, before); // byte-identical — pipeline row wins
});

test('importJobs does not revive an archived row (unlike upsertJobs)', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-32')], '2026-08-01T10:00:00.000Z');
  store.markArchived(['li-32'], '2026-08-01T12:00:00.000Z');
  store.importJobs([makeJd('li-32')], '2026-08-02T10:00:00.000Z');
  assert.equal(store.listCacheEntries().length, 0);
});

test('importTracking inserts rows and returns the count', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-20'), makeJd('li-21')], '2026-08-02T10:00:00.000Z');
  const n = store.importTracking([
    {
      jobId: 'li-20',
      fields: { status: 'Applied', notes: 'hi' },
      updatedAt: '2026-08-02T10:00:00.000Z',
    },
    { jobId: 'li-21', fields: { status: 'Lead' }, updatedAt: '2026-08-02T10:00:00.000Z' },
  ]);
  assert.equal(n, 2);
  const row = store.db
    .prepare('SELECT status, notes FROM tracking WHERE job_id = ?')
    .get('li-20') as { status: string; notes: string };
  assert.deepEqual({ ...row }, { status: 'Applied', notes: 'hi' });
});

test('importTracking never overwrites an existing row (board edits win)', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-22')], '2026-08-02T10:00:00.000Z');
  store.importTracking([
    { jobId: 'li-22', fields: { status: 'Lead' }, updatedAt: '2026-08-02T10:00:00.000Z' },
  ]);
  const n = store.importTracking([
    {
      jobId: 'li-22',
      fields: { status: 'Offer' },
      updatedAt: '2026-08-03T10:00:00.000Z',
    },
  ]);
  assert.equal(n, 0);
  const row = store.db
    .prepare('SELECT status FROM tracking WHERE job_id = ?')
    .get('li-22') as { status: string };
  assert.equal(row.status, 'Lead');
});

test('importTracking throws on a job id with no jobs row (FK enforced)', () => {
  const store = freshStore();
  assert.throws(() =>
    store.importTracking([
      {
        jobId: 'li-404',
        fields: { status: 'Lead' },
        updatedAt: '2026-08-02T10:00:00.000Z',
      },
    ]),
  );
});
