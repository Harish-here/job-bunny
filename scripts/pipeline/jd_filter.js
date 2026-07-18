// scripts/pipeline/jd_filter.js — config-driven filter engine, wired into extract.js's Stage A
// card gates and the Greenhouse/Keka ATS lanes (see extract/filters.js, ats_common.js). Two
// exports:
//
//   evaluate(jd, ctx, { severity, only }) — pure. jd → { drop, reasons, flags }.
//   loadFilterContext(profile)       — async. Reads config files → the `ctx` evaluate() needs.
//
// `only`: optional array of rule names. When provided (non-empty), ONLY those rules run —
// everything else is skipped, same as if the required fields were absent. Lets a caller that
// needs to run the avoid gate and the title gate at DIFFERENT points in its own pipeline (e.g.
// a company-capture step in between, as extract.js's Stage A does) call evaluate() twice with
// `only: ['avoid']` then `only: ['title']` instead of duplicating rule logic. Omitted/empty →
// all rules run (unchanged default behavior).
//
// Canonical JD model (callers adapt their own record shape into this before calling evaluate):
//   { title, company, skills:[], work_type, city, country, timezone, tz_bad }
// Card-altitude callers may only have { title, company, city } — any field can be `undefined`.
//
// Invariants:
//   - evaluate() is pure — no I/O, no network, no file reads. All preferences live in `ctx`,
//     which loadFilterContext() builds from profile config. ZERO preference literals in this
//     file (no city/country/region names) — that's what makes the engine reusable across profiles.
//   - Missing-field-skips, never drops: a rule whose `requires` fields are absent on `jd` is
//     skipped entirely (no reason, no flag) — an unknown value is not treated as a violation.
//   - `tz_bad === true` is an independent hard guard on the remote_timezone rule — it fires even
//     when `timezone` itself is absent, bypassing that rule's normal requires-gate.
//   - Severity controls only how SOFT violations are treated (ignored / flagged+kept / dropped);
//     HARD violations always drop, at every severity.
//   - reasons[]/flags[] are always complete — every rule runs regardless of an earlier drop, so
//     callers get the full picture, not just the first violation.

import { paths } from "../lib/config.js";
import { readJson } from "../lib/io.js";
import { normalizeName } from "../lib/util.js";
import { loadAvoid, isAvoided } from "./avoid.js";
import { filterByTitle } from "./title_filter.js";

const norm = (s) => normalizeName(s);
const normSkill = (s) => String(s).toLowerCase().trim();

// True when `jd[field]` is present and non-empty. `skills` is array-shaped; everything else
// in the canonical model is a scalar (string) — trimmed-empty counts as absent.
function isPresent(jd, field) {
  const v = jd[field];
  if (field === "skills") return Array.isArray(v) && v.length > 0;
  return v !== undefined && v !== null && String(v).trim() !== "";
}

// --- Rule checks. Each returns null (no violation — pass or n/a) or { violation, reason }
// where violation is "hard" or "soft". Requires-gating (field presence) is applied by the
// registry loop in evaluate(), NOT inside these checks — with the one deliberate exception of
// remote_timezone's tz_bad guard, which the loop special-cases to bypass gating entirely.

function checkAvoid(jd, ctx) {
  if (isAvoided(jd.company, ctx.avoid)) {
    return { violation: "hard", reason: `avoid-listed company: ${jd.company}` };
  }
  return null;
}

function checkTitle(jd) {
  const { pass, reason } = filterByTitle(jd.title);
  if (!pass) return { violation: "hard", reason };
  return null;
}

// Gate: only On-site/Hybrid work is location-constrained; Remote never triggers this rule.
function checkLocation(jd, ctx) {
  if (jd.work_type !== "On-site" && jd.work_type !== "Hybrid") return null;
  const cityNorm = norm(jd.city);
  const countryNorm = isPresent(jd, "country") ? norm(jd.country) : null;
  const match = (ctx.locations || []).some((entry) => {
    if (norm(entry.city) !== cityNorm) return false;
    if (countryNorm !== null && norm(entry.country) !== countryNorm) return false;
    return (entry.accept || []).includes(jd.work_type);
  });
  if (!match) {
    return { violation: "hard", reason: `${jd.work_type} in ${jd.city} not an accepted location` };
  }
  return null;
}

function checkRemoteCountry(jd, ctx) {
  if (jd.work_type !== "Remote") return null;
  const countryNorm = norm(jd.country);
  const eligible = (ctx.eligibleCountries || []).some((c) => norm(c) === countryNorm);
  if (!eligible) {
    return { violation: "hard", reason: `remote from ineligible country: ${jd.country}` };
  }
  return null;
}

