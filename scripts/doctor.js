// scripts/doctor.js — preflight for /run. Checks (no mutations):
//   1. Secrets present (.env has NOTION_TOKEN + NOTION_DB_ID)
//   2. Chrome CDP reachable on :9222 (real LinkedIn session lives there)
//   3. Every page-type referenced in search_urls.md has a page_inventory/<page>.md
//   4. cache.json present & valid
// Exits non-zero if any check fails.

import "dotenv/config";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

let failed = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  failed++;
};

async function checkSecrets() {
  console.log("[doctor] secrets");
  if (process.env.NOTION_TOKEN) pass("NOTION_TOKEN set");
  else fail("NOTION_TOKEN missing (run /setup)");
  if (process.env.NOTION_DB_ID) pass("NOTION_DB_ID set");
  else fail("NOTION_DB_ID missing (run /setup)");
}

const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_DATA_DIR = join(ROOT, ".chrome-debug");

async function cdpReachable() {
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function checkCDP() {
  console.log("[doctor] chrome CDP :9222");
  let v = await cdpReachable();
  if (v) {
    pass(`reachable (${v.Browser || "Chrome"})`);
    return;
  }

  console.log("  … not reachable — launching Chrome with debug profile");
  const child = spawn(CHROME_BIN, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${CHROME_DATA_DIR}`,
  ], { detached: true, stdio: "ignore" });
  child.unref();

  // Poll for up to 10 s
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    v = await cdpReachable();
    if (v) {
      pass(`reachable (${v.Browser || "Chrome"}) — just launched`);
      return;
    }
  }

  fail("Chrome did not start in time — open it manually and retry");
}

async function checkInventories() {
  console.log("[doctor] page inventories");
  if (!(await exists(join(ROOT, "search_urls.md")))) return fail("search_urls.md missing");
  const text = await readFile(join(ROOT, "search_urls.md"), "utf8");
  const pages = [...text.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim());
  if (!pages.length) return fail("no page-types declared in search_urls.md");
  for (const page of pages) {
    if (await exists(join(ROOT, "page_inventory", `${page}.md`))) pass(`${page} inventory present`);
    else fail(`${page} has no inventory (run /page-analyse)`);
  }
}

async function checkCache() {
  console.log("[doctor] cache");
  try {
    const c = JSON.parse(await readFile(join(ROOT, "data", "cache.json"), "utf8"));
    if (Array.isArray(c.jobs)) pass(`cache.json valid (${c.jobs.length} job(s), last_run=${c.last_run})`);
    else fail("cache.json malformed (no jobs array)");
  } catch {
    fail("cache.json missing/unparseable (run /setup)");
  }
}

async function main() {
  await checkSecrets();
  await checkCDP();
  await checkInventories();
  await checkCache();
  console.log("");
  if (failed) {
    console.error(`[doctor] ${failed} check(s) failed — not ready to /run.`);
    process.exit(1);
  }
  console.log("[doctor] all green — ready to /run.");
}

main();
