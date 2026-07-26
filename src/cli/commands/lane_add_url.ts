/**
 * commands/lane_add_url.ts (P8) — `lane add-url <url> [label] --profile <p>`:
 * appends a LinkedIn saved-search URL to `profiles/<p>/search_urls.md`
 * under the right channel/page-type node, after stripping ephemeral
 * query params that change per click/session/alert (a stable URL is what
 * lets a rerun dedup against the same saved search). Faithful TS port of
 * v0 `scripts/setup/add_url.js` — see that file's header for the
 * rationale behind each stripped param and the `f_TPR` absolute-vs-
 * relative distinction.
 *
 * No `src/adapters/**` import — all filesystem access goes through
 * injected `LaneAddUrlDeps` so tests use a temp dir and never touch the
 * real `profiles/`.
 */
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Ephemeral params that change per click/session/alert — stripped so the same search dedups.
// "start" is a pagination offset, not a filter — always reset to beginning.
const EPHEMERAL = [
  'currentJobId',
  'referralSearchId',
  'origin',
  'originToLandingJobPostings',
  'savedSearchId',
  'alertAction',
  'trackingId',
  'refId',
  'eBP',
  'start',
];

export interface LaneAddUrlOptions {
  profile: string;
  url: string;
  label?: string;
}

export interface LaneAddUrlDeps {
  root: string;
  exists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<unknown>;
  write: (line: string) => void;
  warn: (line: string) => void;
}

function defaultDeps(): LaneAddUrlDeps {
  return {
    root: process.cwd(),
    exists: (p) =>
      access(p, constants.F_OK)
        .then(() => true)
        .catch(() => false),
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, data) => writeFile(p, data),
    mkdir: (p) => mkdir(p, { recursive: true }),
    write: (line) => console.log(line),
    warn: (line) => console.warn(line),
  };
}

/** Strips ephemeral per-click/session/alert query params, plus an
 * absolute `f_TPR` anchor (`a<epoch>-`, a per-alert "posted after this
 * exact moment" stamp that goes stale on a recurring search). A relative
 * window (`r<seconds>`, e.g. `r86400`) is a real filter and stays. */
export function stripEphemerals(rawUrl: string): URL {
  const u = new URL(rawUrl);
  for (const p of EPHEMERAL) u.searchParams.delete(p);
  const tpr = u.searchParams.get('f_TPR');
  if (tpr && /^a\d+/.test(tpr)) u.searchParams.delete('f_TPR');
  return u;
}

export interface ResolvedPage {
  channel: string;
  page: string;
}

/** Maps a stripped URL onto the `channel`/`page` node it belongs under in
 * `search_urls.md`. Throws loudly for anything with no known mapping —
 * a silent fallback would mean the URL is filed under the wrong
 * inventory (or none) and quietly never gets extracted. */
export function resolvePage(u: URL): ResolvedPage {
  if (u.hostname.endsWith('linkedin.com')) {
    if (
      /^\/jobs\/search\/?$/.test(u.pathname) ||
      u.pathname.startsWith('/jobs/collections/')
    ) {
      return { channel: 'linkedin', page: 'linkedin__jobs-search' };
    }
    if (/^\/jobs\/search-results\/?$/.test(u.pathname)) {
      return { channel: 'linkedin', page: 'linkedin__jobs-search-results' };
    }
  }
  throw new Error(
    `No page-type mapping for ${u.hostname}${u.pathname} — add one in resolvePage().`,
  );
}

export async function laneAddUrlCommand(
  opts: LaneAddUrlOptions,
  deps: Partial<LaneAddUrlDeps> = {},
): Promise<number> {
  const resolved: LaneAddUrlDeps = { ...defaultDeps(), ...deps };

  const u = stripEphemerals(opts.url);
  const { channel, page } = resolvePage(u);
  const cleanUrl = u.toString();
  const line = `  • ${opts.label || 'unlabeled'} - ${cleanUrl}`;

  const profileDir = path.join(resolved.root, 'profiles', opts.profile);
  await resolved.mkdir(profileDir);
  const urlsPath = path.join(profileDir, 'search_urls.md');

  let text = (await resolved.exists(urlsPath))
    ? await resolved.readFile(urlsPath)
    : '# Search URLs\n';

  const channelHeading = `## ${channel}`;
  const pageHeading = `### ${page}`;

  if (!text.split('\n').includes(channelHeading)) {
    text = `${text.replace(/\n*$/, '\n')}\n${channelHeading}\n`;
  }
  if (!text.split('\n').includes(pageHeading)) {
    // add the page node (with inventory pointer) right after the channel heading
    text = text.replace(
      channelHeading,
      `${channelHeading}\n${pageHeading}\n<!-- inventory: src/adapters/lanes/linkedin/page_inventory/${page}.md -->`,
    );
  }

  // insert the URL line after the page heading's inventory comment (or the heading itself)
  const arr = text.split('\n');
  let idx = arr.indexOf(pageHeading);
  while (
    idx + 1 < arr.length &&
    (arr[idx + 1]?.startsWith('<!--') || arr[idx + 1]?.trim() === '')
  )
    idx++;
  arr.splice(idx + 1, 0, line);
  text = arr.join('\n');

  await resolved.writeFile(urlsPath, text);
  resolved.write(`[lane add-url] stripped ${EPHEMERAL.join(', ')}`);
  resolved.write(`[lane add-url] appended under ${channel} / ${page}: ${cleanUrl}`);

  const inventoryPath = path.join(
    resolved.root,
    'src',
    'adapters',
    'lanes',
    'linkedin',
    'page_inventory',
    `${page}.md`,
  );
  if (!(await resolved.exists(inventoryPath))) {
    resolved.warn(
      `[lane add-url] no inventory yet for "${page}" — run /page-analyse before /run.`,
    );
  }

  return 0;
}
