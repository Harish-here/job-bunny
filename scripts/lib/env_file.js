// scripts/lib/env_file.js — shared .env read/write-key helpers, previously duplicated
// between setup/init.js and setup/notify_setup.js.

import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { ENV_PATH } from "./config.js";

const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

export async function readEnvFile(path = ENV_PATH) {
  if (!(await exists(path))) return {};
  const text = await readFile(path, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// Read-modify-write: replaces an existing KEY=... line in place, else appends one.
export async function writeEnvKey(key, value, path = ENV_PATH) {
  let text = (await exists(path)) ? await readFile(path, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) text = text.replace(re, line);
  else text = text.replace(/\n*$/, "\n") + line + "\n";
  await writeFile(path, text);
}

// Read-modify-write: strips an existing KEY=... line (and its trailing newline) if
// present, else no-ops. Mirrors writeEnvKey's regex-based line-replace approach.
export async function removeEnvKey(key, path = ENV_PATH) {
  if (!(await exists(path))) return;
  let text = await readFile(path, "utf8");
  const re = new RegExp(`^${key}=.*\\n?`, "m");
  if (!re.test(text)) return;
  text = text.replace(re, "");
  await writeFile(path, text);
}
