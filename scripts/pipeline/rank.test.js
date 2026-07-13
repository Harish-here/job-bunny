// scripts/pipeline/rank.test.js — node:test unit tests for the pure scorer scoreJob() (no I/O,
// no network — fast, deterministic). Run with:
//   node --test scripts/rank.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreJob } from "./rank.js";

// Axis-isolation helpers: MISS_TITLE zeroes the title axis (keyword that never matches),
// years_of_experience: 100 zeroes the YoE axis (candidate always >2 below), no
// seniority/work_type match zeroes those — so `score` equals the axis under test.
const MISS_TITLE = { domainKeywords: ["zzz-no-such-domain"] };
const zeroed = { years_of_experience: 100 };

// ---- 1. Skills overlap (40 pts) — core ×1.0, secondary ×0.5, denom clamp [3, 8] ----

test("scoreJob: 0 of N skills match → +0", () => {
  const job = { ...zeroed, key_skills: ["Python", "Java", "Go"] };
  const meta = { core_skills: ["Rust"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r.startsWith("0/3 skills match (+0)")));
});

test("scoreJob: core skill match is case-insensitive", () => {
  const job = { ...zeroed, key_skills: ["python", "Java", "Go"] };
  const meta = { core_skills: ["PYTHON"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  // weight 1 / denom 3 * 40 = 13.33 → 13
  assert.equal(score, 13);
  assert.ok(match_reasons.some((r) => r.startsWith("1/3 skills match (core: python) (+13)")));
});

test("scoreJob: secondary skill counts at half weight", () => {
  const job = { ...zeroed, key_skills: ["Vue.js", "Java", "Go"] };
  const meta = { core_skills: ["Rust"], secondary_skills: ["vue.js"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  // weight 0.5 / denom 3 * 40 = 6.67 → 7
  assert.equal(score, 7);
  assert.ok(match_reasons.some((r) => r.startsWith("1/3 skills match (secondary: Vue.js) (+7)")));
});

test("scoreJob: skill in both core and secondary counts as core (full weight)", () => {
  const job = { ...zeroed, key_skills: ["React", "Java", "Go"] };
  const meta = { core_skills: ["React"], secondary_skills: ["React"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 13);
  assert.ok(match_reasons.some((r) => r.includes("core: React") && !r.includes("secondary")));
});

test("scoreJob: core + secondary mix in one JD", () => {
  const job = { ...zeroed, key_skills: ["React", "Storybook", "Go", "Java"] };
  const meta = { core_skills: ["React"], secondary_skills: ["Storybook"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  // weight 1.5 / denom 4 * 40 = 15
  assert.equal(score, 15);
  assert.ok(match_reasons.some((r) => r.startsWith("2/4 skills match (core: React; secondary: Storybook) (+15)")));
});

test("scoreJob: denom floor — 1-skill JD full match can't spike (denom clamps to 3)", () => {
  const job = { ...zeroed, key_skills: ["React"] };
  const meta = { core_skills: ["React"] };
  const { score } = scoreJob(job, meta, MISS_TITLE);
  // weight 1 / denom 3 * 40 = 13.33 → 13, not 40
  assert.equal(score, 13);
});

test("scoreJob: 3-skill JD full match → full 40", () => {
  const job = { ...zeroed, key_skills: ["a", "b", "c"] };
  const meta = { core_skills: ["A", "B", "C"] };
  const { score } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 40);
});

test("scoreJob: 8-skill JD full match → full 40", () => {
  const jd = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const { score } = scoreJob({ ...zeroed, key_skills: jd }, { core_skills: jd }, MISS_TITLE);
  assert.equal(score, 40);
});

test("scoreJob: denom ceiling — laundry-list JD (9 skills) uses denom 8, ratio capped at 1", () => {
  const jd = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const all = scoreJob({ ...zeroed, key_skills: jd }, { core_skills: jd }, MISS_TITLE);
  assert.equal(all.score, 40); // 9/8 capped at 1
  const four = scoreJob(
    { ...zeroed, key_skills: jd },
    { core_skills: ["a", "b", "c", "d"] },
    MISS_TITLE
  );
  assert.equal(four.score, 20); // 4/8 * 40, not 4/9
});

test("scoreJob: empty key_skills list → +0 with 'No JD skills listed' reason", () => {
  const job = { ...zeroed, key_skills: [] };
  const meta = { core_skills: ["python"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "No JD skills listed (+0)"));
});

// ---- 2. Title relevance (15 pts) ----

test("scoreJob: title contains a domain keyword (case-insensitive) → +15", () => {
  const job = { ...zeroed, job_title: "Staff FRONTEND Engineer" };
  const { score, match_reasons } = scoreJob(job, {}, { domainKeywords: ["frontend"] });
  assert.equal(score, 15);
  assert.ok(match_reasons.some((r) => r === 'Title matches domain "frontend" (+15)'));
});

test("scoreJob: title misses all domain keywords → +0", () => {
  const job = { ...zeroed, job_title: "Backend Engineer" };
  const { score, match_reasons } = scoreJob(job, {}, { domainKeywords: ["frontend", "ui"] });
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "Title has no domain keyword (+0)"));
});

test("scoreJob: no domain keywords configured (legacy) → neutral +8", () => {
  const job = { ...zeroed, job_title: "Anything" };
  for (const opts of [undefined, {}, { domainKeywords: [] }]) {
    const { score, match_reasons } = scoreJob(job, {}, opts);
    assert.equal(score, 8);
    assert.ok(match_reasons.some((r) => r === "No domain keywords configured, title neutral (+8)"));
  }
});

// ---- 3. Seniority (15 pts) ----

test("scoreJob: seniority matches target (case-insensitive) → +15", () => {
  const job = { ...zeroed, seniority_level: "staff" };
  const meta = { target_seniority: ["Staff", "Lead"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 15);
  assert.ok(match_reasons.some((r) => r.includes("matches target seniority") && r.includes("+15")));
});

test("scoreJob: seniority does not match target → +0", () => {
  const job = { ...zeroed, seniority_level: "Junior" };
  const meta = { target_seniority: ["Staff", "Lead"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r.startsWith("Junior below target seniority (+0)")));
});

test("scoreJob: missing seniority_level renders as 'Unknown' in the no-match reason", () => {
  const { match_reasons } = scoreJob({ ...zeroed }, { target_seniority: ["Staff"] }, MISS_TITLE);
  assert.ok(match_reasons.some((r) => r.startsWith("Unknown below target seniority (+0)")));
});

// ---- 4. Work type + timezone (20 pts) ----

test("scoreJob: Remote + APAC → +20", () => {
  const job = { ...zeroed, work_type: "Remote", timezone_compatibility: "APAC" };
  const { score, match_reasons } = scoreJob(job, {}, MISS_TITLE);
  assert.equal(score, 20);
  assert.ok(match_reasons.some((r) => r === "Remote APAC timezone compatible (+20)"));
});

test("scoreJob: Remote + EMEA → +10 (partial)", () => {
  const job = { ...zeroed, work_type: "Remote", timezone_compatibility: "EMEA" };
  const { score, match_reasons } = scoreJob(job, {}, MISS_TITLE);
  assert.equal(score, 10);
  assert.ok(match_reasons.some((r) => r === "Remote EMEA timezone partial (+10)"));
});

test("scoreJob: Remote with unrecognized/missing timezone_compatibility → +10 (partial)", () => {
  const job = { ...zeroed, work_type: "Remote" };
  const { score, match_reasons } = scoreJob(job, {}, MISS_TITLE);
  assert.equal(score, 10);
  assert.ok(match_reasons.some((r) => r === "Remote, timezone unknown (+10)"));
});

test("scoreJob: Hybrid in home city (case/whitespace-insensitive) → +20", () => {
  const job = { ...zeroed, work_type: "Hybrid", location_city: "  BANGALORE  " };
  const meta = { location: "Bangalore" };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 20);
  assert.ok(match_reasons.some((r) => r === "Hybrid in Bangalore (+20)"));
});

test("scoreJob: On-site not in home city → +0", () => {
  const job = { ...zeroed, work_type: "On-site", location_city: "Chennai" };
  const meta = { location: "Bangalore" };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "On-site location fit (+0)"));
});

test("scoreJob: missing work_type → +0 with 'Unknown location fit' reason", () => {
  const { score, match_reasons } = scoreJob({ ...zeroed }, { location: "Bangalore" }, MISS_TITLE);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "Unknown location fit (+0)"));
});

