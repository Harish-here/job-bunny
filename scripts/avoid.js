// scripts/avoid.js — Stage A avoid-list loader + matcher (used by extract.js on card data,
// before JDs are opened). Matching normalizes BOTH sides (lowercase, strip legal suffixes via
// util.normalizeName) and applies the alias map from avoid.md. Pure except for the file read,
// so the matcher is unit-testable without a browser.

import { readFile } from "node:fs/promises";
import { normalizeName } from "./util.js";
import { paths } from "./config.js";

const AVOID_PATH = paths().avoid;

// Parse avoid.md → { companies: Set<normalized>, aliases: Map<normalized, normalized> }.
// Company bullets live before the "## Alias map" heading; alias bullets ("- X → Y") after it.
export function parseAvoid(text) {
  const companies = new Set();
  const aliases = new Map();
  let inAliasSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^##\s+alias map/i.test(line)) {
      inAliasSection = true;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (!bullet) continue;
    const body = bullet[1].trim();
    if (!body) continue;
    if (inAliasSection) {
      const m = body.split(/\s*(?:→|->|=>)\s*/);
      if (m.length === 2) aliases.set(normalizeName(m[0]), normalizeName(m[1]));
    } else {
      companies.add(normalizeName(body));
    }
  }
  return { companies, aliases };
}

export async function loadAvoid(path = AVOID_PATH) {
  return parseAvoid(await readFile(path, "utf8"));
}

// True when a card's company should be dropped in Stage A.
export function isAvoided(companyName, { companies, aliases }) {
  let norm = normalizeName(companyName);
  if (aliases.has(norm)) norm = aliases.get(norm);
  return companies.has(norm);
}
