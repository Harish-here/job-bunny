// scripts/add_url.js — append a LinkedIn saved-search URL to search_urls.md under the right
// Channel → page node, after stripping ephemeral query params. Warns if that page-type has no
// inventory yet. Usage: node scripts/add_url.js "<url>" ["<label>"]

import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URLS = join(ROOT, "search_urls.md");

// Ephemeral params that change per click/session — stripped so the same search dedups.
const EPHEMERAL = ["currentJobId", "referralSearchId", "origin", "originToLandingJobPostings"];

const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

export function stripEphemerals(rawUrl) {
  const u = new URL(rawUrl);
  for (const p of EPHEMERAL) u.searchParams.delete(p);
  return u;
}

// Resolve channel + page-type from the URL. v0 knows LinkedIn jobs search; extend as lanes grow.
export function resolvePage(u) {
  if (u.hostname.endsWith("linkedin.com") && u.pathname.startsWith("/jobs/search")) {
    return { channel: "linkedin", page: "linkedin__jobs-search" };
  }
  throw new Error(`No page-type mapping for ${u.hostname}${u.pathname} — add one in resolvePage().`);
}

async function main() {
  const [rawUrl, label] = process.argv.slice(2);
  if (!rawUrl) throw new Error('Usage: node scripts/add_url.js "<url>" ["<label>"]');

  const u = stripEphemerals(rawUrl);
  const { channel, page } = resolvePage(u);
  const cleanUrl = u.toString();
  const line = `  • ${label || "unlabeled"} - ${cleanUrl}`;

  let text = (await exists(URLS)) ? await readFile(URLS, "utf8") : "# Search URLs\n";
  const lines = text.split("\n");

  const channelHeading = `## ${channel}`;
  const pageHeading = `### ${page}`;

  if (!lines.includes(channelHeading)) {
    text = text.replace(/\n*$/, "\n") + `\n${channelHeading}\n`;
  }
  if (!text.split("\n").includes(pageHeading)) {
    // add the page node (with inventory pointer) right after the channel heading
    text = text.replace(
      channelHeading,
      `${channelHeading}\n${pageHeading}\n<!-- inventory: page_inventory/${page}.md -->`
    );
  }

  // insert the URL line after the page heading's inventory comment (or the heading itself)
  const arr = text.split("\n");
  let idx = arr.indexOf(pageHeading);
  while (idx + 1 < arr.length && (arr[idx + 1].startsWith("<!--") || arr[idx + 1].trim() === "")) idx++;
  arr.splice(idx + 1, 0, line);
  text = arr.join("\n");

  await writeFile(URLS, text);
  console.log(`[add-url] stripped ${EPHEMERAL.join(", ")}`);
  console.log(`[add-url] appended under ${channel} / ${page}: ${cleanUrl}`);

  if (!(await exists(join(ROOT, "page_inventory", `${page}.md`)))) {
    console.warn(`[add-url] ⚠ no inventory yet for "${page}" — run /page-analyse before /run.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[add-url] FAILED: ${err.message}`);
    process.exit(1);
  });
}
