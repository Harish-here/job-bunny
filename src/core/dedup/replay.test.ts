import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CacheEntry } from '../jd/index.ts';
import { JDSchema } from '../jd/index.ts';
import { dedupe } from './dedup.ts';

/**
 * Replay parity vs v0 (mirrors core/filter/replay.test.ts's harness): the
 * fixture's `cache`/`jobs` were transcribed from a set of scripts/pipeline/
 * dedup.js `dedupJobs()` fixtures run directly (node, ad hoc, against
 * equivalent job_id/job_title/company_name/location_city input) — its
 * console output (kept ids, dupCache/dupBatch/reposts counts and per-drop
 * log lines) is `v0.keptIds`/`v0.dropped` below, byte-checked against the
 * real v0 module rather than hand-derived.
 *
 * v0's dedupKey-fallback path (ancestor of v2's `dedup.role-company`) is
 * reachable only when the *incoming* job itself has no derivable job_id —
 * impossible for a v2 JD, whose `identity.id` is required non-empty — so
 * every drop v0 produces against real (id-carrying) input resolves to
 * either its primary id match or its repostKey match. That's exactly what
 * this fixture exercises: `dedup.role-company` has no v0-reachable replay
 * case and is intentionally absent here; it is unit-tested directly in
 * dedup.test.ts instead.
 */
const fixturePath = new URL('./fixtures/replay.json', import.meta.url);
const fixture: {
  cache: CacheEntry[];
  jobs: unknown[];
  v0: {
    keptIds: string[];
    dropped: { id: string; rule: string; duplicateOf?: string }[];
  };
} = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('replay fixture has 6 jobs and 2 cache entries', () => {
  assert.equal(fixture.jobs.length, 6);
  assert.equal(fixture.cache.length, 2);
});

const jobs = fixture.jobs.map((row) => JDSchema.parse(row));
const { jobs: kept, dropped } = dedupe(jobs, fixture.cache);

test('replay parity: kept ids match v0', () => {
  assert.deepEqual(
    kept.map((j) => j.identity.id),
    fixture.v0.keptIds,
  );
});

test('replay parity: dropped ids and rules match v0, in order', () => {
  const actual = dropped.map((record) => ({
    id: record.jd.identity.id,
    rule: record.reasons[0]?.rule,
    ...(record.jd.evaluation?.duplicateOf
      ? { duplicateOf: record.jd.evaluation.duplicateOf }
      : {}),
  }));
  assert.deepEqual(actual, fixture.v0.dropped);
});

test('replay parity: every dropped record carries a hard, failing verdict with a human-readable detail', () => {
  for (const record of dropped) {
    for (const verdict of record.reasons) {
      assert.equal(verdict.severity, 'hard');
      assert.equal(verdict.pass, false);
      assert.ok(verdict.detail && verdict.detail.length > 0);
    }
  }
});
