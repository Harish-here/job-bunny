// scripts/filter.js — Stage B filter. HARD DROPS ONLY.
//
// Location/work-type checks:
//   1. On-site AND location_city != Chennai
//   2. Remote AND the JD explicitly states incompatible hours
//      (structurer sets `timezone_incompatible: true`)
// Absence of timezone info NEVER drops — that is a ranking soft-signal only (rank.js).
//
// Title gate (v0.2.0 — short-circuit, top to bottom, case-insensitive on job_title):
//   1. Architect shortcut — "frontend architect" OR "ui architect" in title → PASS
//   2. Seniority gate    — no "staff" / "lead" / "principal" in title → DROP
//   3. Title check       — "frontend" OR "ui" in title → PASS
//   4. Skills fallback   — key_skills ∩ core_skills >= 3 → PASS
//   5. Default           → DROP
//
// (Stage A avoid-list drop runs earlier, in extract.js on card data.)
//
// jobs_raw.json + resume_meta.json → filtered_jobs.json.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeName } from "./util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN = join(ROOT, "jobs_raw.json");
const META = join(ROOT, "resume_meta.json");
const OUT = join(ROOT, "filtered_jobs.json");

const normSkill = (s) => String(s).toLowerCase().trim();

// Returns a drop-reason string, or null to keep.
export function dropReason(job, coreSkills) {
  // --- Location / work-type checks ---
  const workType = job.work_type;
  if (workType === "On-site" && normalizeName(job.location_city) !== "chennai") {
    return `on-site outside Chennai (${job.location_city})`;
  }
  if (workType === "Remote" && job.timezone_incompatible === true) {
    return "remote with explicit incompatible hours";
  }

  // --- Title gate ---
  const title = (job.job_title || "").toLowerCase();

  // 1. Architect shortcut — frontend/ui architect passes before seniority gate
  if (title.includes("frontend architect") || title.includes("ui architect")) return null;

  // 2. Seniority gate
  if (!title.includes("staff") && !title.includes("lead") && !title.includes("principal")) {
    return `title missing staff/lead/principal (${job.job_title})`;
  }

  // 3. Title check — \bui\b avoids matching "fluid", "studio", "equity", etc.
  if (title.includes("frontend") || /\bui\b/.test(title)) return null;

  // 4. Skills fallback — key_skills ∩ core_skills >= 3
  const coreSet = new Set((coreSkills || []).map(normSkill));
  const overlap = (job.key_skills || []).filter((s) => coreSet.has(normSkill(s))).length;
  if (overlap >= 3) return null;

  // 5. Default drop
  return `non-frontend title, ${overlap}/3 core skills matched (${job.job_title})`;
}

async function main() {
  let jobs, meta;
  try {
    jobs = JSON.parse(await readFile(IN, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${IN}: ${err.message}`);
  }
  try {
    meta = JSON.parse(await readFile(META, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${META} (run generate_meta.js first): ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  const coreSkills = meta.core_skills || [];
  const kept = [];
  let dropped = 0;
  for (const job of jobs) {
    const reason = dropReason(job, coreSkills);
    if (reason) {
      dropped++;
      console.log(`[filter] drop "${job.job_title}" @ ${job.company_name} — ${reason}`);
    } else {
      kept.push(job);
    }
  }

  await writeFile(OUT, JSON.stringify(kept, null, 2) + "\n");
  console.log(`[filter] ${jobs.length} in → ${kept.length} kept, ${dropped} dropped → filtered_jobs.json`);
}

main().catch((err) => {
  console.error(`[filter] FAILED: ${err.message}`);
  process.exit(1);
});