test("scoreJob: On-site in the SECOND city of a multi-city home location → +20", () => {
  const job = { ...zeroed, work_type: "On-site", location_city: "Chennai" };
  const meta = { location: ["Bangalore", "Chennai"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 20);
  assert.ok(match_reasons.some((r) => r === "On-site in Bangalore/Chennai (+20)"));
});

test("scoreJob: On-site outside ALL cities of a multi-city home location → +0", () => {
  const job = { ...zeroed, work_type: "On-site", location_city: "Mumbai" };
  const meta = { location: ["Bangalore", "Chennai"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "On-site location fit (+0)"));
});

test("scoreJob: an invalid meta.location degrades to 'not home city' rather than throwing", () => {
  const job = { ...zeroed, work_type: "On-site", location_city: "Bangalore" };
  const meta = { location: ["Bangalore", 42] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "On-site location fit (+0)"));
});

// ---- 5. YoE fit (10 pts) ----

test("scoreJob: null years_of_experience → +5 neutral", () => {
  const job = { years_of_experience: null };
  const meta = { current_yoe: 3 };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 5);
  assert.ok(match_reasons.some((r) => r === "No YoE requirement, neutral (+5)"));
});

test("scoreJob: candidate YoE at/above required → +10", () => {
  const job = { years_of_experience: 5 };
  const meta = { current_yoe: 5 };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 10);
  assert.ok(match_reasons.some((r) => r === "YoE 5 meets 5 (+10)"));
});