// tz_bad is checked first and short-circuits — it is a hard guard independent of `timezone`
// presence (see the forceCheck special-case in the registry loop below).
function checkRemoteTimezone(jd, ctx) {
  if (jd.tz_bad === true) {
    return { violation: "hard", reason: "timezone incompatible (tz_bad)" };
  }
  const tzNorm = norm(jd.timezone);
  const acceptable = (ctx.timezones?.acceptable || []).map(norm);
  if (acceptable.includes(tzNorm)) return null;
  const borderline = (ctx.timezones?.borderline || []).map(norm);
  if (borderline.includes(tzNorm)) {
    return { violation: "soft", reason: `borderline timezone: ${jd.timezone}` };
  }
  return { violation: "hard", reason: `timezone not acceptable: ${jd.timezone}` };
}

function checkCoreSkill(jd, ctx) {
  const core = new Set((ctx.coreSkills || []).map(normSkill));
  const hasMatch = (jd.skills || []).some((s) => core.has(normSkill(s)));
  if (!hasMatch) {
    return { violation: "hard", reason: "no core skill match" };
  }
  return null;
}

// Registry — `requires` drives the missing-field-skip gate; `confidence` is documentation
// (the actual hard/soft split per-violation comes from what each check() returns, since
// remote_timezone can produce either depending on the timezone value).
const RULES = [
  { name: "avoid", requires: ["company"], confidence: "hard", check: checkAvoid },
  { name: "title", requires: ["title"], confidence: "hard", check: checkTitle },
  { name: "location", requires: ["work_type", "city"], confidence: "hard", check: checkLocation },
  { name: "remote_country", requires: ["work_type", "country"], confidence: "hard", check: checkRemoteCountry },
  { name: "remote_timezone", requires: ["timezone"], confidence: "mixed", check: checkRemoteTimezone },
  { name: "core_skill", requires: ["skills"], confidence: "hard", check: checkCoreSkill },
];

// Pure evaluator. severity: 'lenient' | 'normal' (default) | 'strict'. `only`: optional rule-name
// allowlist — see header comment.
export function evaluate(jd, ctx, { severity, only } = {}) {
  const sev = severity || "normal";
  const reasons = [];
  const flags = [];
  let hardHit = false;

  for (const rule of RULES) {
    if (only && !only.includes(rule.name)) continue;
    // tz_bad is its own guard — it must fire even when `timezone` is absent, so the
    // remote_timezone rule is force-run when tz_bad === true regardless of requires-gating.
    const forceCheck = rule.name === "remote_timezone" && jd.tz_bad === true;
    const ready = forceCheck || rule.requires.every((f) => isPresent(jd, f));
    if (!ready) continue;

    const result = rule.check(jd, ctx);
    if (!result) continue;

    if (result.violation === "hard") {
      hardHit = true;
      reasons.push(result.reason);
    } else if (result.violation === "soft") {
      if (sev === "lenient") continue; // soft violations ignored entirely — no flag, no drop
      flags.push(result.reason);
      if (sev === "strict") {
        hardHit = true;
        reasons.push(result.reason);
      }
    }
  }

  return { drop: hardHit, reasons, flags };
}

// Async context loader. `profile` optional — defaults to the resolved active profile (same
// precedence as paths()/resolveProfileName()). Tolerant of a filter_config.json that predates
// the geo keys (locations/home_country/remote.*) — a mid-migration profile must still load.
export async function loadFilterContext(profile) {
  const p = paths(profile);
  const [avoidCtx, cfg, meta] = await Promise.all([
    loadAvoid(p.avoid),
    readJson(p.filterConfig, "run /setup or add filter_config.json"),
    readJson(p.resumeMeta, "run generate_meta.js first"),
  ]);

  const locations = Array.isArray(cfg.locations) ? cfg.locations : [];
  const homeCountry = cfg.home_country || null;
  const remoteEligible = Array.isArray(cfg.remote?.eligible_countries) ? cfg.remote.eligible_countries : [];

  // eligibleCountries = union of home_country and remote.eligible_countries, deduped by
  // normalized compare but stored as the original (un-normalized) strings.
  const eligibleCountries = [];
  const seen = new Set();
  for (const c of [homeCountry, ...remoteEligible]) {
    if (!c) continue;
    const n = norm(c);
    if (seen.has(n)) continue;
    seen.add(n);
    eligibleCountries.push(c);
  }

  const timezones = {
    acceptable: Array.isArray(cfg.remote?.timezones?.acceptable) ? cfg.remote.timezones.acceptable : [],
    borderline: Array.isArray(cfg.remote?.timezones?.borderline) ? cfg.remote.timezones.borderline : [],
  };

  return {
    avoid: avoidCtx,
    locations,
    homeCountry,
    eligibleCountries,
    timezones,
    coreSkills: Array.isArray(meta.core_skills) ? meta.core_skills : [],
    secondarySkills: Array.isArray(meta.secondary_skills) ? meta.secondary_skills : [],
  };
}
