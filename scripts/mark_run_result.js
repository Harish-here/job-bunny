// scripts/mark_run_result.js — writes a deterministic PASS/FAIL marker for the active
// profile's /run invocation. Called explicitly by the /run orchestration (run.md) at the
// very end of both its success and failure paths — a mechanical script call, not freeform
// prose, so it's far more reliable than inferring success by grepping the log for a literal
// markdown heading (which depends on a fresh headless agent's exact text-template
// compliance, and doesn't always hold — see CHANGELOG for the incident this fixed).
//
// Usage: JOBBUNNY_PROFILE=<profile> node scripts/mark_run_result.js --status success|failed [--message "..."]
// Writes profiles/<profile>/data/last_run_result.json — read by check_run_result.js.

import { writeFile, mkdir } from "node:fs/promises";
import { paths } from "./config.js";

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    flags[args[i].slice(2)] = args[i + 1];
    i++;
  }
}

const status = flags.status === "success" ? "success" : "failed";
const result = {
  status,
  timestamp: new Date().toISOString(),
  message: flags.message || "",
};

const { dataDir, lastRunResult: outPath } = paths();
await mkdir(dataDir, { recursive: true });
await writeFile(outPath, JSON.stringify(result, null, 2) + "\n");
console.log(`[mark-run-result] wrote ${outPath}: ${status}`);
