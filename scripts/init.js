// scripts/init.js — one-time, idempotent, resumable project setup.
// Every step is check-before-create and independently resumable: re-running repairs a
// missing piece without clobbering filled files or duplicating the Notion DB.
//
// Order is load-bearing: .gitignore must contain `.env` BEFORE any secret is written,
// so there is no window where a commit could capture the token.
//
// Live run requires a Notion integration token and a page named "Job Bunny's List"
// shared with that integration. See README/the hand-off prompts at the end.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@notionhq/client";
import {
  DB_TITLE,
  PARENT_PAGE_TITLE,
  DB_PROPERTIES,
} from "./schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const GITIGNORE_PATH = join(ROOT, ".gitignore");

const log = (msg) => console.log(`[init] ${msg}`);
const ok = (msg) => console.log(`[init] ✓ ${msg}`);

const exists = (p) =>
  access(p, constants.F_OK).then(() => true).catch(() => false);

// ---------- .env helpers ----------
async function readEnv() {
  if (!(await exists(ENV_PATH))) return {};
  const text = await readFile(ENV_PATH, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function writeEnvKey(key, value) {
  let text = (await exists(ENV_PATH)) ? await readFile(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) text = text.replace(re, line);
  else text = text.replace(/\n*$/, "\n") + line + "\n";
  await writeFile(ENV_PATH, text);
}

// ---------- masked prompt (never echoes, never a CLI arg) ----------
function promptMasked(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const onData = () => rl.output.write("\x1B[2K\x1B[200D" + question);
    process.stdout.write(question);
    rl.input.on("data", onData);
    rl.question("", (answer) => {
      rl.input.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// ---------- Step 1: secrets first ----------
async function ensureGitignoreHasEnv() {
  let text = (await exists(GITIGNORE_PATH)) ? await readFile(GITIGNORE_PATH, "utf8") : "";
  if (text.split("\n").some((l) => l.trim() === ".env")) {
    ok(".gitignore already ignores .env");
    return;
  }
  text = text.replace(/\n*$/, "\n") + ".env\n";
  await writeFile(GITIGNORE_PATH, text);
  ok("added .env to .gitignore (before any secret write)");
}

async function ensureToken(env) {
  if (env.NOTION_TOKEN) {
    ok("NOTION_TOKEN already present");
    return env.NOTION_TOKEN;
  }
  const token = await promptMasked("Paste your Notion integration token (hidden): ");
  if (!token) throw new Error("No token entered — aborting.");
  await writeEnvKey("NOTION_TOKEN", token);
  ok("NOTION_TOKEN written to .env");
  return token;
}

// ---------- Step 2: Notion DB (two-tier locate-or-create) ----------
async function findSharedPageByTitle(notion, title) {
  const res = await notion.search({
    query: title,
    filter: { property: "object", value: "page" },
  });
  return res.results.find((p) => {
    const props = p.properties || {};
    const titleProp = Object.values(props).find((v) => v.type === "title");
    const plain = titleProp?.title?.map((t) => t.plain_text).join("") ?? "";
    return plain.trim() === title;
  });
}

async function findDbUnderParent(notion, parentId) {
  const res = await notion.search({
    query: DB_TITLE,
    filter: { property: "object", value: "database" },
  });
  return res.results.find((db) => {
    const plain = db.title?.map((t) => t.plain_text).join("") ?? "";
    return plain.trim() === DB_TITLE && db.parent?.page_id?.replace(/-/g, "") === parentId.replace(/-/g, "");
  });
}

async function resolveDb(notion, env) {
  // (a) NOTION_DB_ID in .env and DB still exists → adopt
  if (env.NOTION_DB_ID) {
    try {
      await notion.databases.retrieve({ database_id: env.NOTION_DB_ID });
      ok(`DB already exists (NOTION_DB_ID=${env.NOTION_DB_ID}) — already exists, no-op`);
      return { dbId: env.NOTION_DB_ID, parentId: env.NOTION_PARENT_PAGE_ID };
    } catch {
      log("NOTION_DB_ID set but DB not retrievable — re-resolving");
    }
  }

  // Resolve parent page "Job Bunny's List" (must be shared with the integration).
  let parentId = env.NOTION_PARENT_PAGE_ID;
  if (!parentId) {
    const page = await findSharedPageByTitle(notion, PARENT_PAGE_TITLE);
    if (!page) {
      throw new Error(
        `Could not find a page titled "${PARENT_PAGE_TITLE}" shared with this integration.\n` +
          `Fix: create a page named "${PARENT_PAGE_TITLE}" in Notion, share it with your integration, then re-run.`
      );
    }
    parentId = page.id;
    await writeEnvKey("NOTION_PARENT_PAGE_ID", parentId);
    ok(`found parent page "${PARENT_PAGE_TITLE}" (${parentId})`);
  }

  // (b) search that parent for an existing Job Bunny DB → adopt
  const existing = await findDbUnderParent(notion, parentId);
  if (existing) {
    await writeEnvKey("NOTION_DB_ID", existing.id);
    ok(`adopted existing DB "${DB_TITLE}" (${existing.id}) — already exists, no-op`);
    return { dbId: existing.id, parentId };
  }

  // (c) create the DB under the parent from the schema
  const created = await notion.databases.create({
    parent: { type: "page_id", page_id: parentId },
    title: [{ type: "text", text: { content: DB_TITLE } }],
    properties: DB_PROPERTIES,
  });
  await writeEnvKey("NOTION_DB_ID", created.id);
  ok(`created DB "${DB_TITLE}" (${created.id}) with full schema`);
  return { dbId: created.id, parentId };
}

// ---------- Step 3: scaffold (skip any that exist) ----------
async function ensureFile(relPath, contents) {
  const p = join(ROOT, relPath);
  if (await exists(p)) {
    const cur = await readFile(p, "utf8").catch(() => "");
    if (cur.trim().length > 0) {
      ok(`${relPath} exists — skipped`);
      return;
    }
  }
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, contents);
  ok(`seeded ${relPath}`);
}

async function ensureDir(relPath) {
  const p = join(ROOT, relPath);
  await mkdir(p, { recursive: true });
  ok(`directory ${relPath} ready`);
}

async function scaffold() {
  await ensureDir("page_inventory");
  await ensureDir("data");
  await ensureFile("data/cache.json", JSON.stringify({ last_run: null, jobs: [] }, null, 2) + "\n");
  await ensureFile("jobs_raw_text.json", "[]\n");
  await ensureFile("jobs_raw.json", "[]\n");
  // avoid.md, search_urls.md, resume.json are seeded by T2 and treated as user-owned —
  // only re-seed if genuinely missing.
  await ensureFile("avoid.md", "# Avoid List\n\n- Chargebee\n- Cognizant\n- TCS\n- Capgemini\n- Tech Mahindra\n- Zoho\n- Freshworks\n- HappyFox\n- Rocketlane\n");
}

// ---------- main ----------
async function main() {
  log("starting idempotent setup");
  await ensureGitignoreHasEnv();
  let env = await readEnv();
  const token = await ensureToken(env);
  env = await readEnv();

  const notion = new Client({ auth: token });
  const { dbId } = await resolveDb(notion, env);

  await scaffold();

  console.log("");
  ok("setup complete");
  log(`NOTION_DB_ID=${dbId}`);
  log("Next: fill resume.json, then run `node scripts/generate_meta.js`.");
  log("Before /run: start Chrome with --remote-debugging-port=9222 and log in to LinkedIn (checked by /doctor).");
}

main().catch((err) => {
  console.error(`[init] FAILED: ${err.message}`);
  process.exit(1);
});
