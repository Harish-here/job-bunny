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

test('skills axis: no JD skills ⇒ 0 points, explicit reason', () => {
  const cfg = RankConfigSchema.parse({});
  const { score, matchReasons } = scoreJob(jd({ skills: [] }), cfg);
  // 0 (skills) + 8 (title neutral) + 0 (seniority miss) + 0 (work type unknown) + 5 (yoe neutral)
  assert.equal(score, 13);
  assert.equal(matchReasons[0], 'No JD skills listed (+0)');
});

test('skills axis: full primary coverage hits the axis cap', () => {
  const cfg = RankConfigSchema.parse({ skills: { primary: ['React', 'TypeScript'] } });
  const { score } = scoreJob(jd({ skills: ['React', 'TypeScript'] }), cfg);
  // weight = 2*1 = 2, denom = clamp(2,3,8) = 3, points = round(min(1,2/3)*40) = 27
  // + 8 (title neutral) + 0 (seniority miss) + 0 (work type unknown) + 5 (yoe neutral) = 40
  assert.equal(score, 40);
});

test('skills axis: a skill in both primary and secondary counts as primary only', () => {
  const cfg = RankConfigSchema.parse({
    skills: { primary: ['React'], secondary: ['React'] },
  });
  const { matchReasons } = scoreJob(jd({ skills: ['React', 'React', 'Vue'] }), cfg);
  assert.ok(matchReasons[0]?.includes('primary: React, React'));
  assert.ok(!matchReasons[0]?.includes('secondary'));
});

test('skills axis: denominator clamp keeps a 1-skill JD from spiking to the cap alone', () => {
  const cfg = RankConfigSchema.parse({ skills: { primary: ['React'] } });
  const { score } = scoreJob(jd({ skills: ['React'] }), cfg);
  // weight = 1, denom = clamp(1,3,8) = 3, points = round(min(1,1/3)*40) = 13, not 40
  // + 8 + 0 + 0 + 5 = 26
  assert.equal(score, 26);
});

// --- Title relevance axis (v0 rank.js:83-99) ---

test('title axis: no domain keywords configured ⇒ neutral credit', () => {
  const cfg = RankConfigSchema.parse({});
  const { matchReasons } = scoreJob(jd({}), cfg);
  assert.equal(matchReasons[1], 'No domain keywords configured, title neutral (+8)');
});

test('title axis: title contains a configured domain keyword ⇒ full credit', () => {
  const cfg = RankConfigSchema.parse({ title: { domainKeywords: ['Frontend'] } });
  const { score, matchReasons } = scoreJob(jd({}), cfg);
  // title() default is 'Senior Frontend Engineer' — contains "Frontend".
  // 0 (skills) + 15 (title) + 0 (seniority) + 0 (work type) + 5 (yoe) = 20
  assert.equal(score, 20);
  assert.ok(matchReasons[1]?.includes('Title matches domain "Frontend"'));
});

test('title axis: title has no configured domain keyword ⇒ zero, not neutral', () => {
  const cfg = RankConfigSchema.parse({ title: { domainKeywords: ['Backend'] } });
  const { matchReasons } = scoreJob(jd({}), cfg);
  assert.equal(matchReasons[1], 'Title has no domain keyword (+0)');
});

test('title axis: matching is token-normalized (case/punctuation insensitive)', () => {
  const cfg = RankConfigSchema.parse({ title: { domainKeywords: ['front-end!'] } });
  const { matchReasons } = scoreJob(jd({}), cfg);
  assert.ok(matchReasons[1]?.includes('(+15)'));
});

// --- Seniority axis (v0 rank.js:101-109) ---

test('seniority axis: titleParts.seniority in the configured target list ⇒ full credit', () => {
  const cfg = RankConfigSchema.parse({ seniority: { targets: ['Staff', 'Senior'] } });
  const { score, matchReasons } = scoreJob(
    jd({ titleParts: { seniority: 'Staff' } }),
    cfg,
  );
  // 0 (skills) + 8 (title neutral) + 15 (seniority) + 0 (work type) + 5 (yoe) = 28
  assert.equal(score, 28);
  assert.equal(matchReasons[2], 'Staff matches target seniority (+15)');
});

