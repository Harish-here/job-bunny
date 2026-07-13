#!/usr/bin/env node
// scripts/ops/schedule.js — generate and install launchd jobs for scheduled /run invocations.
// Usage: node scripts/ops/schedule.js
// Reads profiles/<name>/profile.json, collects entries with schedule.enabled: true,
// groups by schedule time, and installs one launchd job per distinct time. A profile may
// declare either a single schedule.time ("HH:MM") or multiple via schedule.times
// (["HH:MM", ...]) for a same-day multi-fire cadence (e.g. every 2.5h through working
// hours) — it's registered under every time it lists, so it can land in more than one
// launchd job/group.

import { readFileSync, readdirSync, mkdirSync, unlinkSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, paths, listProfiles } from "../lib/config.js";

const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const LOGS_DIR = join(homedir(), "Library", "Logs", "JobBunny");
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Ensure LaunchAgents and Logs directories exist.
mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });

// Collect scheduled profiles, grouped by time.
const profilesByTime = new Map();

for (const profileName of listProfiles()) {
  const profileJsonPath = paths(profileName).profileJson;
  let profile;

  try {
    profile = JSON.parse(readFileSync(profileJsonPath, "utf8"));
  } catch (err) {
    console.error(`[schedule.js] Warning: Cannot read ${profileJsonPath}: ${err.message}`);
    continue;
  }

  // Check if scheduling is enabled for this profile.
  if (!profile.schedule || !profile.schedule.enabled) {
    continue;
  }

  // schedule.times (array) takes precedence when present; otherwise fall back to the
  // legacy single schedule.time. Either way we end up with a flat list of "HH:MM" strings
  // this profile should fire at.
  // Deduped — a repeated entry (e.g. a copy-paste slip building a multi-time array) must
  // not register the profile twice under the same time, which would otherwise run its
  // whole pipeline twice in one slot.
  const timeList = [
    ...new Set(
      Array.isArray(profile.schedule.times)
        ? profile.schedule.times
        : profile.schedule.time
          ? [profile.schedule.time]
          : []
    ),
  ];

  if (!timeList.length) {
    console.error(
      `[schedule.js] Error: schedule.enabled is true in ${profileName} but no time/times given. Skipping.`
    );
    continue;
  }

  for (const time of timeList) {
    // Validate time format (HH:MM).
    if (!TIME_REGEX.test(time)) {
      console.error(
        `[schedule.js] Error: Invalid schedule time "${time}" in ${profileName} — ` +
          `expected HH:MM format (e.g., "09:00"). Skipping this time.`
      );
      continue;
    }

    // Group profiles by time.
    if (!profilesByTime.has(time)) {
      profilesByTime.set(time, []);
    }
    profilesByTime.get(time).push(profileName);
  }
}

// If no profiles are scheduled, exit cleanly.
if (profilesByTime.size === 0) {
  console.log("[schedule.js] No profiles with schedule.enabled: true. Exiting.");
  process.exit(0);
}

// Sort profiles within each time group.
for (const profiles of profilesByTime.values()) {
  profiles.sort();
}

// Track which jobs we're installing (for cleanup of stale jobs).
const desiredLabels = new Set();

// Get user id for launchctl.
const uid = process.getuid();

