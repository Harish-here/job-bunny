import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import type { FilterConfig } from '../../core/filter/index.ts';
import type { CacheEntry, JD, StructuredJD, SyncedJD } from '../../core/jd/index.ts';
import { CacheEntrySchema } from '../../core/jd/index.ts';
import { RankConfigSchema } from '../../core/rank/index.ts';
import type { ArchivePolicy, Connector, RunContext } from '../../ports/index.ts';
import { FsStorage } from '../runner/fs_storage.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { dedupStage } from './dedup.ts';
import { makeFilterStage } from './filter.ts';
import { makeRankStage } from './rank.ts';
import { CACHE_PATH, makeReconcileStage } from './reconcile.ts';
import { makeSyncStage } from './sync.ts';

/**
 * Contract: pins the whole tail-of-pipeline funnel in one place —
 * fixture StructuredJDs -> reconcile (stubbed Connector, real FsStorage
 * for the reconcile->dedup cache handoff) -> filter -> dedup -> rank ->
 * sync (stubbed Connector). Four fixture jobs go in; each tail stage is
 * built to visibly drop or penalize exactly one of them:
 *   - `li-2` is dropped by `filter` (hard company-avoid fail).
 *   - `li-3` is dropped by `dedup` (id matches a seeded cache entry).
 *   - `li-4` survives `filter` with a soft-fail verdict (title.seniority)
 *     that costs it `softVerdictPenalty` rank points and surfaces its
 *     `detail` in `matchReasons`.
 *   - `li-1` is the clean baseline every other job is diffed against.
 * Only `li-1` and `li-4` reach `sync`. No network: `Connector` is a stub
 * whose calls are asserted on directly.
 */

