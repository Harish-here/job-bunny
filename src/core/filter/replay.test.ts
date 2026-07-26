import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { StructuredJD } from '../jd/index.ts';
import { JDSchema } from '../jd/index.ts';
import { FilterConfigSchema } from './config.ts';
import { decide, evaluate } from './engine.ts';

/**
 * Replay parity vs v0 (spec Task 6): re-run every rajni fixture job that v0
 * actually decided on through the v2 engine and diff the decisions.
 *
 * EXPECTED_DIVERGENCES = ['rajni-1004']
 *
 * rajni-1004: v0 hard-drops via its `tz_bad` (timezone_incompatible) guard, a
 * boolean flag v2 deliberately removed. v2's timezone rule operates only on a
 * structured `timezone` value and never drops on missing data (spec §6), so
 * with timezone absent v2 keeps it. Intended model simplification: timezone
 * incompatibility must be expressed as a timezone value, not a separate flag.
 */
const EXPECTED_DIVERGENCES = ['rajni-1004'];

const cfg = FilterConfigSchema.parse({
  title: {
    domain: {
      match: [
        'frontend',
        'front-end',
        'ui',
        'react',
        'design systems',
        'platform',
        'web',
      ],
    },
    function: {
      match: [],
      reject: [
        'manager',
        'director',
        'vp',
        'vice president',
        'analyst',
        'qa',
        'devops',
        'data',
        'recruiter',
      ],
    },
    seniority: {
      match: [
        'staff',
        'lead',
        'principal',
        'architect',
        'associate principal',
        'technical lead',
        'tech lead',
      ],
    },
  },
  companies: { avoid: ['Chargebee', 'Rocketlane'] },
  locations: [
    { city: 'chennai', country: 'India', workTypes: ['onsite', 'hybrid'] },
    { city: 'bengaluru', country: 'India', workTypes: ['onsite', 'hybrid'] },
    { city: '*', workTypes: ['remote'] },
  ],
  timezones: { accept: ['APAC', 'EMEA'] },
  skills: {
    core: ['React', 'TypeScript', 'JavaScript', 'UI Architecture', 'Design Systems'],
    minMatch: 1,
  },
});

type ReplayRow = {
  input: unknown;
  v0Decision: 'keep' | 'drop';
  v0Reason?: string;
};

const fixturePath = new URL('./fixtures/replay.json', import.meta.url);
const replay: ReplayRow[] = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('replay fixture has 14 rows', () => {
  assert.equal(replay.length, 14);
});

// Compute all v2 decisions up front (not inside test bodies) so the
// per-row assertions and the aggregate divergence-count assertion are
// independent of node:test's scheduling/ordering.
const results = replay.map((row) => {
  const jd = JDSchema.parse(row.input) as StructuredJD;
  const verdicts = evaluate(jd, cfg);
  const v2Decision = decide(verdicts);
  return { id: jd.identity.id, v0Decision: row.v0Decision, v2Decision, verdicts };
});

const divergences = results.filter((r) => r.v2Decision !== r.v0Decision).map((r) => r.id);

for (const r of results) {
  test(`replay parity: ${r.id}`, () => {
    if (EXPECTED_DIVERGENCES.includes(r.id)) {
      assert.notEqual(
        r.v2Decision,
        r.v0Decision,
        `${r.id} was expected to diverge from v0 (${r.v0Decision}) but v2 also produced ${r.v2Decision}`,
      );
    } else {
      assert.equal(
        r.v2Decision,
        r.v0Decision,
        `${r.id} diverged from v0: v0=${r.v0Decision} v2=${r.v2Decision} verdicts=${JSON.stringify(r.verdicts)}`,
      );
    }
  });
}

test('exactly the expected divergences occurred, no others', () => {
  assert.deepEqual(divergences.sort(), [...EXPECTED_DIVERGENCES].sort());
  assert.equal(divergences.length, EXPECTED_DIVERGENCES.length);
});