test('seniority axis: matching is case-insensitive', () => {
  const cfg = RankConfigSchema.parse({ seniority: { targets: ['staff'] } });
  const { matchReasons } = scoreJob(jd({ titleParts: { seniority: 'STAFF' } }), cfg);
  assert.equal(matchReasons[2], 'STAFF matches target seniority (+15)');
});

test('seniority axis: no partial tier — outside the target list is a full miss', () => {
  const cfg = RankConfigSchema.parse({ seniority: { targets: ['Staff'] } });
  const { matchReasons } = scoreJob(jd({ titleParts: { seniority: 'Mid' } }), cfg);
  assert.equal(matchReasons[2], 'Mid below target seniority (+0)');
});

test('seniority axis: an undefined seniority is a miss, not an error', () => {
  const cfg = RankConfigSchema.parse({ seniority: { targets: ['Staff'] } });
  const { matchReasons } = scoreJob(jd({}), cfg);
  assert.equal(matchReasons[2], 'Unknown below target seniority (+0)');
});

// --- Location / work-type axis (v0 rank.js:111-147) ---

test('location axis: remote + acceptable timezone ⇒ full bonus', () => {
  const cfg = RankConfigSchema.parse({ location: { acceptableTimezones: ['APAC'] } });
  const { score } = scoreJob(jd({ workType: 'remote', timezone: 'APAC' }), cfg);
  // 0 + 8 + 0 + 20 + 5 = 33
  assert.equal(score, 33);
});

test('location axis: remote + borderline timezone ⇒ partial', () => {
  const cfg = RankConfigSchema.parse({ location: { borderlineTimezones: ['EMEA'] } });
  const { score } = scoreJob(jd({ workType: 'remote', timezone: 'EMEA' }), cfg);
  // 0 + 8 + 0 + 10 + 5 = 23
  assert.equal(score, 23);
});

test('location axis: remote + unrecognized timezone ⇒ partial (never a drop — tz is a soft signal)', () => {
  const cfg = RankConfigSchema.parse({});
  const { score } = scoreJob(jd({ workType: 'remote', timezone: 'US' }), cfg);
  // 0 + 8 + 0 + 10 + 5 = 23
  assert.equal(score, 23);
});

test('location axis: hybrid/on-site in a configured home city ⇒ full bonus', () => {
  const cfg = RankConfigSchema.parse({ location: { homeCities: ['Chennai'] } });
  const { score } = scoreJob(
    jd({ workType: 'hybrid', locations: [{ city: 'Chennai' }] }),
    cfg,
  );
  // 0 + 8 + 0 + 20 + 5 = 33
  assert.equal(score, 33);
});

test('location axis: on-site outside every configured home city ⇒ zero', () => {
  const cfg = RankConfigSchema.parse({ location: { homeCities: ['Chennai'] } });
  const { score } = scoreJob(
    jd({ workType: 'onsite', locations: [{ city: 'Mumbai' }] }),
    cfg,
  );
  // 0 + 8 + 0 + 0 + 5 = 13
  assert.equal(score, 13);
});

test('location axis: undefined workType is a neutral miss, not an error', () => {
  const cfg = RankConfigSchema.parse({});
  const { score, matchReasons } = scoreJob(jd({}), cfg);
  // 0 + 8 + 0 + 0 + 5 = 13
  assert.equal(score, 13);
  assert.ok(matchReasons.includes('Work type unknown (+0)'));
});

test('workTypePreference: a below-1 multiplier scales the location axis down', () => {
  const cfg = RankConfigSchema.parse({
    location: { homeCities: ['Chennai'] },
    workTypePreference: { onsite: 0.5, hybrid: 1, remote: 1 },
  });
  const { score } = scoreJob(
    jd({ workType: 'onsite', locations: [{ city: 'Chennai' }] }),
    cfg,
  );
  // 0 + 8 + 0 + round(20*0.5)=10 + 5 = 23
  assert.equal(score, 23);
});

test('workTypePreference: default 1 for every type leaves v0-identical base scoring untouched', () => {
  const cfg = RankConfigSchema.parse({ location: { homeCities: ['Chennai'] } });
  const { matchReasons } = scoreJob(
    jd({ workType: 'hybrid', locations: [{ city: 'Chennai' }] }),
    cfg,
  );
  assert.ok(!matchReasons.some((r) => r.includes('workType preference')));
});

// --- YoE axis (v0 rank.js:149-166 — genuinely not portable, see rank.ts) ---

