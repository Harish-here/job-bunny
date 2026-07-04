// scripts/migrate.js — one-shot legacy → profiles conversion of THIS working copy.
// Usage: node scripts/migrate.js <profile-name>
//
// Moves the root-level profile files into profiles/<name>/, writes profile.json from the
// .env Notion IDs, and writes config.json (whose presence switches every script to
// profiles mode). Legacy files deleted by an upstream pull (they were untracked in v0.7)
// are re-seeded from templates/. The .env NOTION_DB_ID/NOTION_PARENT_PAGE_ID keys are left
// in place — profiles mode ignores them, and keeping them makes rollback trivial.
//
// Rollback: move the files in profiles/<name>/ back to the repo root, move
// profiles/<name>/data/cache.json back to data/cache.json, delete config.json.

import { readFile, writeFile, mkdir, rename, copyFile, access, unlink, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.js";

const log = (msg) => console.log(`[migrate] ${msg}`);
const ok = (msg) => console.log(`[migrate] ✓ ${msg}`);
const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

const CONFIG_PATH = join(ROOT, "config.json");

// legacy root file → { template to seed from when missing (null = skip if missing) }
const PROFILE_FILES = [
  { name: "resume.json", template: null },
  { name: "resume_meta.json", template: null },
  { name: "avoid.md", template: "avoid.md" },
  { name: "filter_config.json", template: "filter_config.json" },
  { name: "search_urls.md", template: "search_urls.md" },
];

const STALE_ROOT = [
  "jobs_raw_text.json", "structure_input.md", "structure_passthrough.json",
  "jobs_raw_decisions.md", "jobs_raw_decisions.json", "jobs_raw_checkpoint.md",
  "jobs_raw_checkpoint.json", "jobs_raw.json", "filtered_jobs.json", "new_jobs.json",
];

async function main() {
  const name = process.argv[2];
  if (!name) throw new Error("Usage: node scripts/migrate.js <profile-name>");
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Profile name "${name}" must be lowercase letters, digits, or hyphens.`);
  }
  if (await exists(CONFIG_PATH)) {
    throw new Error("config.json already exists — this checkout is already on profiles mode.");
  }
  const profileDir = join(ROOT, "profiles", name);
  if (await exists(profileDir)) {
    throw new Error(`profiles/${name}/ already exists — refusing to overwrite.`);
  }

  const dataDir = join(profileDir, "data");
  await mkdir(dataDir, { recursive: true });
  ok(`created profiles/${name}/data/`);

  // Move (or re-seed) the profile files.
  for (const { name: file, template } of PROFILE_FILES) {
    const src = join(ROOT, file);
    const dst = join(profileDir, file);
    if (await exists(src)) {
      await rename(src, dst);
      ok(`moved ${file} → profiles/${name}/${file}`);
    } else if (template) {
      await copyFile(join(ROOT, "templates", template), dst);
      log(`${file} missing at root — seeded from templates/${template}`);
    } else {
      log(`${file} missing at root — skipped (fill it later)`);
    }
  }

  // Move the cache (or seed empty).
  const legacyCache = join(ROOT, "data", "cache.json");
  if (await exists(legacyCache)) {
    await rename(legacyCache, join(dataDir, "cache.json"));
    ok(`moved data/cache.json → profiles/${name}/data/cache.json`);
  } else {
    await writeFile(join(dataDir, "cache.json"), JSON.stringify({ last_run: null, jobs: [] }, null, 2) + "\n");
    log("data/cache.json missing — seeded empty cache");
  }

  // profile.json from the legacy .env Notion IDs.
  let dbId = "";
  let parentId = "";
  if (await exists(join(ROOT, ".env"))) {
    const env = await readFile(join(ROOT, ".env"), "utf8");
    dbId = env.match(/^NOTION_DB_ID=(.*)$/m)?.[1]?.trim() ?? "";
    parentId = env.match(/^NOTION_PARENT_PAGE_ID=(.*)$/m)?.[1]?.trim() ?? "";
  }
  await writeFile(
    join(profileDir, "profile.json"),
    JSON.stringify({ notion_db_id: dbId, notion_parent_page_id: parentId }, null, 2) + "\n"
  );
  if (dbId) ok(`profile.json written (DB ${dbId} adopted from .env — env keys left in place, now unused)`);
  else log("profile.json written EMPTY — no NOTION_DB_ID in .env; run `node scripts/init.js " + name + "`");

  // Flip the switch.
  await writeFile(CONFIG_PATH, JSON.stringify({ default_profile: name }, null, 2) + "\n");
  ok(`config.json written (default_profile=${name}) — profiles mode active`);

  // Housekeeping: per-run intermediates regenerate; stale old-layout leftovers go too.
  for (const file of STALE_ROOT) {
    const p = join(ROOT, file);
    if (await exists(p)) await unlink(p);
  }
  for (const file of ["jobs_raw_text.json", "jobs_raw.json"]) {
    const p = join(ROOT, "data", file);
    if (await exists(p)) await unlink(p);
  }
  await rmdir(join(ROOT, "data")).then(() => ok("removed empty data/")).catch(() => log("data/ not empty — left as is"));
  ok("cleaned stale per-run intermediates");

  console.log("");
  ok(`migration complete — "${name}" is the default profile`);
  log("verify with `node scripts/doctor.js`; rollback steps are in the header of this script");
}

main().catch((err) => {
  console.error(`[migrate] FAILED: ${err.message}`);
  process.exit(1);
});
