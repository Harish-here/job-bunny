// scripts/rank.test.js — node:test unit tests for the pure scorer scoreJob() (no I/O,
// no network — fast, deterministic). Run with:
//   node --test scripts/rank.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreJob } from "./rank.js";

// Skills helper: jd has `n` entries ("skill0".."skill{n-1}"); core_skills is the first
// `matched` of them (case varied to also exercise case-insensitive matching). Since the
// skills component is (matched/jd.length)*30, choosing jd.length === 30 makes the raw
// component equal to `matched` exactly (no rounding ambiguity) — used for the excitement
// band tests where we need exact, predictable totals.
function skillSet(n, matched) {
  const jd = Array.from({ length: n }, (_, i) => `Skill${i}`);
  const core = jd.slice(0, matched).map((s) => s.toUpperCase());
  return { jd, core };
}

// ---- 1. Seniority (30 pts) ----

test("scoreJob: seniority matches target (case-insensitive) → +30", () => {
  const job = { seniority_level: "staff", years_of_experience: 100 };
  const meta = { target_seniority: ["Staff", "Lead"] };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 30);
  assert.ok(match_reasons.some((r) => r.includes("matches target seniority") && r.includes("+30")));
});

test("scoreJob: seniority does not match target → +0", () => {
  const job = { seniority_level: "Junior", years_of_experience: 100 };
  const meta = { target_seniority: ["Staff", "Lead"] };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r.startsWith("Junior below target seniority (+0)")));
});

test("scoreJob: missing seniority_level renders as 'Unknown' in the no-match reason", () => {
  const job = {};
  const meta = { target_seniority: ["Staff"] };
  const { match_reasons } = scoreJob(job, meta);
  assert.ok(match_reasons.some((r) => r.startsWith("Unknown below target seniority (+0)")));
});

// ---- 2. Skills overlap (30 pts) ----

test("scoreJob: 0 of N skills match → +0", () => {
  const job = { key_skills: ["Python", "Java", "Go"], years_of_experience: 100 };
  const meta = { core_skills: ["Rust"] };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r.startsWith("0/3 skills match (+0)")));
});

test("scoreJob: 1/3 skills match → Math.round(1/3 * 30) = 10", () => {
  const job = { key_skills: ["Python", "Java", "Go"], years_of_experience: 100 };
  const meta = { core_skills: ["python"] };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 10);
  assert.ok(match_reasons.some((r) => r.startsWith("1/3 skills match: Python (+10)")));
});

test("scoreJob: 3/8 skills match → Math.round(11.25) = 11 (non-exact rounding case)", () => {
  const job = { key_skills: ["a", "b", "c", "d", "e", "f", "g", "h"], years_of_experience: 100 };
  const meta = { core_skills: ["A", "B", "C"] };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 11);
  assert.ok(match_reasons.some((r) => r.startsWith("3/8 skills match: a, b, c (+11)")));
});

test("scoreJob: all skills match → +30", () => {
  const job = { key_skills: ["Python", "Java"], years_of_experience: 100 };
  const meta = { core_skills: ["python", "java"] };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 30);
  assert.ok(match_reasons.some((r) => r.startsWith("2/2 skills match: Python, Java (+30)")));
});

test("scoreJob: empty key_skills list → +0 with 'No JD skills listed' reason", () => {
  const job = { key_skills: [], years_of_experience: 100 };
  const meta = { core_skills: ["python"] };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "No JD skills listed (+0)"));
});

// ---- 3. Work type + timezone (20 pts) ----

test("scoreJob: Remote + APAC → +20", () => {
  const job = { work_type: "Remote", timezone_compatibility: "APAC", years_of_experience: 100 };
  const meta = {};
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 20);
  assert.ok(match_reasons.some((r) => r === "Remote APAC timezone compatible (+20)"));
});

test("scoreJob: Remote + EMEA → +10 (partial)", () => {
  const job = { work_type: "Remote", timezone_compatibility: "EMEA", years_of_experience: 100 };
  const meta = {};
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 10);
  assert.ok(match_reasons.some((r) => r === "Remote EMEA timezone partial (+10)"));
});

test("scoreJob: Remote with unrecognized/missing timezone_compatibility → +10 (partial)", () => {
  const job = { work_type: "Remote", years_of_experience: 100 };
  const meta = {};
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 10);
  assert.ok(match_reasons.some((r) => r === "Remote, timezone unknown (+10)"));
});

test("scoreJob: Hybrid in home city (case/whitespace-insensitive) → +20", () => {
  const job = { work_type: "Hybrid", location_city: "  BANGALORE  ", years_of_experience: 100 };
  const meta = { location: "Bangalore" };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 20);
  assert.ok(match_reasons.some((r) => r === "Hybrid in Bangalore (+20)"));
});

test("scoreJob: On-site not in home city → +0", () => {
  const job = { work_type: "On-site", location_city: "Chennai", years_of_experience: 100 };
  const meta = { location: "Bangalore" };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "On-site location fit (+0)"));
});

test("scoreJob: missing work_type → +0 with 'Unknown location fit' reason", () => {
  const job = { years_of_experience: 100 };
  const meta = { location: "Bangalore" };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "Unknown location fit (+0)"));
});

// ---- 4. YoE fit (20 pts) ----

test("scoreJob: null years_of_experience → +20 with 'No YoE requirement' reason", () => {
  const job = { years_of_experience: null };
  const meta = { current_yoe: 3 };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 20);
  assert.ok(match_reasons.some((r) => r === "No YoE requirement (+20)"));
});

test("scoreJob: candidate YoE at/above required → +20", () => {
  const job = { years_of_experience: 5 };
  const meta = { current_yoe: 5 };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 20);
  assert.ok(match_reasons.some((r) => r === "YoE 5 meets 5 (+20)"));
});

