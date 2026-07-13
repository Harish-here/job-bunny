// scripts/ops/mark_run_result.js — writes a deterministic PASS/FAIL marker for the active
// profile's /run invocation. Called explicitly by the /run orchestration (run.md) at the
// very end of both its success and failure paths — a mechanical script call, not freeform
// prose, so it's far more reliable than inferring success by grepping the log for a literal
// markdown heading (which depends on a fresh headless agent's exact text-template
// compliance, and doesn't always hold — see CHANGELOG for the incident this fixed).
//
// Usage: JOBBUNNY_PROFILE=<profile> node scripts/ops/mark_run_result.js --status success|failed [--message "..."]
// Writes profiles/<profile>/data/last_run_result.json — read by check_run_result.js.

import { mkdir } from "node:fs/promises";
import { parseFlags } from "../lib/cli.js";
import { writeJson } from "../lib/io.js";
import { paths } from "../lib/config.js";

const { flags } = parseFlags();

const status = flags.status === "success" ? "success" : "failed";
const result = {
  status,
  timestamp: new Date().toISOString(),
  message: flags.message || "",
};

const { dataDir, lastRunResult: outPath } = paths();
await mkdir(dataDir, { recursive: true });
await writeJson(outPath, result);
console.log(`[mark-run-result] wrote ${outPath}: ${status}`);
