// scripts/setup/remove_profile.js — the mirror-image "undo" of setup/init.js.
// Usage: node scripts/setup/remove_profile.js <profile> [--apply]
//
// Dry-run by default (mirrors notion/cleanup.js's --apply idiom): prints the full summary
// of what WOULD be removed and exits 0 without touching anything. Pass --apply to actually
// remove. Deliberately does NOT fall back to JOBBUNNY_PROFILE/config.json default_profile —
// resolving which profile to *delete* by ambient default is too dangerous; the profile name
// must be given explicitly on the command line.
//
// Removes: profiles/<profile>/ (recursive), the profile's TELEGRAM_BOT_TOKEN_<PROFILE> .env
// key, any .claude/settings.local.json permission entries scoped to the profile, and (if the
// profile had scheduling enabled) reconciles launchd by re-running schedule.js. Never touches
// Notion — the DB/parent page persist remotely; the user archives/deletes there manually if
// desired.

import { readFile, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isMain } from "../lib/cli.js";
import { ROOT, paths } from "../lib/config.js";
import { readJson, writeJson } from "../lib/io.js";
import { removeEnvKey } from "../lib/env_file.js";

const CONFIG_PATH = join(ROOT, "config.json");
const SETTINGS_PATH = join(ROOT, ".claude", "settings.local.json");
const APPLY = process.argv.includes("--apply");

const log = (msg) => console.log(`[remove-profile] ${msg}`);
const ok = (msg) => console.log(`[remove-profile] ✓ ${msg}`);

const exists = (p) =>
  access(p, constants.F_OK).then(() => true).catch(() => false);

// ---------- profile resolution ----------
// No fallback to JOBBUNNY_PROFILE / config.json default_profile — deleting a profile by
// ambient default is too dangerous; require the name explicitly on the command line.
function resolveProfileArg() {
  const arg = process.argv[2];
  if (!arg) {
    throw new Error(
      "Usage: node scripts/setup/remove_profile.js <profile> [--apply]   (e.g. node scripts/setup/remove_profile.js harish)"
    );
  }
  if (!/^[a-z0-9-]+$/.test(arg)) {
    throw new Error(`Profile name "${arg}" must be lowercase letters, digits, or hyphens.`);
  }
  return arg;
}

// ---------- pure helper (unit-testable in isolation) ----------
// Removes any permission-allow-list entry scoped to this profile (contains the literal
// substring JOBBUNNY_PROFILE=<profile>). Returns a new array — does not mutate the input.
export function stripProfilePermissions(allowList, profile) {
  const needle = `JOBBUNNY_PROFILE=${profile}`;
  return (allowList || []).filter((entry) => !entry.includes(needle));
}

// ---------- guards ----------
// Tolerant read: a missing or unparsable file just means "nothing on file" here — both
// callers only use the result for optional summary/guard fields, never a fail-loud path.
async function readJsonOrEmpty(path) {
  if (!(await exists(path))) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

async function runGuards(profile, profileDir) {
  if (!(await exists(profileDir))) {
    throw new Error(`profiles/${profile}/ does not exist — nothing to remove.`);
  }
  if (profile === "rajni") {
    throw new Error(
      `"rajni" is this repo's committed fixture profile (used by /verify) — it is never removable via this script.`
    );
  }
  const cfg = await readJsonOrEmpty(CONFIG_PATH);
  if (cfg.default_profile === profile) {
    throw new Error(
      `"${profile}" is config.json's default_profile — change default_profile to a different profile first, then re-run.`
    );
  }
}

// ---------- summary ----------
function formatSchedule(schedule) {
  if (!schedule) return "not set";
  const times = schedule.times ? schedule.times.join(", ") : schedule.time;
  return `enabled=${schedule.enabled ?? false}${times ? `, time(s)=${times}` : ""}`;
}

async function printSummary(profile, profileDir, profileJson, envKey, permMatches) {
  log(`profile directory: profiles/${profile}/ (${profileDir})`);
  if (profileJson.notion_db_id || profileJson.notion_parent_page_id) {
    log(`notion_db_id: ${profileJson.notion_db_id || "(none)"}`);
    log(`notion_parent_page_id: ${profileJson.notion_parent_page_id || "(none)"}`);
    log("note: Notion DB persists remotely — this script does not touch it.");
  } else {
    log("notion_db_id / notion_parent_page_id: (none on file)");
  }
  log(`schedule: ${formatSchedule(profileJson.schedule)}`);
  const chatId = profileJson.notify?.telegram?.chat_id;
  log(`notify.telegram.chat_id: ${chatId || "(none)"}`);
  log(`.env key that would be stripped: ${envKey}`);
  if (permMatches.length) {
    log(`.claude/settings.local.json entries that would be stripped:`);
    for (const m of permMatches) log(`  - ${m}`);
  } else {
    log(".claude/settings.local.json: no matching permission entries");
  }
}

// ---------- main ----------
async function main() {
  const profile = resolveProfileArg();
  const { profileDir, profileJson: profileJsonPath } = paths(profile);

  await runGuards(profile, profileDir);

  const profileJson = await readJsonOrEmpty(profileJsonPath);
  const envKey = `TELEGRAM_BOT_TOKEN_${profile.toUpperCase()}`;

  const settingsExists = await exists(SETTINGS_PATH);
  const settings = settingsExists
    ? await readJson(SETTINGS_PATH)
    : { permissions: { allow: [] } };
  const allowList = settings.permissions?.allow || [];
  const kept = stripProfilePermissions(allowList, profile);
  const permMatches = allowList.filter((e) => !kept.includes(e));

  log(`${APPLY ? "removing" : "would remove"} profile "${profile}"`);
  await printSummary(profile, profileDir, profileJson, envKey, permMatches);

  if (!APPLY) {
    console.log("");
    log("dry-run — nothing was touched. Re-run with --apply to actually remove.");
    return;
  }

  await rm(profileDir, { recursive: true, force: true });
  ok(`deleted profiles/${profile}/`);

  await removeEnvKey(envKey);
  ok(`stripped ${envKey} from .env (no-op if it wasn't present)`);

  if (settingsExists) {
    settings.permissions = settings.permissions || {};
    settings.permissions.allow = kept;
    await writeJson(SETTINGS_PATH, settings);
    ok(`stripped ${permMatches.length} permission entr${permMatches.length === 1 ? "y" : "ies"} from .claude/settings.local.json`);
  }

  if (profileJson.schedule?.enabled) {
    const out = execFileSync("node", [join(ROOT, "scripts", "ops", "schedule.js")], { encoding: "utf8" });
    process.stdout.write(out);
    ok("reconciled launchd via schedule.js (this profile had scheduling enabled)");
  }

  console.log("");
  ok(`removal complete for "${profile}"`);
  if (profileJson.notion_db_id || profileJson.notion_parent_page_id) {
    log(
      `Notion DB (${profileJson.notion_db_id || "?"}) / parent page (${profileJson.notion_parent_page_id || "?"}) ` +
        "still exists in Notion — archive/delete manually there if desired."
    );
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[remove-profile] FAILED: ${err.message}`);
    process.exit(1);
  });
}
