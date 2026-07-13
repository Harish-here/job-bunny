// scripts/setup/add_url.js — append a LinkedIn saved-search URL to search_urls.md under the right
// Channel → page node, after stripping ephemeral query params. Warns if that page-type has no
// inventory yet. Usage: node scripts/setup/add_url.js "<url>" ["<label>"]

import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { isMain } from "../lib/cli.js";
import { ROOT, paths, resolveProfileName } from "../lib/config.js";

// Ephemeral params that change per click/session/alert — stripped so the same search dedups.
// "start" is a pagination offset, not a filter — always reset to beginning.
const EPHEMERAL = [
  "currentJobId", "referralSearchId", "origin", "originToLandingJobPostings",
  "savedSearchId", "alertAction", "trackingId", "refId", "eBP", "start",
];

const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

export function stripEphemerals(rawUrl) {
  const u = new URL(rawUrl);
  for (const p of EPHEMERAL) u.searchParams.delete(p);
  // f_TPR absolute anchors (a<epoch>-) are a per-alert "posted after this exact moment" stamp that
  // goes stale on a recurring search — drop them. Relative windows (r<seconds>, e.g. r86400) stay.
  const tpr = u.searchParams.get("f_TPR");
  if (tpr && /^a\d+/.test(tpr)) u.searchParams.delete("f_TPR");
  return u;
}

export function resolvePage(u) {
  if (u.hostname.endsWith("linkedin.com")) {
    if (/^\/jobs\/search\/?$/.test(u.pathname) || u.pathname.startsWith("/jobs/collections/")) {
      return { channel: "linkedin", page: "linkedin__jobs-search" };
    }
    if (/^\/jobs\/search-results\/?$/.test(u.pathname)) {
      return { channel: "linkedin", page: "linkedin__jobs-search-results" };
    }
  }
  throw new Error(`No page-type mapping for ${u.hostname}${u.pathname} — add one in resolvePage().`);
}

async function main() {
  console.log(`[add-url] profile=${resolveProfileName()}`);
  const URLS = paths().searchUrls;
  const [rawUrl, label] = process.argv.slice(2);
  if (!rawUrl) throw new Error('Usage: node scripts/setup/add_url.js "<url>" ["<label>"]');

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

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[add-url] FAILED: ${err.message}`);
    process.exit(1);
  });
}
