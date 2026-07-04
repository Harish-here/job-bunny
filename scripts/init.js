// scripts/init.js — idempotent, resumable per-profile setup.
// Usage: node scripts/init.js <profile>   (or JOBBUNNY_PROFILE / config.json default)
//
// Every step is check-before-create and independently resumable: re-running repairs a
// missing piece without clobbering filled files or duplicating Notion structure.
//
// Order is load-bearing: .gitignore must contain `.env` BEFORE any secret is written,
// so there is no window where a commit could capture the token.
//
// Notion layout (same account for every profile): the root page "Job Bunny's List" is
// shared with the integration once. Each profile gets its own child page (titled with
// the profile name) holding its own "Job Bunny — Jobs" DB. The first profile of a
// pre-v0.7 install keeps its original page/DB via the adopt path (profile.json IDs,
// pre-written by migrate.js).
//
// A legacy checkout (root-level search_urls.md / data/cache.json, no config.json) must be
// converted with `node scripts/migrate.js <name>` first — init refuses to mix layouts.

import { readFile, writeFile, mkdir, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Client } from "@notionhq/client";
import { DB_TITLE, PARENT_PAGE_TITLE, DB_PROPERTIES } from "./schema.js";
import { ROOT } from "./config.js";

const ENV_PATH = join(ROOT, ".env");
const CONFIG_PATH = join(ROOT, "config.json");

const log = (msg) => console.log(`[init] ${msg}`);
const ok = (msg) => console.log(`[init] ✓ ${msg}`);

const exists = (p) =>
  access(p, constants.F_OK).then(() => true).catch(() => false);

// ---------- profile resolution ----------
async function resolveProfileArg() {
  const arg = process.argv[2] || process.env.JOBBUNNY_PROFILE;
  if (arg) {
    if (!/^[a-z0-9-]+$/.test(arg)) {
      throw new Error(`Profile name "${arg}" must be lowercase letters, digits, or hyphens.`);
    }
    return arg;
  }
  if (await exists(CONFIG_PATH)) {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    if (cfg.default_profile) return cfg.default_profile;
  }
  throw new Error("Usage: node scripts/init.js <profile>   (e.g. node scripts/init.js harish)");
}

async function guardAgainstLegacyLayout() {
  if (await exists(CONFIG_PATH)) return; // already profiles mode
  const legacyMarkers = ["search_urls.md", "resume_meta.json", join("data", "cache.json")];
  for (const m of legacyMarkers) {
    if (await exists(join(ROOT, m))) {
      throw new Error(
        `Legacy layout detected (${m} at repo root). Run \`node scripts/migrate.js <your-name>\` first — init won't mix layouts.`
      );
    }
  }
}

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
async function ensureGitignore() {
  const path = join(ROOT, ".gitignore");
  let text = (await exists(path)) ? await readFile(path, "utf8") : "";
  const lines = text.split("\n").map((l) => l.trim());
  const required = [".env", "profiles/", "config.json"];
  const missing = required.filter((r) => !lines.includes(r));
  if (!missing.length) {
    ok(".gitignore already covers .env, profiles/, config.json");
    return;
  }
  text = text.replace(/\n*$/, "\n") + missing.join("\n") + "\n";
  await writeFile(path, text);
  ok(`added to .gitignore: ${missing.join(", ")} (before any secret write)`);
}

async function ensureToken(env) {
  if (env.NOTION_TOKEN) {
    ok("NOTION_TOKEN already present (shared across profiles)");
    return env.NOTION_TOKEN;
  }
  const token = await promptMasked("Paste your Notion integration token (hidden): ");
  if (!token) throw new Error("No token entered — aborting.");
  await writeEnvKey("NOTION_TOKEN", token);
  ok("NOTION_TOKEN written to .env");
  return token;
}

// ---------- Step 2: Notion structure (adopt-or-create, per profile) ----------
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

async function readProfileJson(profileJsonPath) {
  if (!(await exists(profileJsonPath))) return { notion_db_id: "", notion_parent_page_id: "" };
  try {
    return JSON.parse(await readFile(profileJsonPath, "utf8"));
  } catch {
    return { notion_db_id: "", notion_parent_page_id: "" };
  }
}