test("scoreJob: yoe_is_minimum flag appends '+' in the meets-required reason", () => {
  const job = { years_of_experience: 5, yoe_is_minimum: true };
  const meta = { current_yoe: 7 };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 10);
  assert.ok(match_reasons.some((r) => r === "YoE 7 meets 5+ (+10)"));
});

test("scoreJob: candidate within 2 below required → +5 (partial)", () => {
  const job = { years_of_experience: 6 };
  const meta = { current_yoe: 4 };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 5);
  assert.ok(match_reasons.some((r) => r === "YoE 4 within 2 of 6 (+5)"));
});

test("scoreJob: candidate more than 2 below required → +0", () => {
  const job = { years_of_experience: 8 };
  const meta = { current_yoe: 3 };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "YoE 3 below 8 (+0)"));
});

// ---- 6. Zero-core-skill hard cap (50) ----

test("scoreJob: zero core matches with high logistics → capped at 50, 'Try panalam'", () => {
  // No core match, everything else maxed: skills 0 + title 15 + seniority 15 + wt 20 + yoe 10 = 60
  const job = {
    job_title: "Frontend Architect",
    seniority_level: "Staff",
    key_skills: ["Power Platform", "K2", "Automation"],
    work_type: "Remote",
    timezone_compatibility: "APAC",
    years_of_experience: 5,
  };
  const meta = { target_seniority: ["Staff"], core_skills: ["React"], current_yoe: 9 };
  const { score, excitement_level, match_reasons } = scoreJob(job, meta, {
    domainKeywords: ["frontend"],
  });
  assert.equal(score, 50);
  assert.equal(excitement_level, "Try panalam");
  assert.ok(match_reasons.some((r) => r === "No core skill match — capped at 50 (was 60)"));
});

test("scoreJob: secondary-only skill match is still capped (core is the gate)", () => {
  // skills: 1.5/3*40 = 20; + title 15 + seniority 15 + wt 20 + yoe 10 = 80 → 50
  const job = {
    job_title: "Frontend Architect",
    seniority_level: "Staff",
    key_skills: ["Vue.js", "Storybook", "Webpack"],
    work_type: "Remote",
    timezone_compatibility: "APAC",
    years_of_experience: 5,
  };
  const meta = {
    target_seniority: ["Staff"],
    core_skills: ["React"],
    secondary_skills: ["Vue.js", "Storybook", "Webpack"],
    current_yoe: 9,
  };
  const { score, excitement_level } = scoreJob(job, meta, { domainKeywords: ["frontend"] });
  assert.equal(score, 50);
  assert.equal(excitement_level, "Try panalam");
});

