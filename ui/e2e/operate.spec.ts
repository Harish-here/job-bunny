/**
 * e2e coverage for the Operate page (blueprint step 29), superseding the
 * deleted `hub.spec.ts`. Cards other than Daemon (`ScheduledRunsCard`,
 * `SetupHealthCard`, `SecretsCard`) hit the REAL board server against the
 * committed `rajni` fixture — only `GET /api/daemon` and its three
 * mutation routes are stubbed, per test, for the scenarios this file
 * exists to prove. `card-linkedin` is deliberately out of scope (see
 * `OperatePage.tsx`'s own doc comment) and is asserted absent, never
 * built or stubbed.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  DAEMON_SETTLE_TIMEOUT_MS,
  type DaemonProfileScheduleFixture,
  pinProfile,
  stubDaemonUnreachable,
} from './run-fixtures';

interface DaemonStub {
  state: 'running' | 'stopped' | 'stale';
  degraded?: boolean;
  degradedReason?: string | null;
  schemaVersion?: number | null;
  buildVersion?: number | null;
  profiles?: DaemonProfileScheduleFixture[];
}

/** A settable `GET /api/daemon` stub — unlike `run-fixtures.ts`'s own
 * `stubDaemonStatus` (which hardcodes `state: 'running'`), this file needs
 * `stopped`/`stale`/degraded renders too, and (for the stop/start tests)
 * a state that changes mid-test to prove the card actually re-fetched. */
async function stubDaemon(
  page: Page,
  opts: DaemonStub,
): Promise<{ setState: (s: DaemonStub) => void }> {
  let current = opts;
  await page.route('**/api/daemon', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const entry: DaemonProfileScheduleFixture = current.profiles?.[0] ?? {
      profile: 'rajni',
      enabled: false,
      nextRunAt: null,
      degraded: current.degraded ?? false,
      degradedReason: current.degradedReason ?? null,
      schemaVersion: current.schemaVersion ?? null,
      buildVersion: current.buildVersion ?? null,
    };
    await route.fulfill({
      json: {
        state: current.state,
        pid: current.state === 'running' ? 4242 : null,
        startedAt: null,
        lastTickAt: new Date().toISOString(),
        inFlight: null,
        profiles: current.profiles ?? [entry],
      },
    });
  });
  return { setState: (s) => (current = s) };
}

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