async function resolveNotion(notion, profile, profileJsonPath) {
  const stored = await readProfileJson(profileJsonPath);
  const writeIds = async (dbId, parentId) => {
    await writeFile(
      profileJsonPath,
      JSON.stringify({ notion_db_id: dbId, notion_parent_page_id: parentId }, null, 2) + "\n"
    );
  };

  // (a) profile.json already points at a live DB → adopt
  if (stored.notion_db_id) {
    try {
      await notion.databases.retrieve({ database_id: stored.notion_db_id });
      ok(`DB already exists (${stored.notion_db_id}) — already exists, no-op`);
      return stored.notion_db_id;
    } catch {
      log("profile.json has a DB id but the DB is not retrievable — re-resolving");
    }
  }

  // Resolve the shared root page "Job Bunny's List" (must be shared with the integration).
  const rootPage = await findSharedPageByTitle(notion, PARENT_PAGE_TITLE);
  if (!rootPage) {
    throw new Error(
      `Could not find a page titled "${PARENT_PAGE_TITLE}" shared with this integration.\n` +
        `Fix: create a page named "${PARENT_PAGE_TITLE}" in Notion, share it with your integration, then re-run.`
    );
  }

  // (b) per-profile parent page: stored id, else find-or-create a child page titled after the profile.
  let parentId = stored.notion_parent_page_id;
  if (parentId) {
    try {
      await notion.pages.retrieve({ page_id: parentId });
    } catch {
      log("stored parent page not retrievable — re-resolving");
      parentId = "";
    }
  }
  if (!parentId) {
    const pageTitle = profile.charAt(0).toUpperCase() + profile.slice(1);
    const existing = await findSharedPageByTitle(notion, pageTitle);
    const rootIdFlat = rootPage.id.replace(/-/g, "");
    if (existing && existing.parent?.page_id?.replace(/-/g, "") === rootIdFlat) {
      parentId = existing.id;
      ok(`found profile page "${pageTitle}" (${parentId}) — already exists, no-op`);
    } else {
      const created = await notion.pages.create({
        parent: { type: "page_id", page_id: rootPage.id },
        properties: { title: { title: [{ type: "text", text: { content: pageTitle } }] } },
      });
      parentId = created.id;
      ok(`created profile page "${pageTitle}" (${parentId}) under "${PARENT_PAGE_TITLE}"`);
    }
  }

  // (c) DB under the profile page → adopt or create
  const existingDb = await findDbUnderParent(notion, parentId);
  if (existingDb) {
    await writeIds(existingDb.id, parentId);
    ok(`adopted existing DB "${DB_TITLE}" (${existingDb.id}) — already exists, no-op`);
    return existingDb.id;
  }
  const created = await notion.databases.create({
    parent: { type: "page_id", page_id: parentId },
    title: [{ type: "text", text: { content: DB_TITLE } }],
    properties: DB_PROPERTIES,
  });
  await writeIds(created.id, parentId);
  ok(`created DB "${DB_TITLE}" (${created.id}) with full schema`);
  return created.id;
}

// ---------- Step 3: scaffold (skip any that exist) ----------
async function ensureFile(absPath, contents, label) {
  if (await exists(absPath)) {
    const cur = await readFile(absPath, "utf8").catch(() => "");
    if (cur.trim().length > 0) {
      ok(`${label} exists — skipped`);
      return;
    }
  }
  await writeFile(absPath, contents);
  ok(`seeded ${label}`);
}

async function scaffold(profile, profileDir) {
  await mkdir(join(profileDir, "data"), { recursive: true });
  await mkdir(join(ROOT, "page_inventory"), { recursive: true });
  ok(`directory profiles/${profile}/data ready`);

  const seedFromTemplate = async (file) => {
    const dst = join(profileDir, file);
    if (await exists(dst)) {
      ok(`profiles/${profile}/${file} exists — skipped`);
      return;
    }
    await copyFile(join(ROOT, "templates", file), dst);
    ok(`seeded profiles/${profile}/${file} from templates/`);
  };
  await seedFromTemplate("avoid.md");
  await seedFromTemplate("search_urls.md");
  await seedFromTemplate("filter_config.json");
  await ensureFile(
    join(profileDir, "data", "cache.json"),
    JSON.stringify({ last_run: null, jobs: [] }, null, 2) + "\n",
    `profiles/${profile}/data/cache.json`
  );
}

async function ensureConfigJson(profile) {
  if (await exists(CONFIG_PATH)) {
    ok("config.json exists — skipped");
    return;
  }
  await writeFile(CONFIG_PATH, JSON.stringify({ default_profile: profile }, null, 2) + "\n");
  ok(`config.json written (default_profile=${profile})`);
}

// ---------- main ----------
async function main() {
  const profile = await resolveProfileArg();
  log(`starting idempotent setup for profile "${profile}"`);
  await guardAgainstLegacyLayout();
  await ensureGitignore();
  const env = await readEnv();
  const token = await ensureToken(env);

  const profileDir = join(ROOT, "profiles", profile);
  await scaffold(profile, profileDir);
  await ensureConfigJson(profile);

  const notion = new Client({ auth: token });
  const dbId = await resolveNotion(notion, profile, join(profileDir, "profile.json"));

  console.log("");
  ok(`setup complete for "${profile}"`);
  log(`Notion DB: ${dbId}`);
  log(`Next: fill profiles/${profile}/resume.json (start from resume.example.json),`);
  log(`then run \`JOBBUNNY_PROFILE=${profile} node scripts/generate_meta.js\`.`);
  log("Add searches with /add-url. /doctor checks Chrome + LinkedIn login before /run.");
}

main().catch((err) => {
  console.error(`[init] FAILED: ${err.message}`);
  process.exit(1);
});