function job(overrides: {
  id: string;
  title: string;
  company: string;
  skills?: string[];
}): StructuredJD {
  return {
    identity: {
      id: overrides.id,
      lane: 'linkedin',
      url: `https://www.linkedin.com/jobs/view/${overrides.id}`,
      company: overrides.company,
      title: overrides.title,
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    structured: {
      titleParts: {},
      locations: [],
      workType: 'remote',
      timezone: 'APAC',
      skills: overrides.skills ?? ['react'],
    },
  };
}

// Passes every rule cleanly — the baseline every other job's rank score is
// diffed against.
const jobGood = job({
  id: 'li-1',
  title: 'Senior Frontend Engineer',
  company: 'Acme Corp',
});

// Hard-drops at filter on company.avoid alone (title/skills/workType/timezone
// all otherwise pass) — isolates the filter-stage drop.
const jobAvoidCompany = job({
  id: 'li-2',
  title: 'Senior Frontend Engineer',
  company: 'Bad Corp',
});

// Passes filter cleanly (title still contains the configured domain keyword)
// but its id matches a seeded cache entry below — isolates the dedup-stage
// drop from the filter-stage drop.
const jobKnownToCache = job({
  id: 'li-3',
  title: 'Senior Frontend Developer',
  company: 'Acme Corp',
});

// Same skills/company/workType/timezone as jobGood, differing only in
// carrying "Principal" in the title — hits title.seniority's soft reject
// list, so it keeps at filter (soft-fail-only) rather than dropping, then
// survives dedup untouched (its dedup keys don't collide with any other
// fixture or the cache), then costs softVerdictPenalty points at rank.
const jobSoftFail = job({
  id: 'li-4',
  title: 'Principal Frontend Engineer',
  company: 'Acme Corp',
  skills: ['react'],
});

const filterCfg: FilterConfig = {
  title: {
    domain: { match: ['frontend'], reject: [], severity: 'hard' },
    seniority: { match: ['senior'], reject: ['principal'], severity: 'soft' },
  },
  companies: { avoid: ['Bad Corp'] },
  locations: [{ city: '*', workTypes: ['remote'] }],
  timezones: { accept: ['APAC'], severity: 'hard' },
  skills: { core: ['react'], minMatch: 1, severity: 'hard' },
};

// Default RankConfig — every axis besides the soft-verdict penalty scores
// identically for jobGood and jobSoftFail (same skills/workType/timezone,
// no domain keywords/seniority targets/home cities configured), so the
// score delta between them is exactly `softVerdictPenalty`.
const rankCfg = RankConfigSchema.parse({});

// Seeded cache: jobKnownToCache's id is already tracked under a different
// page — dedup must drop it via `dedup.id`, independent of title/company.
const seededCache: CacheEntry[] = [
  {
    id: 'li-3',
    company: 'Acme Corp',
    title: 'Senior Frontend Developer',
    pageId: 'page-99',
  },
];

function stubConnector(cache: CacheEntry[]): Connector & { syncCalls: JD[][] } {
  const syncCalls: JD[][] = [];
  return {
    name: 'stub',
    syncCalls,
    async rebuildCache(_ctx: RunContext): Promise<CacheEntry[]> {
      return cache;
    },
    async syncJobs(jobs: JD[], _ctx: RunContext): Promise<SyncedJD[]> {
      syncCalls.push(jobs);
      return jobs.map((jd) => ({
        ...jd,
        sync: { pageId: `page-${jd.identity.id}`, syncedAt: '2026-07-23T00:00:00.000Z' },
      }));
    },
    async archiveStale(_policy: ArchivePolicy, _ctx: RunContext): Promise<number> {
      return 0;
    },
  };
}

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'jb-tail-e2e-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('tail funnel: 4 in -> 1 dropped at filter, 1 dropped at dedup, soft-fail penalized at rank -> 2 to sync', async () => {
  const storage = new FsStorage(tmpDir);
  const ctx: StageContext = {
    profile: 'rajni',
    signal: AbortSignal.timeout(30_000),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage,
  };
  const connector = stubConnector(seededCache);

  const initial: StagePayload = {
    jobs: [jobGood, jobAvoidCompany, jobKnownToCache, jobSoftFail],
    dropped: [],
  };
  assert.equal(initial.jobs.length, 4, 'funnel: 4 jobs in');

  // --- reconcile: rebuilds the cache via the stubbed connector and writes
  // it to the REAL FsStorage temp dir, unchanged payload passthrough.
  const afterReconcile = await makeReconcileStage(connector).run(initial, ctx);
  assert.equal(afterReconcile, initial);
  const cacheOnDisk = await storage.readJson(CACHE_PATH, z.array(CacheEntrySchema));
  assert.deepEqual(
    cacheOnDisk,
    seededCache,
    'cache handoff went through the real filesystem',
  );

  // --- filter: drops jobAvoidCompany (hard company.avoid fail), keeps the
  // other 3 (jobSoftFail keeps as soft-fail-only).
  const afterFilter = await makeFilterStage(filterCfg).run(afterReconcile, ctx);
  assert.deepEqual(
    afterFilter.jobs.map((j) => j.identity.id),
    ['li-1', 'li-3', 'li-4'],
    'funnel: filter drops li-2',
  );
  assert.equal(afterFilter.dropped.length, 1);
  assert.equal(afterFilter.dropped[0]?.jd.identity.id, 'li-2');
  assert.ok(
    afterFilter.dropped[0]?.reasons.some((v) => v.rule === 'company.avoid' && !v.pass),
    'li-2 dropped specifically on company.avoid',
  );
  const softVerdict = afterFilter.jobs
    .find((j) => j.identity.id === 'li-4')
    ?.evaluation?.verdicts.find((v) => v.rule === 'title.seniority');
  assert.equal(softVerdict?.severity, 'soft');
  assert.equal(softVerdict?.pass, false);
  assert.equal(softVerdict?.detail, 'matched reject list');

  // --- dedup: drops jobKnownToCache (id already tracked in the cache),
  // keeps li-1 and li-4.
  const afterDedup = await dedupStage.run(afterFilter, ctx);
  assert.deepEqual(
    afterDedup.jobs.map((j) => j.identity.id),
    ['li-1', 'li-4'],
    'funnel: dedup additionally drops li-3',
  );
  assert.equal(afterDedup.dropped.length, 2, 'funnel: 2 dropped total (filter + dedup)');
  assert.equal(afterDedup.dropped[1]?.jd.identity.id, 'li-3');
  assert.equal(afterDedup.dropped[1]?.reasons[0]?.rule, 'dedup.id');
  assert.equal(afterDedup.dropped[1]?.reasons[0]?.pass, false);

  // --- rank: both survivors score, but li-4's carried soft-fail verdict
  // costs it exactly softVerdictPenalty points and surfaces its detail.
  const afterRank = await makeRankStage(rankCfg).run(afterDedup, ctx);
  const rankedGood = afterRank.jobs.find((j) => j.identity.id === 'li-1');
  const rankedSoftFail = afterRank.jobs.find((j) => j.identity.id === 'li-4');
  assert.equal(typeof rankedGood?.evaluation?.score, 'number');
  assert.equal(typeof rankedSoftFail?.evaluation?.score, 'number');
  const scoreDelta =
    (rankedGood?.evaluation?.score ?? 0) - (rankedSoftFail?.evaluation?.score ?? 0);
  assert.equal(
    scoreDelta,
    rankCfg.softVerdictPenalty,
    'soft-fail verdict visibly costs exactly softVerdictPenalty rank points',
  );
  assert.ok(
    rankedSoftFail?.evaluation?.matchReasons.includes('matched reject list'),
    "li-4's soft-fail detail is surfaced in matchReasons",
  );
  assert.ok(
    !rankedGood?.evaluation?.matchReasons.includes('matched reject list'),
    'li-1 carries no such penalty reason',
  );
  assert.equal(afterRank.dropped.length, 2, 'rank drops nothing further');

  // --- sync: only the 2 survivors are handed to the connector, each
  // carrying a score and an excitement band.
  const afterSync = await makeSyncStage(connector).run(afterRank, ctx);
  assert.equal(connector.syncCalls.length, 1);
  assert.deepEqual(
    connector.syncCalls[0]?.map((j) => j.identity.id),
    ['li-1', 'li-4'],
    'funnel: 2 jobs reach sync',
  );
  for (const synced of connector.syncCalls[0] ?? []) {
    assert.equal(typeof synced.evaluation?.score, 'number');
    assert.equal(typeof synced.evaluation?.excitement, 'string');
    assert.ok((synced.evaluation?.excitement?.length ?? 0) > 0);
  }
  assert.deepEqual(
    afterSync.jobs.map((j) => j.identity.id),
    ['li-1', 'li-4'],
  );
  assert.equal(
    afterSync.dropped.length,
    2,
    'funnel: final dropped count is filter(1) + dedup(1)',
  );
});
