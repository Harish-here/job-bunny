/**
 * Shared e2e stub idiom for the run-experience surface (`RunsPage` +
 * `RunNowButton`), extracted from `runcontrol.spec.ts` (which pioneered
 * it) so `run-experience.spec.ts` doesn't re-invent the same
 * `page.route` interception mechanics. Local types here mirror the real
 * response shapes (`src/app/features/runs/routes.ts`,
 * `ports/run_store.ts`) rather than importing them — same convention
 * `runcontrol.spec.ts` already used for its own `RunRow`/`IntentRow`.
 *
 * Every helper stubs against `**\/api/profiles/rajni/...` specifically —
 * this suite always pins the profile to `rajni` (`pinProfile`), the
 * committed synthetic fixture, never `harish`.
 */
import type { Page } from '@playwright/test';

export async function pinProfile(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('jobbunny.profile', 'rajni');
  });
}

export interface RunProgress {
  stage: string;
  stageIndex: number;
  stageTotal: number;
  stageStartedAt: string;
  updatedAt: string;
  itemCurrent: number | null;
  itemTotal: number | null;
}

export interface SoftErrorGroup {
  key: string;
  label: string;
  count: number;
  sample: string;
}

export interface SoftErrorSummary {
  total: number;
  groups: SoftErrorGroup[];
  breakerOpen: boolean;
}

export interface RunRow {
  id: number;
  date: string;
  timeDir: string | null;
  kind: 'run' | 'stage' | 'reconcile';
  resumedFrom: number | null;
  status: 'running' | 'passed' | 'failed' | 'crashed';
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  progress: RunProgress | null;
}

/** One `GET /runs` list row — `RunSummary` + the health-gate inputs
 * `classifyOutcome` needs (`app/features/runs/routes.ts`'s `RunListRow`). */
export type RunListRow = RunRow & { softErrors: SoftErrorSummary };

export interface FunnelStage {
  name: string;
  jobsIn: number;
  jobsOut: number;
  dropsByRule: Record<string, number>;
  elapsedMs: number;
  attempts: number;
}

/** Builds one `FunnelStage` row — the shape `getFunnelStages`
 * (`ui/src/features/runs/runResult.ts`) narrows `RunDetail.result.stages`
 * entries into. */
export function stage(
  name: string,
  jobsIn: number,
  jobsOut: number,
  dropsByRule: Record<string, number> = {},
  elapsedMs = 1000,
  attempts = 1,
): FunnelStage {
  return { name, jobsIn, jobsOut, dropsByRule, elapsedMs, attempts };
}

export interface RunFailure {
  stage: string;
  error: string;
  elapsedMs: number;
  lastCheckpoint?: string;
}

/** `GET /runs/:id` response — `RunDetail` (`ports/run_store.ts`): a
 * `RunRow` plus the three opaque blobs. */
export interface RunDetailFixture extends RunRow {
  result: { stages: FunnelStage[] } | null;
  failure: RunFailure | null;
  syncDryrun: unknown;
}

function makeDefaultRow(overrides: Partial<RunRow> & { id: number }): RunRow {
  const now = new Date().toISOString();
  return {
    date: '2026-08-09',
    timeDir: '09-00',
    kind: 'run',
    resumedFrom: null,
    status: 'passed',
    startedAt: now,
    finishedAt: now,
    heartbeatAt: now,
    progress: null,
    ...overrides,
  };
}

/** Builds a full `RunRow`, defaulting every field a test doesn't care
 * about — callers pass only what the scenario needs to vary. */
export function makeRow(overrides: Partial<RunRow> & { id: number }): RunRow {
  return makeDefaultRow(overrides);
}

export async function stubIntents(
  page: Page,
  rows: {
    id: number;
    requestedAt: string;
    status: 'pending' | 'claimed' | 'cancelled' | 'expired';
    claimedRunId: number | null;
  }[],
): Promise<void> {
  await page.route('**/api/profiles/rajni/run-intents*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { rows } });
  });
}

export async function stubRunsList(page: Page, rows: RunListRow[]): Promise<void> {
  await page.route('**/api/profiles/rajni/runs*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = route.request().url();
    // Excludes every nested per-run path — `/runs`, matched loosely by
    // the glob above, must only handle the bare list request; `:id`,
    // `:id/events`, and `:id/soft-errors` are separately-registered
    // routes below, each falling through here otherwise (Playwright
    // resolves the most-recently-registered route first).
    if (/\/runs\/\d+/.test(url)) return route.fallback();
    await route.fulfill({ json: { rows, total: rows.length, limit: 100, offset: 0 } });
  });
}

