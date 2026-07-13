// scripts/setup/generate_meta.js — resume.json → resume_meta.json by DIRECT field copy.
// Gate 4: no inference. core/secondary skills (and every other meta field) are explicit
// fields in resume.json that copy straight through. Output is deterministic & byte-identical
// on re-run (fixed key order, stable formatting). Re-run only when resume.json changes.
//
// Shape-validates every field on the way through (not just presence) — a wrong shape here
// (e.g. `location` as something other than a string/string[]) used to pass straight through
// to filter.js/rank.js and fail silently there instead of loudly at the source.

import { isMain } from "../lib/cli.js";
import { readJson, writeJson } from "../lib/io.js";
import { homeLocations } from "../lib/util.js";
import { paths, resolveProfileName } from "../lib/config.js";

// The meta shape, in fixed order. Each entry copies straight from resume.json.
const FIELDS = [
  "current_yoe",
  "target_seniority",
  "core_skills",
  "secondary_skills",
  "preferred_work_type",
  "location",
  "domain_experience",
  "usp",
];

const ARRAY_OF_STRINGS_FIELDS = [
  "target_seniority",
  "core_skills",
  "secondary_skills",
  "preferred_work_type",
  "domain_experience",
  "usp",
];

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isArrayOfNonEmptyStrings = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);

// Pure — throws a single Error listing every shape problem found, or returns nothing.
export function validateFields(resume) {
  const missing = FIELDS.filter((f) => !(f in resume));
  if (missing.length) {
    throw new Error(
      `resume.json is missing required field(s): ${missing.join(", ")}. ` +
        `Gate 4 requires these explicit fields (no inference).`
    );
  }

  const errors = [];
  if (typeof resume.current_yoe !== "number" || !Number.isFinite(resume.current_yoe) || resume.current_yoe < 0) {
    errors.push(`current_yoe must be a non-negative number, got ${JSON.stringify(resume.current_yoe)}`);
  }
  for (const f of ARRAY_OF_STRINGS_FIELDS) {
    if (!isArrayOfNonEmptyStrings(resume[f])) {
      errors.push(`${f} must be a non-empty array of non-empty strings, got ${JSON.stringify(resume[f])}`);
    }
  }
  try {
    homeLocations(resume.location);
  } catch (err) {
    errors.push(`location: ${err.message}`);
  }
  if (errors.length) {
    throw new Error(`resume.json has invalid field(s):\n  - ${errors.join("\n  - ")}`);
  }
}

async function main() {
  console.log(`[meta] profile=${resolveProfileName()}`);
  const { resume: IN, resumeMeta: OUT } = paths();
  const resume = await readJson(IN);
  validateFields(resume);

  const meta = {};
  for (const f of FIELDS) meta[f] = resume[f];

  await writeJson(OUT, meta);
  console.log(`[meta] wrote resume_meta.json (${FIELDS.length} fields, direct copy)`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[meta] FAILED: ${err.message}`);
    process.exit(1);
  });
}
