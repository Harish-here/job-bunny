import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { JD } from '../../../../core/jd/index.ts';
import { openJobsDb, SqliteStore } from '../store/index.ts';
import { SqliteBoardStore } from './board.ts';

const NOW = '2026-08-01T12:00:00.000Z';

function makeJd(
  id: string,
  overrides: {
    company?: string;
    lane?: string;
    scrapedAt?: string;
    score?: number;
    excitement?: string;
    skills?: string[];
    matchReasons?: string[];
    evaluation?: JD['evaluation'];
  } = {},
): JD {
  return {
    identity: {
      id,
      lane: overrides.lane ?? 'linkedin',
      url: `https://example.com/jobs/${id}`,
      company: overrides.company ?? 'Acme Corp',
      title: 'Staff Engineer',
      scrapedAt: overrides.scrapedAt ?? '2026-08-01T10:00:00.000Z',
    },
    structured: {
      titleParts: {},
      locations: [],
      skills: overrides.skills ?? [],
    },
    evaluation: overrides.evaluation ?? {
      verdicts: [],
      matchReasons: overrides.matchReasons ?? [],
      score: overrides.score,
      excitement: overrides.excitement,
    },
  };
}

function freshDbs(): { db: DatabaseSync; store: SqliteStore; board: SqliteBoardStore } {
  const db = openJobsDb(':memory:');
  return { db, store: new SqliteStore(db), board: new SqliteBoardStore(db) };
}

test('listJobs on empty DB returns empty rows and total 0', () => {
  const { board } = freshDbs();
  assert.deepEqual(board.listJobs({}), { rows: [], total: 0 });
});

test('listJobs: default filters out archived, sorts date_found DESC, computes total; row shape is correct', () => {
  const { store, board } = freshDbs();
  store.upsertJobs(
    [
      makeJd('li-1', {
        company: 'Acme Corp',
        scrapedAt: '2026-08-01T09:00:00.000Z',
        excitement: 'high',
        skills: ['React'],
        matchReasons: ['good fit'],
        score: 80,
      }),
      makeJd('gh-2', {
        lane: 'greenhouse',
        company: 'Other Inc',
        scrapedAt: '2026-08-02T09:00:00.000Z',
        excitement: 'medium',
        skills: ['Node'],
        matchReasons: ['ok fit'],
        score: 70,
      }),
      makeJd('li-3', {
        company: 'Third Co',
        scrapedAt: '2026-08-03T09:00:00.000Z',
        excitement: 'low',
        skills: [],
        matchReasons: [],
        score: 50,
      }),
    ],
    NOW,
  );
  store.markArchived(['gh-2'], NOW);

  const { rows, total } = board.listJobs({});
  assert.equal(total, 2);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['li-3', 'li-1'],
  );
  assert.ok(rows.every((r) => r.archived === false));
  assert.ok(!rows.some((r) => r.id === 'gh-2'));

  const first = rows[0];
  assert.ok(Array.isArray(first?.skills));
  assert.ok(Array.isArray(first?.matchReasons));
  assert.equal(first?.tracking, null);
});

test('archived: true returns only archived jobs', () => {
  const { store, board } = freshDbs();
  store.upsertJobs([makeJd('a-1'), makeJd('a-2', { company: 'B Co' })], NOW);
  store.markArchived(['a-1'], NOW);

  const { rows, total } = board.listJobs({ archived: true });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a-1'],
  );
  assert.equal(total, 1);
});

test('company filter matches case-insensitively and escapes literal % correctly', () => {
  const { store, board } = freshDbs();
  store.upsertJobs(
    [
      makeJd('c-1', { company: 'Acme GmbH' }),
      makeJd('c-2', { company: 'Other Co' }),
      makeJd('c-3', { company: '100%' }),
      // Contains "100" but NOT the literal "100%" substring — must NOT match
      // an unescaped '%' wildcard search for '100%'.
      makeJd('c-4', { company: '100 Widgets Inc' }),
    ],
    NOW,
  );

  const acme = board.listJobs({ company: 'acm' });
  assert.deepEqual(
    acme.rows.map((r) => r.company),
    ['Acme GmbH'],
  );

  const literalPercent = board.listJobs({ company: '100%' });
  assert.deepEqual(
    literalPercent.rows.map((r) => r.company),
    ['100%'],
  );
});

test('status filter joins tracking; total reflects the filtered count (LEFT JOIN in count too)', () => {
  const { store, board } = freshDbs();
  store.upsertJobs([makeJd('s-1'), makeJd('s-2', { company: 'Other Co' })], NOW);
  const t1 = '2026-08-02T09:00:00.000Z';
  board.updateTracking('s-1', { status: 'Applied' }, t1);

  const { rows, total } = board.listJobs({ status: 'Applied' });
  assert.equal(rows.length, 1);
  assert.equal(total, 1);
  assert.equal(rows[0]?.id, 's-1');
  assert.equal(rows[0]?.tracking?.updatedAt, t1);
});