// Install/reinstall each launchd job.
for (const [time, profiles] of profilesByTime) {
  const [hourStr, minStr] = time.split(":");
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);
  const hhmm = time.replace(":", "");
  const label = `com.jobbunny.run.${hhmm}`;

  desiredLabels.add(label);

  // Build ProgramArguments: ["/bin/bash", "<path to run_scheduled.sh>", <profile1>, <profile2>, ...]
  const runScriptPath = join(ROOT, "scripts", "ops", "run_scheduled.sh");
  const programArguments = ["/bin/bash", runScriptPath, ...profiles];

  // Build StartCalendarInterval: array of dicts for Weekday 1–5 (Mon–Fri).
  // launchd numbering: 0/7=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
  const startCalendarInterval = [1, 2, 3, 4, 5].map((weekday) => ({
    Weekday: weekday,
    Hour: hour,
    Minute: minute,
  }));

  // Build log file paths.
  const outLog = join(LOGS_DIR, `${label}.out.log`);
  const errLog = join(LOGS_DIR, `${label}.err.log`);

  // Render launchd plist XML.
  const plistPath = join(LAUNCH_AGENTS_DIR, `${label}.plist`);
  const plist = renderPlist({
    Label: label,
    ProgramArguments: programArguments,
    StartCalendarInterval: startCalendarInterval,
    RunAtLoad: false,
    WorkingDirectory: ROOT,
    StandardOutPath: outLog,
    StandardErrorPath: errLog,
  });

  // Write plist file.
  writeFileSync(plistPath, plist, "utf8");
  console.log(`[schedule.js] Wrote ${plistPath}`);

  // Unload any existing job (silently ignore if not loaded).
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`]);
    console.log(`[schedule.js] Unloaded existing job: ${label}`);
  } catch (err) {
    // Expected on first install; silently ignore.
  }

  // Load the new job.
  try {
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    console.log(`[schedule.js] Loaded new job: ${label}`);
  } catch (err) {
    console.error(`[schedule.js] Error loading job ${label}: ${err.message}`);
    process.exit(1);
  }

  console.log(
    `[schedule.js] Installed: ${label} — ` +
      `${time} weekdays (Mon–Fri) for profile${profiles.length > 1 ? "s" : ""} ` +
      `${profiles.join(", ")}`
  );
}

// Cleanup: remove stale launchd jobs (those not in desiredLabels).
if (existsSync(LAUNCH_AGENTS_DIR)) {
  for (const file of readdirSync(LAUNCH_AGENTS_DIR)) {
    if (!file.startsWith("com.jobbunny.run.") || !file.endsWith(".plist")) {
      continue;
    }

    const match = file.match(/^com\.jobbunny\.run\.(.+)\.plist$/);
    if (!match) continue;

    const label = `com.jobbunny.run.${match[1]}`;
    if (desiredLabels.has(label)) {
      continue; // This job is still desired.
    }

    // Unload and delete the stale job.
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`]);
      console.log(`[schedule.js] Unloaded stale job: ${label}`);
    } catch (err) {
      // Silently ignore if already unloaded.
    }

    const plistPath = join(LAUNCH_AGENTS_DIR, file);
    unlinkSync(plistPath);
    console.log(`[schedule.js] Deleted stale plist: ${plistPath}`);
  }
}

// Final summary.
console.log(
  `[schedule.js] Finished. Verify with: launchctl print gui/${uid}/<label> ` +
    `or launchctl list | grep com.jobbunny`
);

/**
 * Render a launchd plist XML string from a configuration object.
 */
function renderPlist(config) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">', "<dict>"];

  for (const [key, value] of Object.entries(config)) {
    lines.push(`  <key>${escapeXml(key)}</key>`);
    lines.push(renderValue(value));
  }

  lines.push("</dict>", "</plist>");
  return lines.join("\n");
}

/**
 * Render a value in launchd plist format.
 */
function renderValue(value) {
  const indent = "  ";

  if (typeof value === "string") {
    return `${indent}<string>${escapeXml(value)}</string>`;
  } else if (typeof value === "number") {
    return `${indent}<integer>${value}</integer>`;
  } else if (typeof value === "boolean") {
    return `${indent}<${value ? "true" : "false"}/>`;
  } else if (Array.isArray(value)) {
    const items = value.map((item) => renderValue(item));
    return `${indent}<array>\n${items.join("\n")}\n${indent}</array>`;
  } else if (typeof value === "object" && value !== null) {
    const items = [];
    for (const [k, v] of Object.entries(value)) {
      items.push(`${indent}  <key>${escapeXml(k)}</key>`);
      items.push(renderValue(v).substring(indent.length)); // Dedent one level since we're inside dict.
    }
    return `${indent}<dict>\n${items.join("\n")}\n${indent}</dict>`;
  }

  throw new Error(`Unsupported plist value type: ${typeof value}`);
}

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