test('yoe axis: always awards the fixed neutral credit — no JD field exists to differentiate on', () => {
  const cfg = RankConfigSchema.parse({});
  const { matchReasons } = scoreJob(jd({}), cfg);
  assert.equal(matchReasons[4], 'No YoE data modeled, neutral (+5)');
});

test('yoe axis: raising maxPoints has no effect — only neutralPoints is ever awarded', () => {
  const cfg = RankConfigSchema.parse({ yoe: { maxPoints: 999, neutralPoints: 5 } });
  const { matchReasons } = scoreJob(jd({}), cfg);
  assert.equal(matchReasons[4], 'No YoE data modeled, neutral (+5)');
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

// --- Soft-verdict penalty (the genuinely new v2 behavior, spec §6) ---

const softFail = (rule: string, detail: string): Verdict => ({
  rule,
  severity: 'soft',
  pass: false,
  detail,
});
const hardFail = (rule: string, detail: string): Verdict => ({
  rule,
  severity: 'hard',
  pass: false,
  detail,
});
const softPass = (rule: string): Verdict => ({ rule, severity: 'soft', pass: true });

test('a soft-fail verdict deducts softVerdictPenalty and surfaces its detail in matchReasons', () => {
  const cfg = RankConfigSchema.parse({
    skills: { primary: ['React'] },
    softVerdictPenalty: 5,
  });
  const withVerdict = jd(
    { skills: ['React'] },
    {
      verdicts: [softFail('title.seniority', 'no match in [staff, principal]')],
      matchReasons: [],
    },
  );
  const bare = jd({ skills: ['React'] });
  const scoredWithVerdict = scoreJob(withVerdict, cfg);
  const scoredBare = scoreJob(bare, cfg);
  assert.equal(scoredBare.score - scoredWithVerdict.score, 5);
  assert.ok(scoredWithVerdict.matchReasons.includes('no match in [staff, principal]'));
});

test('multiple soft-fail verdicts each cost a penalty and each surfaces its own detail', () => {
  const cfg = RankConfigSchema.parse({
    skills: { primary: ['React'] },
    softVerdictPenalty: 5,
  });
  const twoSoftFails = jd(
    { skills: ['React'] },
    {
      verdicts: [
        softFail('title.seniority', 'no match in [staff]'),
        softFail('timezone.accept', 'timezone not in [APAC]'),
      ],
      matchReasons: [],
    },
  );
  const { score, matchReasons } = scoreJob(twoSoftFails, cfg);
  const { score: baseScore } = scoreJob(jd({ skills: ['React'] }), cfg);
  assert.equal(baseScore - score, 10);
  assert.ok(matchReasons.includes('no match in [staff]'));
  assert.ok(matchReasons.includes('timezone not in [APAC]'));
});

test('a soft-fail verdict with no detail falls back to a rule-derived reason', () => {
  const cfg = RankConfigSchema.parse({ softVerdictPenalty: 5 });
  const withVerdict = jd(
    {},
    { verdicts: [{ rule: 'x.y', severity: 'soft', pass: false }], matchReasons: [] },
  );
  const { matchReasons } = scoreJob(withVerdict, cfg);
  assert.ok(matchReasons.some((r) => r.includes('x.y')));
});

test('hard-fail and passing verdicts never contribute to the penalty or matchReasons', () => {
  const cfg = RankConfigSchema.parse({
    skills: { primary: ['React'] },
    softVerdictPenalty: 5,
  });
  const withVerdicts = jd(
    { skills: ['React'] },
    {
      verdicts: [hardFail('skills.core', 'no overlap'), softPass('title.domain')],
      matchReasons: [],
    },
  );
  const { score, matchReasons } = scoreJob(withVerdicts, cfg);
  const { score: baseScore } = scoreJob(jd({ skills: ['React'] }), cfg);
  assert.equal(score, baseScore);
  assert.ok(!matchReasons.some((r) => r.includes('no overlap')));
});

test('the soft-verdict penalty can drive the score to 0 but never negative', () => {
  const cfg = RankConfigSchema.parse({
    skills: { primary: ['React'] },
    softVerdictPenalty: 1000,
  });
  const withVerdict = jd(
    { skills: ['React'] },
    {
      verdicts: [softFail('title.seniority', 'no match')],
      matchReasons: [],
    },
  );
  const { score } = scoreJob(withVerdict, cfg);
  assert.equal(score, 0);
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
