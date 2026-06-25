// scripts/compress.js — pre-LLM compression stage.
// Reads jobs_raw_text.json, pre-filters by title, sanitises raw_text,
// and writes structure_input.md (compact markdown table) + structure_passthrough.json.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN = join(ROOT, "jobs_raw_text.json");
const OUT_MD = join(ROOT, "structure_input.md");
const OUT_PT = join(ROOT, "structure_passthrough.json");

const PREFILTER_PATTERNS = [
  /\bengineer\b/i,
  /\bdeveloper\b/i,
  /\barchitect\b/i,
  /\btechnical\b/i,
  /\bprogrammer\b/i,
  /\bfrontend\b/i,
  /\bfront-end\b/i,
  /\bui\b/i,
  /\breact\b/i,
  /\bjavascript\b/i,
  /\btypescript\b/i,
  /\bfullstack\b/i,
  /\bfull-stack\b/i,
  /\bfull stack\b/i,
];

function passesPreFilter(title) {
  return PREFILTER_PATTERNS.some((re) => re.test(title));
}

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
    const title = job.card_title || "";
    if (!passesPreFilter(title)) {
      console.log(`[compress] pre-filter drop: "${title}" @ ${job.card_company}`);
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

  const dropped = jobs.length - kept.length;

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

  console.log(`[compress] ${jobs.length} in → ${kept.length} to structure (${dropped} pre-filtered) → structure_input.md`);
}

main().catch((err) => {
  console.error(`[compress] FAILED: ${err.message}`);
  process.exit(1);
});