test("scoreJob: yoe_is_minimum flag appends '+' in the meets-required reason", () => {
  const job = { years_of_experience: 5, yoe_is_minimum: true };
  const meta = { current_yoe: 7 };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 20);
  assert.ok(match_reasons.some((r) => r === "YoE 7 meets 5+ (+20)"));
});

test("scoreJob: candidate within 2 below required → +10 (partial)", () => {
  const job = { years_of_experience: 6 };
  const meta = { current_yoe: 4 };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 10);
  assert.ok(match_reasons.some((r) => r === "YoE 4 within 2 of 6 (+10)"));
});

test("scoreJob: candidate more than 2 below required → +0", () => {
  const job = { years_of_experience: 8 };
  const meta = { current_yoe: 3 };
  const { score, match_reasons } = scoreJob(job, meta);
  assert.equal(score, 0);
  assert.ok(match_reasons.some((r) => r === "YoE 3 below 8 (+0)"));
});

// ---- 5. Excitement bands (boundaries) ----

test("scoreJob: total 85 → 'Vera level' (>=85 boundary)", () => {
  const { jd, core } = skillSet(30, 15);
  const job = {
    seniority_level: "Staff",
    key_skills: jd,
    work_type: "Hybrid",
    location_city: "Bangalore",
    years_of_experience: 5,
  };
  const meta = { target_seniority: ["Staff"], core_skills: core, location: "Bangalore", current_yoe: 5 };
  const { score, excitement_level } = scoreJob(job, meta);
  assert.equal(score, 85);
  assert.equal(excitement_level, "Vera level");
});

test("scoreJob: total 84 → 'Kandipa podu' (just below 85 boundary)", () => {
  const { jd, core } = skillSet(30, 14);
  const job = {
    seniority_level: "Staff",
    key_skills: jd,
    work_type: "Hybrid",
    location_city: "Bangalore",
    years_of_experience: 5,
  };
  const meta = { target_seniority: ["Staff"], core_skills: core, location: "Bangalore", current_yoe: 5 };
  const { score, excitement_level } = scoreJob(job, meta);
  assert.equal(score, 84);
  assert.equal(excitement_level, "Kandipa podu");
});

test("scoreJob: total 65 → 'Kandipa podu' (>=65 boundary)", () => {
  const { jd, core } = skillSet(30, 5);
  const job = {
    seniority_level: "Staff",
    key_skills: jd,
    work_type: "Remote",
    timezone_compatibility: "EMEA",
    years_of_experience: 5,
  };
  const meta = { target_seniority: ["Staff"], core_skills: core, current_yoe: 5 };
  const { score, excitement_level } = scoreJob(job, meta);
  assert.equal(score, 65);
  assert.equal(excitement_level, "Kandipa podu");
});

test("scoreJob: total 64 → 'Try panalam' (just below 65 boundary)", () => {
  const { jd, core } = skillSet(30, 4);
  const job = {
    seniority_level: "Staff",
    key_skills: jd,
    work_type: "Remote",
    timezone_compatibility: "EMEA",
    years_of_experience: 5,
  };
  const meta = { target_seniority: ["Staff"], core_skills: core, current_yoe: 5 };
  const { score, excitement_level } = scoreJob(job, meta);
  assert.equal(score, 64);
  assert.equal(excitement_level, "Try panalam");
});

test("scoreJob: total 45 → 'Try panalam' (>=45 boundary)", () => {
  const { jd, core } = skillSet(30, 5);
  const job = {
    seniority_level: "Junior",
    key_skills: jd,
    work_type: "Hybrid",
    location_city: "Bangalore",
    years_of_experience: 5,
  };
  const meta = { target_seniority: ["Staff"], core_skills: core, location: "Bangalore", current_yoe: 5 };
  const { score, excitement_level } = scoreJob(job, meta);
  assert.equal(score, 45);
  assert.equal(excitement_level, "Try panalam");
});

test("scoreJob: total 44 → 'Okay tha' (just below 45 boundary)", () => {
  const { jd, core } = skillSet(30, 4);
  const job = {
    seniority_level: "Junior",
    key_skills: jd,
    work_type: "Hybrid",
    location_city: "Bangalore",
    years_of_experience: 5,
  };
  const meta = { target_seniority: ["Staff"], core_skills: core, location: "Bangalore", current_yoe: 5 };
  const { score, excitement_level } = scoreJob(job, meta);
  assert.equal(score, 44);
  assert.equal(excitement_level, "Okay tha");
});

test("scoreJob: total 25 → 'Okay tha' (>=25 boundary)", () => {
  const { jd, core } = skillSet(30, 15);
  const job = {
    seniority_level: "Junior",
    key_skills: jd,
    work_type: "Remote",
    timezone_compatibility: "EMEA",
    years_of_experience: 8,
  };
  const meta = { target_seniority: ["Staff"], core_skills: core, current_yoe: 3 };
  const { score, excitement_level } = scoreJob(job, meta);
  assert.equal(score, 25);
  assert.equal(excitement_level, "Okay tha");
});

test("scoreJob: total 24 → 'Deal la vidu' (just below 25 boundary)", () => {
  const { jd, core } = skillSet(30, 14);
  const job = {
    seniority_level: "Junior",
    key_skills: jd,
    work_type: "Remote",
    timezone_compatibility: "EMEA",
    years_of_experience: 8,
  };
  const meta = { target_seniority: ["Staff"], core_skills: core, current_yoe: 3 };
  const { score, excitement_level } = scoreJob(job, meta);
  assert.equal(score, 24);
  assert.equal(excitement_level, "Deal la vidu");
});