/** Stubs `GET /runs/:id` for exactly one run — the detail pane's
 * hydration fetch, and (for `passed`/`crashed` list rows) the list
 * pane's own bulk-classification fetch (`RunsPage.tsx`'s
 * `detailQueries`), which shares the same query key and therefore the
 * same route. */
export async function stubRunDetail(page: Page, detail: RunDetailFixture): Promise<void> {
  await page.route(`**/api/profiles/rajni/runs/${detail.id}*`, async (route) => {
    const url = route.request().url();
    if (url.includes('/events') || url.includes('/soft-errors')) return route.fallback();
    await route.fulfill({ json: detail });
  });
}

export async function stubSoftErrors(
  page: Page,
  id: number,
  summary: SoftErrorSummary,
): Promise<void> {
  await page.route(`**/api/profiles/rajni/runs/${id}/soft-errors*`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: summary });
  });
}

export async function stubEvents(page: Page, id: number, msgs: string[]): Promise<void> {
  await page.route(`**/api/profiles/rajni/runs/${id}/events*`, async (route) => {
    const now = new Date().toISOString();
    await route.fulfill({
      json: {
        rows: msgs.map((msg) => ({ ts: now, level: 'info', msg })),
        total: msgs.length,
        limit: 500,
        offset: 0,
      },
    });
  });
}

/** Fulfills the FIRST `GET /runs` request with `rows`, then 500s every
 * request after — the shape a poll-goes-disconnected test needs: the
 * strip mounts alive off a genuine success, then every subsequent poll
 * tick (and its own query-level retry) fails, without ever touching
 * `stubRunsList`'s single fixed response. */
export async function stubRunsListOnceThenFail(
  page: Page,
  rows: RunListRow[],
): Promise<void> {
  let calls = 0;
  await page.route('**/api/profiles/rajni/runs*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = route.request().url();
    if (/\/runs\/\d+/.test(url)) return route.fallback();
    calls += 1;
    if (calls === 1) {
      await route.fulfill({ json: { rows, total: rows.length, limit: 100, offset: 0 } });
      return;
    }
    await route.fulfill({
      status: 500,
      json: { error: { code: 'boom', message: 'server error' } },
    });
  });
}

/** Stubs a single run end-to-end: list (one row) + detail + soft-errors +
 * events — everything `RunsPage` needs once it auto-selects the (only)
 * newest row. Covers the common "one detail-pane state" test shape used
 * by every `S3`-`S7`-style scenario in `run-experience.spec.ts`. */
export async function mountSingleRun(
  page: Page,
  opts: {
    row: RunListRow;
    detail: RunDetailFixture;
    softErrors?: SoftErrorSummary;
    events?: string[];
  },
): Promise<void> {
  await stubIntents(page, []);
  await stubRunsList(page, [opts.row]);
  await stubRunDetail(page, opts.detail);
  await stubSoftErrors(
    page,
    opts.row.id,
    opts.softErrors ?? { total: 0, groups: [], breakerOpen: false },
  );
  await stubEvents(page, opts.row.id, opts.events ?? []);
}

/** GET /api/daemon -> 500 — `daemonQuery()`'s `data` never resolves, so
 * `useRunControl` collapses it to `null` (C16: a probe that hasn't
 * resolved must never be mistaken for a resolved "daemon is down"),
 * which is exactly the `daemon-unknown` classification. */
export async function stubDaemonUnreachable(page: Page): Promise<void> {
  await page.route('**/api/daemon*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 500,
      json: { error: { code: 'unavailable', message: 'daemon probe failed' } },
    });
  });
}

export interface DaemonProfileScheduleFixture {
  profile: string;
  enabled: boolean;
  nextRunAt: string | null;
  degraded: boolean;
  degradedReason: string | null;
}

/** GET /api/daemon -> 200, a full DaemonStatus payload with the given
 * `profiles` array — for scenarios that need the daemon status query to
 * resolve successfully with specific per-profile degraded state, unlike
 * `stubDaemonUnreachable` above (which simulates the probe itself
 * failing). */
export async function stubDaemonStatus(
  page: Page,
  profiles: DaemonProfileScheduleFixture[],
): Promise<void> {
  await page.route('**/api/daemon*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      json: {
        state: 'running',
        pid: 4242,
        startedAt: '2026-08-13T09:00:00.000Z',
        lastTickAt: new Date().toISOString(),
        inFlight: null,
        profiles,
      },
    });
  });
}

/** Shared "wait for the poll to genuinely retry" timeout — the daemon
 * query's default `retry: 1` backs off ~1s before settling into its
 * error state, so assertions gated on that need more than Playwright's
 * default 5s in slower CI environments. */
export const DAEMON_SETTLE_TIMEOUT_MS = 10_000;
