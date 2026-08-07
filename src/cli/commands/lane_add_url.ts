/**
 * commands/lane_add_url.ts (P8; config→db Phase 4, Task 7) — `lane add-url
 * <url> [label] --profile <p>`: appends a LinkedIn saved-search URL to the
 * profile's `search_urls.md` config doc under the right channel/page-type
 * node, after stripping ephemeral query params that change per click/
 * session/alert (a stable URL is what lets a rerun dedup against the same
 * saved search). Faithful TS port of v0 `scripts/setup/add_url.js` — see
 * that file's header for the rationale behind each stripped param and the
 * `f_TPR` absolute-vs-relative distinction.
 *
 * `search_urls.md` is read/written through the injected `ConfigStore`
 * seam (`LaneAddUrlDeps.configStore`, default `wireConfigStore` — a
 * plain function import from `../wire/index.ts`, never `src/adapters/**`
 * directly), not raw `readFile`/`writeFile` — this command is a
 * meaningful write action, so the default store opens readwrite. The
 * SEPARATE `exists(inventoryPath)` check below is unrelated: it checks a
 * PROGRAM file shipped inside the package itself, under
 * `src/adapters/lanes/linkedin/page_inventory/` — resolved from this
 * file's own install location (`import.meta.url`, same pattern as
 * `commands/setup.ts`'s `packageRoot`/`commands/board.ts`'s `uiDir`),
 * never `resolved.root` (the data home; fix round — probing it against
 * `root` always missed on a real install, since an installed
 * `~/.jobbunny` has no `src/` tree at all, so this command false-alarmed
 * "no inventory yet" even for page-types that ship in the package). Stays
 * on plain fs access, not a profile config doc.
 */
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigStore } from '../../ports/config_store.ts';
import { resolveHome } from '../home/index.ts';
import { wireConfigStore } from '../wire/index.ts';

/** This package's own `page_inventory/` — never `root` (the data home).
 * `src/cli/commands/lane_add_url.ts` is two directories below `src/`. */
const PACKAGE_PAGE_INVENTORY_DIR = fileURLToPath(
  new URL('../../adapters/lanes/linkedin/page_inventory/', import.meta.url),
);

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
  /** Test seam — a factory so each call scopes and closes its OWN
   * short-lived store, never a shared/memoized instance. Default binds
   * `wireConfigStore` to the FINAL resolved `root` — readwrite, this
   * command is a meaningful write action. */
  configStore: (profileName: string) => ConfigStore;
  mkdir: (path: string) => Promise<unknown>;
  write: (line: string) => void;
  warn: (line: string) => void;
}

/** Everything except `configStore`, whose default binds to the FINAL
 * resolved `root` (computed by `laneAddUrlCommand` after merging
 * overrides — same posture as `config.ts`/`setup.ts`). */
function defaultFsDeps(): Omit<LaneAddUrlDeps, 'configStore'> {
  return {
    root: resolveHome(),
    exists: (p) =>
      access(p, constants.F_OK)
        .then(() => true)
        .catch(() => false),
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
  const fsDeps: Omit<LaneAddUrlDeps, 'configStore'> = { ...defaultFsDeps(), ...deps };
  const resolved: LaneAddUrlDeps = {
    ...fsDeps,
    configStore:
      deps.configStore ?? ((name) => wireConfigStore(name, { root: fsDeps.root })),
  };

  const u = stripEphemerals(opts.url);
  const { channel, page } = resolvePage(u);
  const cleanUrl = u.toString();
  const line = `  • ${opts.label || 'unlabeled'} - ${cleanUrl}`;

  const profileDir = path.join(resolved.root, 'profiles', opts.profile);
  await resolved.mkdir(profileDir);

  const store = resolved.configStore(opts.profile);
  try {
    let text = (await store.readText('search_urls.md')) ?? '# Search URLs\n';

    const channelHeading = `## ${channel}`;
    const pageHeading = `### ${page}`;

    if (!text.split('\n').includes(channelHeading)) {
      text = `${text.replace(/\n*$/, '\n')}\n${channelHeading}\n`;
    }
    if (!text.split('\n').includes(pageHeading)) {
      // add the page node (with inventory pointer) right after the channel heading
      text = text.replace(
        channelHeading,
        `${channelHeading}\n${pageHeading}\n<!-- inventory: src/adapters/lanes/linkedin/page_inventory/${page}.json -->`,
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

    await store.writeText('search_urls.md', text);
  } finally {
    store.close();
  }

  resolved.write(`[lane add-url] stripped ${EPHEMERAL.join(', ')}`);
  resolved.write(`[lane add-url] appended under ${channel} / ${page}: ${cleanUrl}`);

  const inventoryPath = path.join(PACKAGE_PAGE_INVENTORY_DIR, `${page}.json`);
  if (!(await resolved.exists(inventoryPath))) {
    resolved.warn(
      `[lane add-url] no inventory yet for "${page}" — run /page-analyse before /run.`,
    );
  }

  return 0;
}