test("scoreJob: zero core matches below the cap → score unchanged, no cap reason", () => {
  const job = { ...zeroed, key_skills: ["Python"], work_type: "Remote" }; // skills 0 + wt 10
  const meta = { core_skills: ["React"] };
  const { score, match_reasons } = scoreJob(job, meta, MISS_TITLE);
  assert.equal(score, 10);
  assert.ok(!match_reasons.some((r) => r.includes("capped")));
});

test("scoreJob: a single core match disables the cap", () => {
  // skills: 1/3*40 = 13 + title 15 + seniority 15 + wt 20 + yoe 10 = 73 — above 50, kept
  const job = {
    job_title: "Staff Frontend Engineer",
    seniority_level: "Staff",
    key_skills: ["React", "K2", "Automation"],
    work_type: "Remote",
    timezone_compatibility: "APAC",
    years_of_experience: 5,
  };
  const meta = { target_seniority: ["Staff"], core_skills: ["React"], current_yoe: 9 };
  const { score } = scoreJob(job, meta, { domainKeywords: ["frontend"] });
  assert.equal(score, 73);
});

// ---- 7. Excitement bands (3 bands, boundaries) ----

// Band fixture: title + seniority + work type maxed (15 + 15 + 20), skills/YoE vary.
const bandJob = {
  job_title: "Staff Frontend Engineer",
  seniority_level: "Staff",
  work_type: "Remote",
  timezone_compatibility: "APAC",
};
const bandMeta = { target_seniority: ["Staff"], current_yoe: 5 };
const bandOpts = { domainKeywords: ["frontend"] };

test("scoreJob: total 85 → 'Vera level' (>=85 boundary)", () => {
  // skills 5/8*40 = 25; 25 + 15 + 15 + 20 + 10 = 85
  const jd = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const job = { ...bandJob, key_skills: jd, years_of_experience: 5 };
  const meta = { ...bandMeta, core_skills: ["a", "b", "c", "d", "e"] };
  const { score, excitement_level } = scoreJob(job, meta, bandOpts);
  assert.equal(score, 85);
  assert.equal(excitement_level, "Vera level");
});

test("scoreJob: total 84 → 'Kandipa podu' (just below 85 boundary)", () => {
  // skills 3/5*40 = 24; 24 + 15 + 15 + 20 + 10 = 84
  const job = { ...bandJob, key_skills: ["a", "b", "c", "d", "e"], years_of_experience: 5 };
  const meta = { ...bandMeta, core_skills: ["a", "b", "c"] };
  const { score, excitement_level } = scoreJob(job, meta, bandOpts);
  assert.equal(score, 84);
  assert.equal(excitement_level, "Kandipa podu");
});

test("scoreJob: total 65 → 'Kandipa podu' (>=65 boundary)", () => {
  // skills 1/8*40 = 5; 5 + 15 + 15 + 20 + 10 = 65
  const jd = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const job = { ...bandJob, key_skills: jd, years_of_experience: 5 };
  const meta = { ...bandMeta, core_skills: ["a"] };
  const { score, excitement_level } = scoreJob(job, meta, bandOpts);
  assert.equal(score, 65);
  assert.equal(excitement_level, "Kandipa podu");
});

test("scoreJob: total 64 → 'Try panalam' (just below 65 boundary)", () => {
  // skills 3/5*40 = 24; 24 + 15 + 15 + 10 (Remote EMEA) + 0 (YoE far below) = 64
  const job = {
    ...bandJob,
    timezone_compatibility: "EMEA",
    key_skills: ["a", "b", "c", "d", "e"],
    years_of_experience: 10,
  };
  const meta = { ...bandMeta, core_skills: ["a", "b", "c"] };
  const { score, excitement_level } = scoreJob(job, meta, bandOpts);
  assert.equal(score, 64);
  assert.equal(excitement_level, "Try panalam");
});

// ---- 8. Degenerate input ----

test("scoreJob: empty job + empty meta → neutral floors only (title 8 + YoE 5)", () => {
  const { score, excitement_level, match_reasons } = scoreJob({}, {});
  assert.equal(score, 13);
  assert.equal(excitement_level, "Try panalam");
  assert.equal(match_reasons.length, 5);
});
