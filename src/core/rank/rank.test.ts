import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructuredJD, Verdict } from '../jd/index.ts';
import { RankConfigSchema, rank, scoreJob } from './rank.ts';

function jd(
  overrides: Partial<StructuredJD['structured']> = {},
  evaluation?: StructuredJD['evaluation'],
): StructuredJD {
  return {
    identity: {
      id: 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company: 'Acme Corp',
      title: 'Senior Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    structured: {
      titleParts: {},
      locations: [],
      skills: [],
      ...overrides,
    },
    ...(evaluation ? { evaluation } : {}),
  };
}

// Every test below scores against a default (or near-default) config, under
// which title always contributes its neutral 8 (no domainKeywords
// configured) and yoe always contributes its fixed neutral 5 (the axis has
// no JD-side data to differentiate on — see rank.ts's module comment) unless
// a test explicitly configures/asserts those axes. That baseline +13 shows
// up in every score below that isn't specifically testing title/seniority.

test('RankConfigSchema: empty config parses with documented defaults', () => {
  const cfg = RankConfigSchema.parse({});
  assert.deepEqual(cfg.skills, {
    primary: [],
    secondary: [],
    primarySkillPoints: 1,
    secondarySkillPoints: 0.5,
    maxPoints: 40,
    denomMin: 3,
    denomMax: 8,
  });
  assert.deepEqual(cfg.title, { domainKeywords: [], maxPoints: 15, neutralPoints: 8 });
  assert.deepEqual(cfg.seniority, { targets: [], maxPoints: 15 });
  assert.deepEqual(cfg.location, {
    homeCities: [],
    acceptableTimezones: [],
    borderlineTimezones: [],
    bonus: 20,
    partial: 10,
  });
  assert.deepEqual(cfg.yoe, { maxPoints: 10, neutralPoints: 5 });
  assert.deepEqual(cfg.workTypePreference, { onsite: 1, hybrid: 1, remote: 1 });
  assert.equal(cfg.softVerdictPenalty, 5);
});

// --- Excitement banding (v0 rank.js:41-45 thresholds, restored full scale) ---

test('excitement banding: pinned v0 thresholds and strings (rank.js:41-45)', () => {
  // >= 85 ⇒ 'Vera level' — every axis maxed under its DEFAULT maxPoints/bonus,
  // yoe contributing its fixed neutral 5 (its max is structurally unreachable —
  // see rank.ts's module comment): 40 + 15 + 15 + 20 + 5 = 95.
  const highCfg = RankConfigSchema.parse({
    skills: { primary: ['React', 'TypeScript', 'Vue'] },
    title: { domainKeywords: ['Frontend'] },
    seniority: { targets: ['Staff'] },
    location: { homeCities: ['Chennai'] },
  });
  const high = scoreJob(
    jd({
      skills: ['React', 'TypeScript', 'Vue'],
      workType: 'hybrid',
      locations: [{ city: 'Chennai' }],
      titleParts: { seniority: 'Staff' },
    }),
    highCfg,
  );
  assert.equal(high.score, 95);
  assert.equal(high.excitement, 'Vera level');

  // 65-84 ⇒ 'Kandipa podu'
  const midCfg = RankConfigSchema.parse({
    location: { homeCities: ['Chennai'], bonus: 70 },
  });
  const mid = scoreJob(
    jd({ workType: 'hybrid', locations: [{ city: 'Chennai' }] }),
    midCfg,
  );
  // 0 (skills) + 8 (title neutral) + 0 (seniority miss) + 70 (location) + 5 (yoe) = 83
  assert.equal(mid.score, 83);
  assert.equal(mid.excitement, 'Kandipa podu');

  // < 65 ⇒ 'Try panalam'
  const low = scoreJob(jd({ skills: [] }), RankConfigSchema.parse({}));
  // 0 + 8 + 0 + 0 + 5 = 13
  assert.equal(low.score, 13);
  assert.equal(low.excitement, 'Try panalam');
});

test('score is always clamped to [0, 100] even when config points exceed it', () => {
  const cfg = RankConfigSchema.parse({
    skills: { primary: ['React'], maxPoints: 500 },
    location: { homeCities: ['Chennai'], bonus: 500 },
  });
  const { score } = scoreJob(
    jd({ skills: ['React'], workType: 'hybrid', locations: [{ city: 'Chennai' }] }),
    cfg,
  );
  assert.equal(score, 100);
});

const hardFail = (rule: string, detail: string): Verdict => ({
  rule,
  severity: 'hard',
  pass: false,
  detail,
});

// --- rank() batch entry point ---

test('rank(): pure — does not mutate its input jobs', () => {
  const cfg = RankConfigSchema.parse({ skills: { primary: ['React'] } });
  const input = [jd({ skills: ['React'] })];
  const snapshot = JSON.parse(JSON.stringify(input));
  rank(input, cfg);
  assert.deepEqual(input, snapshot);
});

test('rank(): deterministic — same input, same output, across repeated calls', () => {
  const cfg = RankConfigSchema.parse({ skills: { primary: ['React', 'TypeScript'] } });
  const input = [
    jd({ skills: ['React'], workType: 'remote', timezone: 'APAC' }),
    jd({ skills: [] }),
  ];
  const first = rank(input, cfg);
  const second = rank(input, cfg);
  assert.deepEqual(first, second);
});

test('rank(): carries prior evaluation.verdicts/duplicateOf through unchanged', () => {
  const cfg = RankConfigSchema.parse({});
  const verdicts: Verdict[] = [hardFail('skills.core', 'no overlap')];
  const input = [jd({}, { verdicts, duplicateOf: 'li-0', matchReasons: [] })];
  const [out] = rank(input, cfg);
  assert.deepEqual(out?.evaluation.verdicts, verdicts);
  assert.equal(out?.evaluation.duplicateOf, 'li-0');
});

test('rank(): every job gets a numeric score, excitement label, and matchReasons array', () => {
  const cfg = RankConfigSchema.parse({});
  const [out] = rank([jd({})], cfg);
  assert.equal(typeof out?.evaluation.score, 'number');
  assert.equal(typeof out?.evaluation.excitement, 'string');
  assert.ok(Array.isArray(out?.evaluation.matchReasons));
});

test('rank(): idempotent — re-ranking an already-ranked batch does not duplicate matchReasons', () => {
  const cfg = RankConfigSchema.parse({ skills: { primary: ['React'] } });
  const input = [jd({ skills: ['React'] })];
  const once = rank(input, cfg);
  const twice = rank(once, cfg);
  assert.deepEqual(twice[0]?.evaluation.matchReasons, once[0]?.evaluation.matchReasons);
});
