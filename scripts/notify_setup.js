// scripts/notify_setup.js — guided Telegram setup for one profile.
// Usage: node scripts/notify_setup.js <profile>   (or JOBBUNNY_PROFILE / config.json default)
//
// Mirrors scripts/init.js's idioms (promptMasked / writeEnvKey / ensureToken for the
// shared secret) and scripts/doctor.js's checkCDP() bounded-poll pattern (for chat_id
// auto-detection). Assumes the profile already exists (run `/setup <profile>` first) —
// this script only adds/replaces the `notify` key.
//
// CRITICAL: profile.json is read-parse-merge-written, never overwritten wholesale.
// init.js's own writeIds() (at resolveNotion()) is the anti-pattern to avoid — it writes
// only `{notion_db_id, notion_parent_page_id}` and would silently destroy `schedule`/
// `notify` if reused as a template here.

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { ROOT, LEGACY } from "./config.js";
import { sendTelegram } from "./notifiers/telegram.js";

const ENV_PATH = join(ROOT, ".env");

const log = (msg) => console.log(`[notify-setup] ${msg}`);
const ok = (msg) => console.log(`[notify-setup] ✓ ${msg}`);

const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

// ---------- profile resolution ----------
async function resolveProfileArg() {
  if (LEGACY) {
    throw new Error(
      "This checkout uses the legacy layout (no config.json) — notify config lives in " +
        "profile.json, which legacy mode doesn't have. Run `node scripts/migrate.js <name>` first."
    );
  }
  const arg = process.argv[2] || process.env.JOBBUNNY_PROFILE;
  let name = arg;
  if (!name) {
    const cfgPath = join(ROOT, "config.json");
    if (await exists(cfgPath)) {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      name = cfg.default_profile;
    }
  }
  if (!name) {
    throw new Error("Usage: node scripts/notify_setup.js <profile>   (e.g. node scripts/notify_setup.js harish)");
  }
  const profileJsonPath = join(ROOT, "profiles", name, "profile.json");
  if (!(await exists(profileJsonPath))) {
    throw new Error(`profiles/${name}/profile.json not found — run \`/setup ${name}\` first.`);
  }
  return { name, profileJsonPath };
}

// ---------- .env helpers (mirrors init.js) ----------
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

// ---------- masked prompt (never echoes, never a CLI arg) — mirrors init.js ----------
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

// ---------- plain prompt (for the Y/n confirmation) ----------
function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function ensureToken(env) {
  if (env.TELEGRAM_BOT_TOKEN) {
    ok("TELEGRAM_BOT_TOKEN already present (shared across profiles)");
    return env.TELEGRAM_BOT_TOKEN;
  }
  console.log("");
  log("No Telegram bot yet? Create one via @BotFather:");
  log("  1. Open Telegram, search for @BotFather, start a chat.");
  log("  2. Send /newbot and follow the prompts (name + username).");
  log("  3. BotFather replies with a token like 123456789:AAF...  — copy it.");
  console.log("");
  const token = await promptMasked("Paste your Telegram bot token (hidden): ");
  if (!token) throw new Error("No token entered — aborting.");
  await writeEnvKey("TELEGRAM_BOT_TOKEN", token);
  process.env.TELEGRAM_BOT_TOKEN = token; // so sendTelegram() sees it later in this same run
  ok("TELEGRAM_BOT_TOKEN written to .env");
  return token;
}

// ---------- chat_id auto-detection: bounded poll, mirrors doctor.js's checkCDP() ----------
async function fetchUpdates(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data.result : null;
  } catch {
    return null;
  }
}

async function pollForChatId(token) {
  console.log("");
  log("Now message your bot on Telegram (any text, e.g. \"hi\") so we can detect your chat_id.");
  log("Polling getUpdates for up to 60s...");

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const updates = await fetchUpdates(token);
    if (updates && updates.length) {
      const last = updates[updates.length - 1];
      const msg = last.message;
      if (msg?.chat?.id) {
        return { chat_id: String(msg.chat.id), from: msg.from };
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// ---------- profile.json merge — never a wholesale overwrite ----------
async function mergeNotifyIntoProfile(profileJsonPath, chat_id) {
  const existing = JSON.parse(await readFile(profileJsonPath, "utf8"));
  const merged = {
    ...existing,
    notify: { telegram: { enabled: true, chat_id } },
  };
  await writeFile(profileJsonPath, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

// ---------- main ----------
async function main() {
  const { name, profileJsonPath } = await resolveProfileArg();
  log(`starting Telegram setup for profile "${name}"`);

  const env = await readEnv();
  const token = await ensureToken(env);

  const detected = await pollForChatId(token);
  if (!detected) {
    throw new Error("No message received within 60s — message your bot on Telegram, then re-run this script.");
  }

  const senderName = [detected.from?.first_name, detected.from?.last_name].filter(Boolean).join(" ") || "(unknown)";
  console.log("");
  log(`detected a message from "${senderName}" — chat_id=${detected.chat_id}`);
  const answer = await prompt("Use this chat_id? [Y/n] ");
  if (answer && /^n/i.test(answer)) {
    throw new Error("Aborted by user — re-run and message the bot again to retry.");
  }

  const merged = await mergeNotifyIntoProfile(profileJsonPath, detected.chat_id);
  ok(`profiles/${name}/profile.json updated — notify.telegram.enabled=true, chat_id=${detected.chat_id}`);
  log(`(schedule + all other existing keys preserved: ${Object.keys(merged).join(", ")})`);

  // Live test send — via sendTelegram() directly, not through notify(). sendTelegram()
  // never throws and never returns a result, so we watch console.warn during the call
  // to report explicit pass/fail here.
  console.log("");
  log("sending a live test message...");
  let warned = false;
  const origWarn = console.warn;
  console.warn = (...args) => {
    warned = true;
    origWarn(...args);
  };
  await sendTelegram({
    chat_id: detected.chat_id,
    severity: "info",
    title: "Job Bunny — Telegram connected",
    body: `Setup complete for profile "${name}". You'll get pipeline alerts here.`,
  });
  console.warn = origWarn;

  console.log("");
  if (warned) {
    console.log(`[notify-setup] ✗ FAIL — test message did not send (see warning above).`);
    process.exitCode = 1;
  } else {
    console.log(`[notify-setup] ✓ PASS — test message sent, check Telegram for "Job Bunny — Telegram connected".`);
  }
}

main().catch((err) => {
  console.error(`[notify-setup] FAILED: ${err.message}`);
  process.exit(1);
});
