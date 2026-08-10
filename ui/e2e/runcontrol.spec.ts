/**
 * e2e coverage for spec §7's Runs list run-control states: dedup against
 * the real server, and four deterministic states (waiting-for-daemon,
 * expired, live progress + polling, stale heartbeat) produced by
 * stubbing `GET /api/profiles/<profile>/runs`, `/runs/<id>/events`, and
 * `/run-intents` — never by seeding a run or an intent into rajni's
 * shared sqlite fixture. The one test that touches the real server
 * (double-click dedup) proves the server's own partial unique index,
 * which is where dedup actually lives — a stub could never prove that —
 * and MUST delete the pending row it creates so nothing leaks into the
 * rest of this suite.
 */

import { expect, type Page, test } from '@playwright/test';

async function pinProfile(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('jobbunny.profile', 'rajni');
  });
}

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

interface IntentRow {
  id: number;
  requestedAt: string;
  status: 'pending' | 'claimed' | 'cancelled' | 'expired';
  claimedRunId: number | null;
}

interface RunProgress {
  stage: string;
  stageIndex: number;
  stageTotal: number;
  stageStartedAt: string;
  updatedAt: string;
  itemCurrent: number | null;
  itemTotal: number | null;
}

interface RunRow {
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

async function stubIntents(page: Page, rows: IntentRow[]): Promise<void> {
  await page.route('**/api/profiles/rajni/run-intents*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { rows } });
  });
}

async function stubRuns(
  page: Page,
  rows: RunRow[],
  counter?: { count: number },
): Promise<void> {
  await page.route('**/api/profiles/rajni/runs*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (counter) counter.count += 1;
    await route.fulfill({ json: { rows, total: rows.length, limit: 100, offset: 0 } });
  });
}

async function stubEvents(
  page: Page,
  runId: number,
  msgs: string[],
  counter?: { count: number },
): Promise<void> {
  await page.route(`**/api/profiles/rajni/runs/${runId}/events*`, async (route) => {
    if (counter) counter.count += 1;
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

async function stubRunDetail(page: Page, row: RunRow): Promise<void> {
  await page.route(`**/api/profiles/rajni/runs/${row.id}*`, async (route) => {
    if (route.request().url().includes('/events')) return route.fallback();
    await route.fulfill({
      json: { ...row, result: null, failure: null, syncDryrun: null },
    });
  });
}

// useRunControl now consumes the real GET /api/daemon (B25) — a stubbed
// pending intent is only genuinely 'queued' when the daemon itself reads
// 'running'; against the real e2e server (no daemon process alive) it would
// otherwise read 'daemon-down', which is a different state than this test
// means to cover.
async function stubDaemonRunning(page: Page): Promise<void> {
  await page.route('**/api/daemon*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      json: {
        state: 'running',
        pid: 123,
        startedAt: new Date().toISOString(),
        lastTickAt: new Date().toISOString(),
        inFlight: null,
        profiles: [],
      },
    });
  });
}

test('run control: double-clicking Run now against the real server dedupes to one pending intent', async ({
  page,
}) => {
  await page.goto('/#/triage');
  const runNow = page.getByTestId('run-now');
  await runNow.click();
  await runNow.click();

  let pendingId: number | undefined;
  try {
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/profiles/rajni/run-intents');
          const body = (await res.json()) as { rows: IntentRow[] };
          const pending = body.rows.filter((r) => r.status === 'pending');
          pendingId = pending[0]?.id;
          return pending.length;
        },
        { timeout: 10_000 },
      )
      .toBe(1);
  } finally {
    if (pendingId !== undefined) {
      const del = await page.request.delete(
        `/api/profiles/rajni/run-intents/${pendingId}`,
      );
      expect(del.ok()).toBe(true);
    }
  }
});

test('run control: a stubbed pending intent shows Queued (waiting for daemon) with a Cancel affordance', async ({
  page,
}) => {
  await stubDaemonRunning(page);
  await stubRuns(page, []);
  await stubIntents(page, [
    {
      id: 5001,
      requestedAt: new Date().toISOString(),
      status: 'pending',
      claimedRunId: null,
    },
  ]);
  await page.goto('/#/triage');

  await expect(page.getByTestId('run-now')).toHaveText('Queued (waiting for daemon)');
  await expect(page.getByTestId('run-now-secondary')).toHaveText('Cancel');
});

test("run control: a stubbed expired intent shows Daemon isn't running with a Queue again affordance", async ({
  page,
}) => {
  const old = new Date(Date.now() - 15 * 60_000).toISOString();
  await stubRuns(page, []);
  await stubIntents(page, [
    { id: 5002, requestedAt: old, status: 'expired', claimedRunId: null },
  ]);
  await page.goto('/#/triage');

  await expect(page.getByTestId('run-now')).toHaveText("Daemon isn't running");
  await expect(page.getByTestId('run-now-secondary')).toHaveText('Queue again');
  await expect(
    page.getByText('Start the daemon with: jobbunny serve start'),
  ).toBeVisible();
});

test('run control: a stubbed running run with stage progress renders the live header and keeps polling', async ({
  page,
}) => {
  const runId = 9001;
  const now = new Date().toISOString();
  const running: RunRow = {
    id: runId,
    date: '2026-08-08',
    timeDir: '09-00',
    kind: 'run',
    resumedFrom: null,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    heartbeatAt: now,
    progress: {
      stage: 'filter',
      stageIndex: 7,
      stageTotal: 10,
      stageStartedAt: now,
      updatedAt: now,
      itemCurrent: null,
      itemTotal: null,
    },
  };
  // Progress now lives on the polled `runs` list row itself (R3), not on a
  // separately-polled events fetch — so the "genuinely live" proof below
  // counts `runs`-list GETs, not events GETs.
  const counter = { count: 0 };
  await stubIntents(page, []);
  await stubRuns(page, [running], counter);
  await stubEvents(page, runId, ['structure: done', 'filter: starting']);
  await stubRunDetail(page, running);

  await page.goto('/#/runs');
  await expect(page.getByTestId('live-run-header')).toBeVisible();
  await expect(page.getByTestId('live-run-stage')).toHaveText('Running — filter 7/10');
  await expect(page.getByTestId('run-now')).toHaveText('Running — filter 7/10');

  // Proves refetchInterval is genuinely live, not a one-shot render.
  await expect.poll(() => counter.count, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
});

test('run control: a stubbed running run with a stale heartbeat renders the stale heartbeat wording', async ({
  page,
}) => {
  const runId = 9002;
  const staleAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const running: RunRow = {
    id: runId,
    date: '2026-08-08',
    timeDir: '09-05',
    kind: 'run',
    resumedFrom: null,
    status: 'running',
    startedAt: staleAt,
    finishedAt: null,
    heartbeatAt: staleAt,
    progress: null,
  };
  await stubIntents(page, []);
  await stubRuns(page, [running]);
  await stubEvents(page, runId, []);
  await stubRunDetail(page, running);

  await page.goto('/#/runs');
  await expect(page.getByTestId('live-run-heartbeat')).toBeVisible();
  // B22 rewrote the copy from the fixed "No heartbeat for over 10 minutes"
  // to the exact-minutes ux-notes §9 wording — it never contains the
  // literal word "stale". Adjusted from the brief's /stale/i regex to the
  // real rendered wording, preserving the assertion's intent (the
  // stale-heartbeat state is shown) exactly.
  await expect(page.getByTestId('live-run-heartbeat')).toContainText(
    /No heartbeat for \d+m/,
  );
});
