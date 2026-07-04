// scripts/assemble.js — merges LLM decisions (markdown table) with passthrough fields → jobs_raw.json.
// Reads jobs_raw_decisions.md + structure_passthrough.json, merges on job_id.
//
// Decisions markdown — 11 fixed columns, header row required:
//   | job_id | title | company | seniority | city | work_type | yoe | yoe_min | skills | tz | tz_bad |
//   |--------|-------|---------|-----------|------|-----------|-----|---------|--------|-----|--------|
//   empty cell = null · booleans: true/false · skills: semicolon-separated · pipe in value: ｜

import { readFile, writeFile } from "node:fs/promises";
import { paths } from "./config.js";

const IN_DECISIONS  = paths().decisions;
const IN_PASSTHROUGH = paths().structurePassthrough;
const OUT = paths().jobsRaw;

const REQUIRED_FIELDS = [
  "job_id", "job_title", "company_name", "seniority_level",
  "location_city", "work_type", "key_skills", "job_url", "date_found",
];

function parseDecisionsMd(md) {
  const lines = md.split("\n").map((l) => l.trim()).filter(Boolean);

  const headerIdx = lines.findIndex((l) => l.startsWith("|") && l.includes("job_id"));
  if (headerIdx === -1) throw new Error("header row (containing job_id) not found");

  // skip header + separator
  const dataLines = lines.slice(headerIdx + 2).filter((l) => l.startsWith("|"));
  if (!dataLines.length) throw new Error("no data rows found");

  return dataLines.map((line, i) => {
    const rowNum = i + 1;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 11)
      throw new Error(`row ${rowNum}: expected 11 cells, got ${cells.length} — escape pipes in values with ｜`);

    const str  = (n) => cells[n] === "" ? null : cells[n].replace(/｜/g, "|");
    const num  = (n) => {
      if (cells[n] === "") return null;
      const v = Number(cells[n]);
      if (Number.isNaN(v)) throw new Error(`row ${rowNum} col ${n}: expected number, got "${cells[n]}"`);
      return v;
    };
    const bool = (n) => cells[n] === "true";
    const arr  = (n) =>
      cells[n] === ""
        ? []
        : cells[n].split(";").map((s) => s.trim().replace(/｜/g, "|")).filter(Boolean);

    return {
      job_id:                 str(0),
      job_title:              str(1),
      company_name:           str(2),
      seniority_level:        str(3),
      location_city:          str(4),
      work_type:              str(5),
      years_of_experience:    num(6),
      yoe_is_minimum:         bool(7),
      key_skills:             arr(8),
      timezone_compatibility: str(9),
      timezone_incompatible:  bool(10),
    };
  });
}

async function main() {
  let rawDecisions, rawPassthrough;
  try {
    [rawDecisions, rawPassthrough] = await Promise.all([
      readFile(IN_DECISIONS, "utf8"),
      readFile(IN_PASSTHROUGH, "utf8"),
    ]);
  } catch (err) {
    throw new Error(`Cannot read input files: ${err.message}`);
  }

  let decisions;
  try { decisions = parseDecisionsMd(rawDecisions); } catch (err) {
    throw new Error(`Cannot parse ${IN_DECISIONS}: ${err.message}`);
  }

  let passthrough;
  try { passthrough = JSON.parse(rawPassthrough); } catch (err) {
    throw new Error(`Cannot parse ${IN_PASSTHROUGH}: ${err.message}`);
  }
  if (!Array.isArray(passthrough)) throw new Error(`${IN_PASSTHROUGH} must be a JSON array`);

  const ptMap = new Map(passthrough.map((p) => [p.job_id, p]));

  const merged = decisions.map((d, i) => {
    const pt = ptMap.get(d.job_id);
    if (!pt) throw new Error(`No passthrough entry for job_id "${d.job_id}" (decision row ${i + 1})`);
    const job = { ...d, job_url: pt.job_url, date_found: pt.date_found, source_query_url: pt.source_query_url };

    const missing = REQUIRED_FIELDS.filter((f) => job[f] === undefined || job[f] === null);
    if (missing.length) throw new Error(`job_id "${d.job_id}" missing required fields: ${missing.join(", ")}`);
    return job;
  });

  await writeFile(OUT, JSON.stringify(merged, null, 2) + "\n");
  console.log(`[assemble] ${merged.length} jobs merged → jobs_raw.json`);
}

main().catch((err) => {
  console.error(`[assemble] FAILED: ${err.message}`);
  process.exit(1);
});
