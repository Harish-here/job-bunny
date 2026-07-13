// scripts/pipeline/compress.js — pre-LLM compression stage.
// Reads jobs_raw_text.json, sanitises raw_text,
// and writes structure_input.md (compact markdown table) + structure_passthrough.json.
// Title filtering already happened in extract.js (Stage A); no second gate needed here.

import { readFile, writeFile } from "node:fs/promises";
import { paths } from "../lib/config.js";

const IN = paths().jobsRawText;
const OUT_MD = paths().structureInput;
const OUT_PT = paths().structurePassthrough;

const escapePipe = (v) => (v == null ? "" : String(v).replace(/\|/g, "｜"));

function sanitiseRawText(raw) {
  return raw
    .replace(/^about the job\s*/i, "")   // strip boilerplate header
    .replace(/\n+/g, " ")                // collapse newlines → space
    .replace(/\|/g, "｜")               // escape pipe chars for markdown table
    .trim()
    .slice(0, 700);
}

async function main() {
  let jobs;
  try {
    jobs = JSON.parse(await readFile(IN, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${IN}: ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  const today = new Date().toISOString().slice(0, 10);
  const kept = [];
  const passthrough = [];

  for (const job of jobs) {
    if (!job.job_id) {
      console.warn(`[compress] skip: no job_id for "${job.card_title}" @ ${job.card_company}`);
      continue;
    }
    kept.push(job);
    passthrough.push({
      job_id: job.job_id,
      job_url: job.job_url,
      date_found: job.date_found,
      source_query_url: job.source_query_url,
    });
  }

  // Build markdown table
  const header = `# Structure Input — ${today} | ${kept.length}/${jobs.length} jobs\n\n| # | id | card_title | company | location | raw_text |\n|---|----|-----------|---------|----------|----------|\n`;
  const rows = kept.map((job, i) => {
    const raw = sanitiseRawText(job.raw_text || "");
    return `| ${i + 1} | ${job.job_id} | ${escapePipe(job.card_title)} | ${escapePipe(job.card_company)} | ${escapePipe(job.card_location)} | ${raw} |`;
  });
  const md = header + rows.join("\n") + "\n";

  await Promise.all([
    writeFile(OUT_MD, md),
    writeFile(OUT_PT, JSON.stringify(passthrough, null, 2) + "\n"),
  ]);

  console.log(`[compress] ${jobs.length} in → ${kept.length} to structure (${jobs.length - kept.length} pre-filtered) → structure_input.md`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[compress] FAILED: ${err.message}`);
    process.exit(1);
  });
}
