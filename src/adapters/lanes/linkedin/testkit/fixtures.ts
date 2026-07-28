import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FilterConfigSchema } from '../../../../core/filter/config.ts';
import { type JD, JDSchema } from '../../../../core/jd/index.ts';
import type { Logger, RunContext } from '../../../../ports/context.ts';
import type { LinkedinBreakerDeps, LinkedinBreakerState } from '../breaker_store.ts';
import type { Inventory } from '../inventory.ts';
import { InventorySchema } from '../inventory.ts';
import type { Script } from './browser_fakes.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

export async function realInventory(): Promise<Inventory> {
  const raw = JSON.parse(
    await readFile(
      `${REPO_ROOT}src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json`,
      'utf8',
    ),
  );
  const inv = InventorySchema.parse(raw);
  assert.equal(inv.pageType, 'details-page');
  return inv;
}

/** The real committed inventory pinned to `maxPages: '1'` — used by every
 * test in this file that is NOT about pagination itself. The committed
 * `src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json`
 * declares real (now-live)
 * pagination behaviors, so leaving it unpinned would make every one of
 * those tests silently attempt a page 2 (and beyond) against a fixture
 * `Script` that never scripted one, which is unrelated noise for tests
 * whose whole point is something else (jitter counts, dedup, cap, resume
 * state, etc.). The pagination-specific tests below use `realInventory()`
 * directly and set their own `maxPages` via `pagedInventory`. */
export async function singlePageInventory(): Promise<Inventory> {
  return pagedInventory(await realInventory(), { maxPages: '1' });
}

/** Clones a real inventory with `behaviors` overridden/extended — used by
 * the pagination tests to pin `maxPages`/`minJobCards`/etc without needing
 * a second on-disk fixture file per scenario. `behaviors: {}` (no spread)
 * models an inventory with no pagination declared at all (backward-compat
 * test). */
export function pagedInventory(
  inv: Inventory,
  overrides: Record<string, string>,
): Inventory {
  return { ...inv, behaviors: { ...inv.behaviors, ...overrides } };
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function fakeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
    beat() {},
    ...overrides,
  };
}

export const BREAKER_DIR = '/repo/.chrome-debug';

/** In-memory stand-in for the breaker file plus a frozen clock. The lane
 * only ever sees LinkedinBreakerDeps, so nothing here touches a real fs. */
export function fakeBreakerFs(initial: LinkedinBreakerState | undefined, now: Date) {
  const disk: { raw: string | undefined } = {
    raw: initial === undefined ? undefined : JSON.stringify(initial),
  };
  const writes: string[] = [];
  const unlinks: string[] = [];
  const deps: LinkedinBreakerDeps = {
    existsSync: () => disk.raw !== undefined,
    readFileSync: () => {
      if (disk.raw === undefined) throw new Error('ENOENT: no breaker file');
      return disk.raw;
    },
    writeFileSync: (_path, data) => {
      disk.raw = data;
      writes.push(data);
    },
    mkdirSync: () => {},
    unlinkSync: (path) => {
      disk.raw = undefined;
      unlinks.push(path);
    },
    now: () => now,
  };
  const current = (): LinkedinBreakerState | undefined =>
    disk.raw === undefined ? undefined : (JSON.parse(disk.raw) as LinkedinBreakerState);
  return { deps, writes, unlinks, current };
}

export const URL_1 =
  'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400&sortBy=R';
export const URL_2 =
  'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400&sortBy=R';
export const URL_3 =
  'https://www.linkedin.com/jobs/search/?keywords=Principal+Frontend+Engineer&f_TPR=r86400&sortBy=R';

export function fixtureFilterConfig() {
  return FilterConfigSchema.parse({ companies: { avoid: ['Bad Co'] } });
}

/** A previously-flushed capture, as CaptureStore would have persisted it —
 * used to seed CAPTURE_PATH directly in the fake Storage. */
export function fakeCapturedJD(id: string, company = 'Acme'): JD {
  return JDSchema.parse({
    identity: {
      id,
      lane: 'linkedin',
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      company,
      title: 'Frontend Engineer',
      scrapedAt: '2026-07-20T09:00:00.000Z',
    },
    content: { rawText: `JD text — ${id}` },
  });
}

/** url1: Acme (keep), Bad Co (gated out), Globex (keep).
 * url2: Acme (keep, dedup company w/ url1), Initech (keep). */
export function seedHappyPathScript(script: Script): void {
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/1001/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/1002/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/1003/',
    },
  ]);
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Staff Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/2001/',
    },
    {
      title: 'Staff Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/2002/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/1001/', 'JD text — Acme FE');
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/1003/',
    'JD text — Globex FE',
  );
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/2001/',
    'JD text — Acme Staff',
  );
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/2002/',
    'JD text — Initech Staff',
  );
}

/** Seeds one url with a single gate-passing card whose JD opens cleanly —
 * just enough for the url loop to complete an iteration and move on. */
export function seedTrivialUrl(script: Script, url: string, jobId: string): void {
  script.harvestByUrl.set(url, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: `/jobs/view/${jobId}/`,
    },
  ]);
  script.jdTextByUrl.set(
    `https://www.linkedin.com/jobs/view/${jobId}/`,
    `JD text — ${jobId}`,
  );
}

/** Records every jitter delay this lane applies — (ms, whether ctx.signal
 * was passed through) — without ever really waiting. Used by both the
 * card-loop and url-loop jitter-placement tests below (assert §2/§3 of
 * the fix's DONE-WHEN) and by the abort test (assert §5, real default
 * sleepFn from core/async, no fake needed there — see that test). */
export function spySleepFn(
  calls: number[],
): (ms: number, signal: AbortSignal) => Promise<void> {
  return async (ms, signal) => {
    calls.push(ms);
    assert.ok(signal instanceof AbortSignal, 'jitter must be called with ctx.signal');
  };
}

export const NOW = new Date('2026-07-28T12:00:00.000Z');
/** Opened 1h before NOW: inside the 4h cooldown ⇒ phase `open`. */
export const OPENED_RECENTLY: LinkedinBreakerState = {
  openedAt: '2026-07-28T11:00:00.000Z',
  tripCount: 1,
};
/** Opened 6h before NOW: past the 4h cooldown ⇒ phase `half-open`. */
export const OPENED_LONG_AGO: LinkedinBreakerState = {
  openedAt: '2026-07-28T06:00:00.000Z',
  tripCount: 1,
};