test('operate: #/setup renders the four data-qa cards, and card-linkedin is absent', async ({
  page,
}) => {
  await page.goto('/#/setup');
  await expect(page.locator('[data-qa="operate-shell"]')).toBeVisible();
  for (const id of [
    'card-daemon',
    'card-scheduled-runs',
    'card-setup-health',
    'card-secrets',
  ]) {
    await expect(page.locator(`[data-qa="${id}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-qa="card-linkedin"]')).toHaveCount(0);
});

test('operate: the sidebar nav item reads Operate and routes to #/setup', async ({
  page,
}) => {
  await page.goto('/#/triage');
  await page.getByRole('button', { name: 'Operate', exact: true }).click();
  await expect(page).toHaveURL(/#\/setup/);
  await expect(page.locator('[data-qa="operate-shell"]')).toBeVisible();
});

test('daemon-start-stop: Stop -> stopped re-fetches to the stopped state and flips the button to Start', async ({
  page,
}) => {
  const daemon = await stubDaemon(page, { state: 'running' });
  await page.route('**/api/daemon/stop', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    daemon.setState({ state: 'stopped' });
    await route.fulfill({ json: { outcome: 'stopped' } });
  });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(card.getByText('Daemon stopped.')).toBeVisible();
  await expect(card.locator('[data-qa="daemon-state"]')).toContainText('Not running');
  await expect(card.getByRole('button', { name: 'Start' })).toBeVisible();
});

test('daemon-start-stop: Stop -> daemon_unresponsive renders a visibly distinct, non-success line', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'running' });
  await page.route('**/api/daemon/stop', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 409, json: { outcome: 'daemon_unresponsive' } });
  });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await card.getByRole('button', { name: 'Stop' }).click();
  const line = card.getByText(
    "The daemon didn't respond to the stop signal — check it manually.",
  );
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-destructive/);
  await expect(card.getByText('Daemon stopped.')).toHaveCount(0);
});

test('daemon-start-stop: Stop -> child_unresponsive names the in-flight pid', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'running' });
  await page.route('**/api/daemon/stop', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 409,
      json: { outcome: 'child_unresponsive', childPid: 123 },
    });
  });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(card.getByText(/pid 123/)).toBeVisible();
});

test('daemon-start-stop: Start shows the long-wait copy before a delayed response resolves', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'stopped' });
  await page.route('**/api/daemon/start', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ json: { outcome: 'started' } });
  });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await card.getByRole('button', { name: 'Start' }).click();
  await expect(card.getByText('Starting… this can take up to 35 seconds')).toBeVisible();
  await expect(card.getByText('Daemon started.')).toBeVisible({ timeout: 5000 });
});

test('daemon-autostart: darwin ok — the switch renders checked after a successful toggle', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'running' });
  let requestBody: unknown;
  await page.route('**/api/daemon/autostart', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    requestBody = route.request().postDataJSON();
    await route.fulfill({ json: { outcome: 'ok' } });
  });
  await page.goto('/#/setup');
  const toggle = page.locator('[data-qa="daemon-autostart"]');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByText('Autostart is darwin-only')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(requestBody).toEqual({ enabled: true });
});

test('daemon-autostart: unsupported_platform reverts to the static disabled-look row', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'running' });
  await page.route('**/api/daemon/autostart', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await route.fulfill({ json: { outcome: 'unsupported_platform' } });
  });
  await page.goto('/#/setup');
  await page.locator('[data-qa="daemon-autostart"]').click();
  await expect(page.getByText('Autostart is darwin-only')).toBeVisible();
  await expect(page.locator('[data-qa="daemon-autostart"]')).toBeDisabled();
});

test('daemon-autostart: a 409 autostart_conflict renders a distinct conflict line, rest of the card still renders', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'running' });
  await page.route('**/api/daemon/autostart', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'autostart_conflict',
          message: 'a legacy launchd plist already manages this',
        },
      },
    });
  });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await card.locator('[data-qa="daemon-autostart"]').click();
  await expect(
    card.getByText('Autostart error: a legacy launchd plist already manages this'),
  ).toBeVisible();
  await expect(card.getByText('Autostart is darwin-only')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Stop' })).toBeVisible();
});

test('daemon-pause-all: 2-of-4 failed actually invokes the mutation and names the failures', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'running' });
  const names = ['opctl-a', 'opctl-b', 'opctl-c', 'opctl-d'];
  const failing = new Set(['opctl-b', 'opctl-d']);
  const putCalls: string[] = [];

  await page.route('**/api/profiles', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/profiles') return route.fallback();
    await route.fulfill({
      json: {
        profiles: names.map((name) => ({ name, connector: 'sqlite', hasDb: true })),
      },
    });
  });
  await page.route('**/api/profiles/*/config/profile.json', async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split('/')[3] ?? '';
    if (!name.startsWith('opctl-')) return route.fallback();
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { text: '{}' } });
      return;
    }
    if (route.request().method() === 'PUT') {
      putCalls.push(name);
      if (failing.has(name)) {
        await route.fulfill({
          status: 500,
          json: { error: { code: 'write_failed', message: 'disk full' } },
        });
      } else {
        await route.fulfill({ json: { text: '{}' } });
      }
      return;
    }
    return route.fallback();
  });

  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await card.getByRole('button', { name: 'Pause all' }).click();

  await expect(card.getByText(/Paused 2 of 4 profiles/)).toBeVisible();
  await expect(card.getByText(/opctl-b failed: disk full/)).toBeVisible();
  await expect(card.getByText(/opctl-d failed: disk full/)).toBeVisible();
  // The "spy on the hook's mutate" proof: an inert button would leave
  // `putCalls` empty and every assertion above would still (wrongly) hold
  // only if the copy were hardcoded — this proves the real fan-out ran.
  expect(putCalls.sort()).toEqual([...names].sort());
});

test('daemon-state: degraded renders the schema-drift label plus the remedy command', async ({
  page,
}) => {
  await stubDaemon(page, {
    state: 'running',
    degraded: true,
    degradedReason: null,
    schemaVersion: 8,
    buildVersion: 7,
  });
  await page.goto('/#/setup');
  const word = page.locator('[data-qa="daemon-state"]');
  await expect(word).toContainText('Degraded — schema v8 > daemon build v7');
  await expect(word).toContainText('jobbunny serve stop && jobbunny serve start');
});

test('daemon-state: a healthy running daemon renders zero degraded markup', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'running' });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await expect(card.locator('[data-qa="daemon-state"]')).toContainText('Running');
  await expect(card.getByText(/Degraded/)).toHaveCount(0);
});

test('daemon-state: a network failure renders api-unreachable, distinct from degraded, with a working Retry', async ({
  page,
}) => {
  await stubDaemonUnreachable(page);
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await expect(card.getByText("Can't reach the daemon API")).toBeVisible();
  await expect(card.getByText(/Degraded/)).toHaveCount(0);

  await stubDaemon(page, { state: 'running' });
  await card.getByRole('button', { name: 'Retry' }).click();
  await expect(card.locator('[data-qa="daemon-state"]')).toContainText('Running', {
    timeout: DAEMON_SETTLE_TIMEOUT_MS,
  });
});

test('daemon: the loading skeleton renders before the probe resolves, then the healthy state', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/daemon', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await gate;
    await route.fulfill({
      json: {
        state: 'running',
        pid: 1,
        startedAt: null,
        lastTickAt: new Date().toISOString(),
        inFlight: null,
        profiles: [],
      },
    });
  });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await expect(card.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expect(card.locator('[data-qa="daemon-state"]')).toHaveCount(0);
  release?.();
  await expect(card.locator('[data-qa="daemon-state"]')).toContainText('Running');
});

test('daemon: the schedule-vs-daemon banner renders when stopped + an enabled schedule, absent when running', async ({
  page,
}) => {
  await page.route('**/api/profiles/rajni/config/profile.json*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      json: { text: JSON.stringify({ schedule: { enabled: true, times: ['09:00'] } }) },
    });
  });
  const daemon = await stubDaemon(page, { state: 'stopped' });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-daemon"]');
  await expect(card.getByRole('alert')).toContainText(
    "Scheduled for 09:00 but the daemon isn't running",
  );
  await expect(card.getByRole('alert')).toContainText('jobbunny serve start');

  daemon.setState({ state: 'running' });
  await page.reload();
  await expect(card.getByRole('alert')).toHaveCount(0);
});
