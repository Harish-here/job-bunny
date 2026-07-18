// scripts/pipeline/jd_filter.test.js — pure unit tests for evaluate(). ctx objects are built
// inline; evaluate() never touches the filesystem so no fixture profile is needed for it.
// filterByTitle (imported by jd_filter.js) DOES read filter_config.json at module load, so a
// minimal fixture profile is set up before jd_filter.js is imported, matching the pattern used
// by filter.test.js / title_filter.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../lib/config.js";
import { normalizeName } from "../lib/util.js";

const FIXTURE_PROFILE = "__test_jdfilter__";
const FIXTURE_DIR = join(ROOT, "profiles", FIXTURE_PROFILE);

await mkdir(FIXTURE_DIR, { recursive: true });
// Permissive title-filter config so titles used below always pass the title gate unless a
// test is specifically exercising the title rule.
await writeFile(
  join(FIXTURE_DIR, "filter_config.json"),
  JSON.stringify({
    title_filter: {
      seniority: ["staff", "senior", "lead"],
      domain: ["engineer", "engineering", "frontend"],
      function: { allow: [], block: ["manager"] },
    },
  })
);
process.env.JOBBUNNY_PROFILE = FIXTURE_PROFILE;

const { evaluate } = await import("./jd_filter.js");

// --- ctx builders -----------------------------------------------------------------------

function baseCtx(overrides = {}) {
  return {
    // "Corp" is stripped as a legal-suffix by normalizeName (see lib/util.js SUFFIXES) — the
    // Set here mirrors what loadAvoid()/avoid.md real parsing would store: normalizeName(raw).
    avoid: { companies: new Set([normalizeName("Shady Corp")]), aliases: new Map() },
    locations: [
      { city: "Bengaluru", country: "India", accept: ["On-site", "Hybrid"] },
      { city: "Chennai", country: "India", accept: ["Hybrid"] },
    ],
    homeCountry: "India",
    eligibleCountries: ["India", "United States"],
    timezones: { acceptable: ["IST"], borderline: ["EST"] },
    coreSkills: ["React", "TypeScript"],
    secondarySkills: ["Vue.js"],
    ...overrides,
  };
}

const PASS_TITLE = "Senior Frontend Engineer";

// --- avoid rule ---------------------------------------------------------------------------

test("avoid: drops a company on the avoid list", () => {
  const jd = { title: PASS_TITLE, company: "Shady Corp" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /avoid-listed company/);
});

