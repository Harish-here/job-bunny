// scripts/setup/generate_meta.js — resume.json → resume_meta.json by DIRECT field copy.
// Gate 4: no inference. core/secondary skills (and every other meta field) are explicit
// fields in resume.json that copy straight through. Output is deterministic & byte-identical
// on re-run (fixed key order, stable formatting). Re-run only when resume.json changes.

import { isMain } from "../lib/cli.js";
import { readJson, writeJson } from "../lib/io.js";
import { paths, resolveProfileName } from "../lib/config.js";

const IN = paths().resume;
const OUT = paths().resumeMeta;

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

async function main() {
  console.log(`[meta] profile=${resolveProfileName()}`);
  const resume = await readJson(IN);

  const missing = FIELDS.filter((f) => !(f in resume));
  if (missing.length) {
    throw new Error(
      `resume.json is missing required field(s): ${missing.join(", ")}. ` +
        `Gate 4 requires these explicit fields (no inference).`
    );
  }

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
