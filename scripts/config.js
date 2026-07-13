// scripts/config.js — central profile/path resolution. The only place that knows the layout.
//
// Profile files live in profiles/<name>/, per-run intermediates in profiles/<name>/data/.
// Selected by an explicit profile (JOBBUNNY_PROFILE env var, or a name argument to
// paths()/loadProfile()) or by config.json's default_profile.
//
// Profile precedence: JOBBUNNY_PROFILE env var → config.json default_profile.
// An explicit profile always wins — a checkout without config.json (fresh clone, CI) still
// resolves profiles/<name>/ when one is named, so the test suite runs anywhere.
// Synchronous on purpose — title_filter.js reads its config at module load.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Shared by doctor.js (launch-time) and init.js (setup-time preflight) — one path to update.
export const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CONFIG_PATH = join(ROOT, "config.json");
const PROFILES_DIR = join(ROOT, "profiles");

let resolvedName = null;

export function resolveProfileName() {
  if (resolvedName) return resolvedName;

  let name = process.env.JOBBUNNY_PROFILE;
  if (!name && !existsSync(CONFIG_PATH)) {
    throw new Error("No profile selected — run `/setup <name>` first (creates config.json), or set JOBBUNNY_PROFILE.");
  }
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
  const profileDir = join(PROFILES_DIR, name);
  const dataDir = join(profileDir, "data");
  return {
    profileDir,
    dataDir,
    profileJson: join(profileDir, "profile.json"),
    resume: join(profileDir, "resume.json"),
    resumeMeta: join(profileDir, "resume_meta.json"),
    avoid: join(profileDir, "avoid.md"),
    filterConfig: join(profileDir, "filter_config.json"),
    searchUrls: join(profileDir, "search_urls.md"),
    greenhouseBoards: join(profileDir, "greenhouse_boards.md"),
    cache: join(dataDir, "cache.json"),
    jobsRawText: join(dataDir, "jobs_raw_text.json"),
    structureInput: join(dataDir, "structure_input.md"),
    structurePassthrough: join(dataDir, "structure_passthrough.json"),
    decisions: join(dataDir, "jobs_raw_decisions.md"),
    checkpoint: join(dataDir, "jobs_raw_checkpoint.md"),
    jobsRaw: join(dataDir, "jobs_raw.json"),
    filteredJobs: join(dataDir, "filtered_jobs.json"),
    newJobs: join(dataDir, "new_jobs.json"),
    companiesSeen: join(dataDir, "companies_seen.json"),
    ghProbeLedger: join(dataDir, "gh_probe_ledger.json"),
    ghSeen: join(dataDir, "gh_seen.json"),
    extractStarted: join(dataDir, "extract_started.json"),
    lastRunResult: join(dataDir, "last_run_result.json"),
  };
}

// Per-profile Notion wiring.
export function loadProfile(name = resolveProfileName()) {
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

// List all profile directory names under profiles/, sorted. Returns empty array if
// the profiles dir doesn't exist.
export function listProfiles() {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