test("avoid: passes a company not on the avoid list", () => {
  const jd = { title: PASS_TITLE, company: "Acme Inc" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
});

test("avoid: skipped (no drop) when company is absent", () => {
  const jd = { title: PASS_TITLE };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
});

// --- title rule ----------------------------------------------------------------------------

test("title: drops when filterByTitle fails, reason is filterByTitle's reason", () => {
  const jd = { title: "Engineering Manager", company: "Acme" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.equal(reasons[0], "blocked function: manager");
});

test("title: passes a title that clears the gate", () => {
  const jd = { title: PASS_TITLE, company: "Acme" };
  const { drop } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
});

test("title: skipped when title is absent", () => {
  const jd = { company: "Acme" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
});

// --- location rule -------------------------------------------------------------------------

test("location: On-site in a matching home city passes", () => {
  const jd = { title: PASS_TITLE, work_type: "On-site", city: "Bengaluru", country: "India" };
  const { drop } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
});

test("location: case/space-insensitive city match passes", () => {
  const jd = { title: PASS_TITLE, work_type: "On-site", city: "  bengaluru " };
  const { drop } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
});

test("location: On-site in a non-home city drops", () => {
  const jd = { title: PASS_TITLE, work_type: "On-site", city: "Mumbai" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /On-site in Mumbai/);
});

test("location: Hybrid respects the per-city accept list (Bengaluru accepts Hybrid)", () => {
  const jd = { title: PASS_TITLE, work_type: "Hybrid", city: "Bengaluru" };
  const { drop } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
});

test("location: On-site rejected in a city whose accept list only has Hybrid (Chennai)", () => {
  const jd = { title: PASS_TITLE, work_type: "On-site", city: "Chennai" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /On-site in Chennai/);
});

test("location: Remote work_type never triggers this rule even with a bad city", () => {
  const jd = { title: PASS_TITLE, work_type: "Remote", city: "Nowhere", country: "India" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
});

test("location: skipped (partial card model) when work_type is absent", () => {
  const jd = { title: PASS_TITLE, company: "Acme", city: "Mumbai" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
});

// --- remote_country rule --------------------------------------------------------------------

test("remote_country: drops remote work from an ineligible country", () => {
  const jd = { title: PASS_TITLE, work_type: "Remote", country: "Nigeria" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /ineligible country/);
});

test("remote_country: passes remote work from an eligible country", () => {
  const jd = { title: PASS_TITLE, work_type: "Remote", country: "United States" };
  const { drop } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
});

test("remote_country: skipped when country is absent", () => {
  const jd = { title: PASS_TITLE, work_type: "Remote" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
});

// --- remote_timezone rule + severity matrix --------------------------------------------------

test("remote_timezone: acceptable timezone passes at every severity", () => {
  const jd = { title: PASS_TITLE, timezone: "IST" };
  for (const severity of ["lenient", "normal", "strict"]) {
    const { drop, flags } = evaluate(jd, baseCtx(), { severity });
    assert.equal(drop, false, severity);
    assert.deepEqual(flags, [], severity);
  }
});

test("remote_timezone: hard-drops an unacceptable timezone at every severity", () => {
  const jd = { title: PASS_TITLE, timezone: "PST" };
  for (const severity of ["lenient", "normal", "strict"]) {
    const { drop, reasons } = evaluate(jd, baseCtx(), { severity });
    assert.equal(drop, true, severity);
    assert.match(reasons.join(" "), /timezone not acceptable/);
  }
});

test("remote_timezone: borderline timezone is ignored at lenient (no flag, no drop)", () => {
  const jd = { title: PASS_TITLE, timezone: "EST" };
  const { drop, flags, reasons } = evaluate(jd, baseCtx(), { severity: "lenient" });
  assert.equal(drop, false);
  assert.deepEqual(flags, []);
  assert.deepEqual(reasons, []);
});

test("remote_timezone: borderline timezone is flagged and kept at normal (default)", () => {
  const jd = { title: PASS_TITLE, timezone: "EST" };
  const { drop, flags } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.match(flags.join(" "), /borderline timezone/);
});

test("remote_timezone: borderline timezone is dropped at strict", () => {
  const jd = { title: PASS_TITLE, timezone: "EST" };
  const { drop, reasons } = evaluate(jd, baseCtx(), { severity: "strict" });
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /borderline timezone/);
});

test("remote_timezone: tz_bad:true hard-drops at all severities, even with timezone absent", () => {
  const jd = { title: PASS_TITLE, tz_bad: true };
  for (const severity of ["lenient", "normal", "strict"]) {
    const { drop, reasons } = evaluate(jd, baseCtx(), { severity });
    assert.equal(drop, true, severity);
    assert.match(reasons.join(" "), /tz_bad/);
  }
});

test("remote_timezone: tz_bad:true hard-drops even when timezone is otherwise acceptable", () => {
  const jd = { title: PASS_TITLE, timezone: "IST", tz_bad: true };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /tz_bad/);
});

test("remote_timezone: skipped when both timezone and tz_bad are absent", () => {
  const jd = { title: PASS_TITLE, company: "Acme" };
  const { drop, reasons, flags } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
  assert.deepEqual(flags, []);
});

// --- core_skill rule -------------------------------------------------------------------------

test("core_skill: zero overlap with core skills drops", () => {
  const jd = { title: PASS_TITLE, skills: ["Python", "Django"] };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /no core skill match/);
});

test("core_skill: one core-skill match passes", () => {
  const jd = { title: PASS_TITLE, skills: ["Python", "React"] };
  const { drop } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
});

test("core_skill: case-insensitive match passes", () => {
  const jd = { title: PASS_TITLE, skills: ["typescript"] };
  const { drop } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
});

test("core_skill: skipped when skills is absent or empty", () => {
  const jdAbsent = { title: PASS_TITLE };
  const jdEmpty = { title: PASS_TITLE, skills: [] };
  for (const jd of [jdAbsent, jdEmpty]) {
    const { drop, reasons } = evaluate(jd, baseCtx());
    assert.equal(drop, false);
    assert.deepEqual(reasons, []);
  }
});

// --- partial (card-altitude) model ------------------------------------------------------------

test("partial card model {title, company, city}: only avoid/title rules can fire, rest skipped", () => {
  const jd = { title: PASS_TITLE, company: "Acme", city: "Mumbai" };
  const { drop, reasons, flags } = evaluate(jd, baseCtx());
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
  assert.deepEqual(flags, []);
});

test("partial card model still hard-drops on an avoided company", () => {
  const jd = { title: PASS_TITLE, company: "Shady Corp", city: "Mumbai" };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /avoid-listed company/);
});

// --- reasons/flags completeness ---------------------------------------------------------------

test("evaluate collects reasons from multiple independently-firing hard rules", () => {
  const jd = {
    title: "Engineering Manager", // fails title
    company: "Shady Corp", // fails avoid
    work_type: "On-site",
    city: "Mumbai", // fails location
  };
  const { drop, reasons } = evaluate(jd, baseCtx());
  assert.equal(drop, true);
  assert.equal(reasons.length, 3);
});

test.after(async () => {
  delete process.env.JOBBUNNY_PROFILE;
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});
