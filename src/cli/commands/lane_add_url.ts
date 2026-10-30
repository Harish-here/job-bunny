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
import { classifyLinkedInSearchUrl } from '../../core/linkedin_url/index.ts';
import type { ConfigStore } from '../../ports/config_store.ts';
import { resolveHome } from '../home/index.ts';
import { wireConfigStore } from '../wire/index.ts';

/** This package's own `page_inventory/` — never `root` (the data home).
 * `src/cli/commands/lane_add_url.ts` is two directories below `src/`. */
const PACKAGE_PAGE_INVENTORY_DIR = fileURLToPath(
  new URL('../../adapters/lanes/linkedin/page_inventory/', import.meta.url),
);

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

/** Thin delegate to `core/linkedin_url` (spec R5) — that module owns the
 * canonical ephemeral-param/`f_TPR`-anchor stripping logic; this wrapper
 * only exists so callers/tests keep the existing exact signature. */
export function stripEphemerals(rawUrl: string): URL {
  return new URL(classifyLinkedInSearchUrl(rawUrl).cleanedUrl);
}

export interface ResolvedPage {
  channel: string;
  page: string;
}

/** Thin delegate to `core/linkedin_url` (spec R5) — that module owns the
 * canonical channel/page-type mapping (and throws
 * `UnrecognizedLinkedInSearchUrlError` for anything unmapped); this
 * wrapper only exists so callers/tests keep the existing exact
 * signature. */
export function resolvePage(u: URL): ResolvedPage {
  return { channel: 'linkedin', page: classifyLinkedInSearchUrl(u.toString()).page };
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

  const classification = classifyLinkedInSearchUrl(opts.url);
  const channel = 'linkedin';
  const { page, cleanedUrl: cleanUrl } = classification;
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

  resolved.write(
    `[lane add-url] stripped ${classification.removedParams.join(', ') || '(nothing)'}`,
  );
  resolved.write(`[lane add-url] appended under ${channel} / ${page}: ${cleanUrl}`);

  const inventoryPath = path.join(PACKAGE_PAGE_INVENTORY_DIR, `${page}.json`);
  if (!(await resolved.exists(inventoryPath))) {
    resolved.warn(
      `[lane add-url] no inventory yet for "${page}" — run /page-analyse before /run.`,
    );
  }

  return 0;
}