test('dateFrom/dateTo bound inclusively via substr projection; sort=score order=asc works', () => {
  const { store, board } = freshDbs();
  store.upsertJobs(
    [
      makeJd('d-1', { scrapedAt: '2026-08-01T09:00:00.000Z', score: 50 }),
      // Non-midnight time on the boundary day — proves the substr(1,10)
      // projection, not a bare string compare (which would exclude this row).
      makeJd('d-2', { scrapedAt: '2026-08-02T09:00:00.000Z', score: 90 }),
      makeJd('d-3', { scrapedAt: '2026-08-03T09:00:00.000Z', score: 70 }),
    ],
    NOW,
  );

  const upToBoundary = board.listJobs({ dateTo: '2026-08-02' });
  assert.deepEqual(upToBoundary.rows.map((r) => r.id).sort(), ['d-1', 'd-2']);

  const fromBoundary = board.listJobs({ dateFrom: '2026-08-02' });
  assert.deepEqual(fromBoundary.rows.map((r) => r.id).sort(), ['d-2', 'd-3']);

  const sorted = board.listJobs({ sort: 'score', order: 'asc' });
  assert.deepEqual(
    sorted.rows.map((r) => r.score),
    [50, 70, 90],
  );
});

test('limit/offset paginate; total unaffected', () => {
  const { store, board } = freshDbs();
  store.upsertJobs(
    [
      makeJd('p-1', { scrapedAt: '2026-08-01T09:00:00.000Z' }),
      makeJd('p-2', { company: 'B Co', scrapedAt: '2026-08-02T09:00:00.000Z' }),
    ],
    NOW,
  );

  const page = board.listJobs({ limit: 1, offset: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(
    page.rows.map((r) => r.id),
    ['p-1'],
  );
});

test('getJob returns detail with parsed jd and reviewFlags derived from verdicts; unknown id is null', () => {
  const { store, board } = freshDbs();
  const jd = makeJd('g-1', {
    evaluation: {
      verdicts: [{ rule: 'geo', severity: 'soft', pass: false, detail: 'X' }],
      matchReasons: [],
    },
  });
  store.upsertJobs([jd], NOW);

  const detail = board.getJob('g-1');
  assert.ok(detail);
  assert.equal(detail?.jd.identity.id, 'g-1');
  assert.deepEqual(detail?.reviewFlags, ['X']);

  assert.equal(board.getJob('missing'), null);
});

test('updateTracking creates then patches a tracking row; null clears; absent keys untouched; unknown id -> null', () => {
  const { store, board } = freshDbs();
  store.upsertJobs([makeJd('t-1')], NOW);

  const t1 = '2026-08-02T10:00:00.000Z';
  const created = board.updateTracking(
    't-1',
    {
      status: 'Lead',
      compRange: '10-20',
      notes: 'first note',
      contact: 'Jane',
      dateApplied: '2026-08-02',
      nextAction: 'Follow up',
      nextActionDate: '2026-08-05',
    },
    t1,
  );
  assert.deepEqual(created, {
    jobId: 't-1',
    updatedAt: t1,
    status: 'Lead',
    compRange: '10-20',
    notes: 'first note',
    contact: 'Jane',
    dateApplied: '2026-08-02',
    nextAction: 'Follow up',
    nextActionDate: '2026-08-05',
  });

  const t2 = '2026-08-02T11:00:00.000Z';
  const patched = board.updateTracking('t-1', { notes: null }, t2);
  assert.deepEqual(patched, {
    jobId: 't-1',
    updatedAt: t2,
    status: 'Lead',
    compRange: '10-20',
    contact: 'Jane',
    dateApplied: '2026-08-02',
    nextAction: 'Follow up',
    nextActionDate: '2026-08-05',
  });

  assert.equal(board.updateTracking('missing-job', { status: 'Lead' }, t2), null);
});

test('updateTracking savepoint is released cleanly — sequential updates both succeed', () => {
  const { store, board } = freshDbs();
  store.upsertJobs([makeJd('r-1')], NOW);
  const t1 = '2026-08-02T10:00:00.000Z';
  const t2 = '2026-08-02T11:00:00.000Z';

  assert.ok(board.updateTracking('r-1', { status: 'Lead' }, t1));
  assert.ok(board.updateTracking('r-1', { status: 'Applied' }, t2));

  const final = board.getJob('r-1');
  assert.equal(final?.tracking?.status, 'Applied');
  assert.equal(final?.tracking?.updatedAt, t2);
});
