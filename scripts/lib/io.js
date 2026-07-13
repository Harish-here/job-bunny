// scripts/lib/io.js — shared JSON file helpers for the pipeline's "explicit input →
// explicit output" contract: fail-loud reads, stable 2-space + trailing-newline writes.
// Soft-fail readers (cache.readCache's ENOENT→empty, the check_*.js exit-code probes,
// doctor's checks) deliberately do NOT use readJson — absence has meaning there.

import { readFile, writeFile } from "node:fs/promises";

// Throws `Cannot read/parse <path>: <msg>` — the message shape every stage already uses.
// `context` adds a parenthesized hint, e.g. readJson(p, "run generate_meta.js first").
export async function readJson(path, context = "") {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${path}${context ? ` (${context})` : ""}: ${err.message}`);
  }
}

export async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}
