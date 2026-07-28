/**
 * cli/wire/builders.ts (P8, split from wire.ts) — live adapter construction
 * for connectors/notifiers/routines/lanes: `buildConnector`, `buildNotifier`,
 * `buildRoutine`, `isFarmingLane`, `isApiLane`, `buildLanes`, and
 * `buildLinkedInLane`. Sibling to `compose.ts` in the
 * `only-wire-imports-adapters` carve-out (`.dependency-cruiser.cjs`) — split
 * out purely to keep `compose.ts` under the 400-line file-size cap, not for
 * any behavioral reason.
 */
import path from 'node:path';
import type { CdpChromeProvider } from '../../adapters/browser/cdp-chrome/index.ts';
import { DEFAULT_USER_DATA_DIR } from '../../adapters/browser/cdp-chrome/index.ts';
import type { NotionApi } from '../../adapters/db/notion/index.ts';
import { NotionConnector } from '../../adapters/db/notion/index.ts';
import { GreenhouseLane } from '../../adapters/lanes/greenhouse/index.ts';
import { KekaLane } from '../../adapters/lanes/keka/index.ts';
import {
  defaultLinkedinBreakerDeps,
  LinkedInLane,
  loadInventory,
  parseSearchUrls,
} from '../../adapters/lanes/linkedin/index.ts';
import { TelegramNotifier } from '../../adapters/notify/telegram/index.ts';
import type { PipelineConfig } from '../../core/config/schema.ts';
import type { FilterConfig } from '../../core/filter/config.ts';
import type { ApiLane, FarmingLane, Lane } from '../../ports/lane.ts';
import type { Storage } from '../../ports/storage.ts';
import { cleanupRoutine } from '../../routines/cleanup/index.ts';
import type { Routine } from '../../routines/types.ts';
import { isNotFound } from './config.ts';
import {
  resolveInterUrlDelayRange,
  resolveJitterRange,
  resolveMaxCardsPerUrl,
} from './settings.ts';

// --- live adapter construction (ctx/ports/stages/routines) ---

export function buildConnector(name: string, settings: unknown, api: NotionApi) {
  if (name === 'notion') return new NotionConnector(settings, api);
  throw new Error(`unknown connector "${name}"`);
}

export function buildNotifier(name: string, settings: unknown) {
  if (name === 'telegram') return new TelegramNotifier(settings);
  throw new Error(`unknown notifier "${name}"`);
}

export function buildRoutine(name: string): Routine {
  if (name === 'cleanup') return cleanupRoutine;
  throw new Error(`unknown routine "${name}"`);
}

export function isFarmingLane(lane: Lane): lane is FarmingLane {
  return lane.kind === 'farming';
}

export function isApiLane(lane: Lane): lane is ApiLane {
  return lane.kind === 'api';
}

export interface LiveLaneDeps {
  profileName: string;
  root: string;
  readFile: (path: string) => Promise<string>;
  /** Repo-root — inventories only (see `RuntimeDeps.storage`). */
  storage: Storage;
  /** `profiles/<name>/data` — the lane's own resume/capture state. */
  profileStorage: Storage;
  filterCfg: FilterConfig | undefined;
  browser: CdpChromeProvider;
}

/** Builds the live `Lane[]` for `config.lanes`. Unlike the check-registry
 * (which merely reports whether inventories/CDP are reachable), building
 * the `linkedin` lane for real needs its `SearchUrlGroup[]` and
 * `Inventory[]` up front — both are read here, fail-loud, rather than
 * deferred into the lane's own `source()` call. */
export async function buildLanes(
  config: PipelineConfig,
  deps: LiveLaneDeps,
): Promise<Lane[]> {
  const lanes: Lane[] = [];
  for (const name of config.lanes) {
    switch (name) {
      case 'linkedin':
        lanes.push(
          await buildLinkedInLane(
            deps,
            resolveMaxCardsPerUrl(config.settings.linkedin),
            resolveJitterRange(config.settings.linkedin),
            resolveInterUrlDelayRange(config.settings.linkedin),
          ),
        );
        break;
      case 'greenhouse':
        lanes.push(new GreenhouseLane());
        break;
      case 'keka':
        lanes.push(new KekaLane());
        break;
      default:
        throw new Error(`unknown lane "${name}"`);
    }
  }
  return lanes;
}

async function buildLinkedInLane(
  deps: LiveLaneDeps,
  maxCardsPerUrl: number,
  jitterRange: { minMs: number; maxMs: number },
  interUrlDelayRange: { minMs: number; maxMs: number },
): Promise<LinkedInLane> {
  if (!deps.filterCfg) {
    throw new Error(
      `linkedin lane requires profiles/${deps.profileName}/filter.json (a FilterConfig)`,
    );
  }
  const searchUrlsPath = path.join(
    deps.root,
    'profiles',
    deps.profileName,
    'search_urls.md',
  );
  let md: string;
  try {
    md = await deps.readFile(searchUrlsPath);
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(
        `linkedin lane requires profiles/${deps.profileName}/search_urls.md`,
      );
    }
    throw err;
  }
  const urls = parseSearchUrls(md);
  const pages = [...new Set(urls.map((group) => group.page))];
  const inventories = await Promise.all(
    pages.map((page) => loadInventory(deps.storage, page)),
  );
  // Inventories come off the shared repo-root handle above; the lane's own
  // resume/capture state is per-profile and must NOT.
  return new LinkedInLane(
    deps.browser,
    inventories,
    urls,
    deps.filterCfg,
    deps.profileStorage,
    maxCardsPerUrl,
    jitterRange.minMs,
    jitterRange.maxMs,
    undefined, // randomFn: real Math.random
    undefined, // sleepFn: real abort-aware core/async sleep
    interUrlDelayRange.minMs,
    interUrlDelayRange.maxMs,
    // Session-scoped, shared by every profile (D11): the throttle belongs
    // to the `.chrome-debug` Chrome profile whose cookies every profile
    // farms through, not to any one profile's data dir. Passed as a plain
    // string because `adapters-no-cross-family` forbids the lane importing
    // `adapters/browser/**` itself.
    { userDataDir: DEFAULT_USER_DATA_DIR, deps: defaultLinkedinBreakerDeps() },
  );
}
