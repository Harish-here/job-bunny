// scripts/title_filter.js — config-driven title gate. Reads filter_config.json once at load.
// Exports filterByTitle(title) → { pass: boolean, reason: string }.
//
// Evaluation order (short-circuit):
//   1. function.block  — any block term present → drop
//   2. seniority       — no seniority term present → drop
//   3. domain          — no domain term present → drop
//   4. pass (function.allow is informational only — used in reason string, not a gate)
//
// Multi-word terms are matched as full phrases (checked before single-word terms within each list).

import { readFileSync } from "node:fs";
import { paths } from "./config.js";

const FILTER_CONFIG = paths().filterConfig;
const _raw = JSON.parse(readFileSync(FILTER_CONFIG, "utf8"));
if (!_raw.title_filter) throw new Error(`${FILTER_CONFIG} is missing "title_filter" key — run /setup or add it manually.`);
const cfg = _raw.title_filter;

// Longest terms first — prevents a single-word prefix from shadowing a multi-word phrase.
const byLen = (a, b) => b.length - a.length;

// Compile a word-boundary regex; hyphens and spaces in multi-word terms are interchangeable.
const wordRe = (term) =>
  new RegExp(`\\b${term.replace(/[-\s]+/g, "[\\s-]+")}\\b`, "i");

const seniorityRes = [...cfg.seniority].sort(byLen).map((t) => ({ term: t, re: wordRe(t) }));
const domainRes    = [...cfg.domain].sort(byLen).map((t) => ({ term: t, re: wordRe(t) }));
const fnAllowRes   = [...cfg.function.allow].sort(byLen).map((t) => ({ term: t, re: wordRe(t) }));
const fnBlockRes   = [...cfg.function.block].sort(byLen).map((t) => ({ term: t, re: wordRe(t) }));

export function filterByTitle(title) {
  const t = (title || "").toLowerCase();

  // 1. Block gate
  for (const { term, re } of fnBlockRes) {
    if (re.test(t)) return { pass: false, reason: `blocked function: ${term}` };
  }

  // 2. Seniority gate
  const senMatch = seniorityRes.find(({ re }) => re.test(t));
  if (!senMatch) return { pass: false, reason: "no seniority match" };

  // 3. Domain gate
  const domMatch = domainRes.find(({ re }) => re.test(t));
  if (!domMatch) return { pass: false, reason: "no domain match" };

  // function.allow — informational only
  const fnMatch = fnAllowRes.find(({ re }) => re.test(t));
  const fnPart  = fnMatch ? `, function: ${fnMatch.term}` : "";

  return { pass: true, reason: `seniority: ${senMatch.term}, domain: ${domMatch.term}${fnPart}` };
}
