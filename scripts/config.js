// scripts/config.js — central profile/path resolution. The only place that knows the layout.
//
// Two modes, detected by the presence of config.json at the repo root:
//   profiles mode — config.json exists; profile files live in profiles/<name>/,
//                   per-run intermediates in profiles/<name>/data/.
//   legacy mode   — no config.json (pre-v0.7 checkout); every path resolves to the
//                   old root layout, byte-for-byte identical behavior. Nothing breaks
//                   on `git pull`; `node scripts/migrate.js <name>` opts in to profiles.
//
// Profile precedence (profiles mode): JOBBUNNY_PROFILE env var → config.json default_profile.
// Synchronous on purpose — title_filter.js reads its config at module load.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG_PATH = join(ROOT, "config.json");
const PROFILES_DIR = join(ROOT, "profiles");

export const LEGACY = !existsSync(CONFIG_PATH);

let resolvedName = null;
let legacyHinted = false;

export function resolveProfileName() {
  if (resolvedName) return resolvedName;

  const envName = process.env.JOBBUNNY_PROFILE;

  if (LEGACY) {
    if (envName) {
      throw new Error(
        `JOBBUNNY_PROFILE=${envName} is set but this checkout uses the legacy layout (no config.json). ` +
          "Run `node scripts/migrate.js <your-name>` first."
      );
    }
    if (!legacyHinted) {
      legacyHinted = true;
      console.error("[config] legacy layout — run `node scripts/migrate.js <your-name>` to switch to profiles");
    }
    resolvedName = "legacy";
    return resolvedName;
  }

  let name = envName;
  if (!name) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      throw new Error(`Cannot read/parse config.json: ${err.message}`);
    }
    name = cfg.default_profile;
  }
  if (!name) {
    throw new Error("No profile selected — set JOBBUNNY_PROFILE or default_profile in config.json.");
  }
  if (!existsSync(join(PROFILES_DIR, name))) {
    const available = existsSync(PROFILES_DIR)
      ? readdirSync(PROFILES_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];
    throw new Error(
      `Unknown profile "${name}" — available: ${available.join(", ") || "(none — run /setup <name>)"}`
    );
  }
  resolvedName = name;
  return resolvedName;
}

// Absolute paths for the active profile. Pure joins — no existence checks; every
// script keeps its own fail-loud read (explicit input → explicit output).
export function paths(name = resolveProfileName()) {
  const profileDir = LEGACY ? ROOT : join(PROFILES_DIR, name);
  const dataDir = LEGACY ? ROOT : join(profileDir, "data");
  return {
    profileDir,
    dataDir,
    profileJson: join(profileDir, "profile.json"),
    resume: join(profileDir, "resume.json"),
    resumeMeta: join(profileDir, "resume_meta.json"),
    avoid: join(profileDir, "avoid.md"),
    filterConfig: join(profileDir, "filter_config.json"),
    searchUrls: join(profileDir, "search_urls.md"),
    cache: LEGACY ? join(ROOT, "data", "cache.json") : join(dataDir, "cache.json"),
    jobsRawText: join(dataDir, "jobs_raw_text.json"),
    structureInput: join(dataDir, "structure_input.md"),
    structurePassthrough: join(dataDir, "structure_passthrough.json"),
    decisions: join(dataDir, "jobs_raw_decisions.md"),
    checkpoint: join(dataDir, "jobs_raw_checkpoint.md"),
    jobsRaw: join(dataDir, "jobs_raw.json"),
    filteredJobs: join(dataDir, "filtered_jobs.json"),
    newJobs: join(dataDir, "new_jobs.json"),
  };
}

// Per-profile Notion wiring. Legacy mode mirrors the old env-var behavior exactly;
// callers keep their own missing-id errors there.
export function loadProfile(name = resolveProfileName()) {
  if (LEGACY) {
    return {
      name: "legacy",
      notion_db_id: process.env.NOTION_DB_ID,
      notion_parent_page_id: process.env.NOTION_PARENT_PAGE_ID,
    };
  }
  const p = join(PROFILES_DIR, name, "profile.json");
  let profile;
  try {
    profile = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${p} — run \`/setup ${name}\` first: ${err.message}`);
  }
  if (!profile.notion_db_id) {
    throw new Error(`notion_db_id missing in ${p} — run \`/setup ${name}\`.`);
  }
  return { name, ...profile };
}

// List all profile directory names under profiles/, sorted. Returns empty array in
// legacy mode or if profiles dir doesn't exist.
export function listProfiles() {
  if (LEGACY || !existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
