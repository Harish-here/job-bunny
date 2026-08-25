/**
 * e2e coverage for the Operate page (blueprint step 29), superseding the
 * deleted `hub.spec.ts`. Cards other than Daemon (`ScheduledRunsCard`,
 * `SetupHealthCard`, `SecretsCard`) hit the REAL board server against the
 * committed `rajni` fixture — `GET /api/daemon` and its three mutation
 * routes are stubbed, per test, for the daemon-card scenarios this file
 * exists to prove; task 38's Scheduled runs/Setup & health/Secrets tests
 * additionally stub `GET /api/profiles/rajni/doctor` (`stubDoctor`) where a
 * specific finding shape is the point of the test, and drive
 * `PUT /api/secrets/:key` for real (guarded — see that test's own comment).
 * `card-linkedin` is deliberately out of scope (see `OperatePage.tsx`'s own
 * doc comment) and is asserted absent, never built or stubbed.
 */
import { expect, type Page, test } from '@playwright/test';
import { repoRoot, restoreEnvFile, snapshotEnvFile } from './env-guard';
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
    // `enabled: true` — the real backend (`scanProfileSchedules`, per its
    // own documented contract) can NEVER return a row with
    // `enabled: false`; it skips those profiles entirely rather than
    // listing them. `enabled: false` here used to assert a state the app
    // can't actually produce (fix-round finding).
    const entry: DaemonProfileScheduleFixture = current.profiles?.[0] ?? {
      profile: 'rajni',
      enabled: true,
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

interface Finding {
  check: string;
  status: 'ok' | 'warn' | 'red';
  detail: string;
}

/** A `GET /api/profiles/rajni/doctor` stub — mirrors the deleted
 * `hub.spec.ts`'s own `stubDoctor` helper (SURVIVE disposition: same
 * mechanics, new host file). Used only by the Setup & health tests below,
 * which need a specific finding shape (`status`/`check`/destination) the
 * committed rajni fixture's real doctor report can't be relied on to
 * produce. */
async function stubDoctor(
  page: Page,
  status: 'ok' | 'warn' | 'red',
  findings: Finding[],
): Promise<void> {
  await page.route('**/api/profiles/rajni/doctor', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { status, findings } });
  });
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

// B14 (QA settings-overhaul, round 2): `scheduled-runs-empty` (the B5 fix's
// §12 Empty state) was unit-pinned only — the same coverage shape that let
// B1 ship through 3,000+ green tests. Stubs zero scheduled profiles the
// same way `stubDaemon(page, { state, profiles })` already does elsewhere
// in this file — an empty `profiles: []` array is exactly what
// `ScheduledRunsCard.tsx`'s own empty-state branch checks for.
test('operate-schedule: an empty profiles[] renders scheduled-runs-empty with a working link to Settings → Schedule', async ({
  page,
}) => {
  await stubDaemon(page, { state: 'running', profiles: [] });
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-scheduled-runs"]');
  const empty = card.locator('[data-qa="scheduled-runs-empty"]');
  await expect(empty).toContainText(
    'No scheduled runs — enable a schedule in Settings → Schedule.',
  );
  await expect(card.locator('[data-qa^="schedule-row-"]')).toHaveCount(0);

  await empty.getByRole('link', { name: 'Settings → Schedule' }).click();
  await expect(page).toHaveURL(/#\/settings\/schedule$/);
});

// --- Scheduled runs (blueprint step 33's e2e half) ---------------------

async function fetchRajniProfileConfigText(page: Page): Promise<string> {
  const res = await page.request.get('/api/profiles/rajni/config/profile.json');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { text: string };
  return body.text;
}

async function putRajniProfileConfigText(page: Page, text: string): Promise<void> {
  const res = await page.request.put('/api/profiles/rajni/config/profile.json', {
    data: { text },
  });
  expect(res.ok()).toBe(true);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

test('operate-schedule: schedule-skip-next writes {date, slot} matching the stubbed next run, and shows the success chip', async ({
  page,
}) => {
  // `nextRunAt` is built off "now" so `expectedDate`/`expectedSlot` agree
  // with `ScheduledRunsCard.tsx`'s own `todayISODate`/`nextSlotFor` (both
  // local-time, not UTC) regardless of what day this test happens to run.
  const now = new Date();
  const expectedDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const expectedSlot = '23:59';
  const nextRunAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    0,
  ).toISOString();

  await stubDaemon(page, {
    state: 'running',
    profiles: [
      {
        profile: 'rajni',
        enabled: true,
        nextRunAt,
        degraded: false,
        degradedReason: null,
        schemaVersion: null,
        buildVersion: null,
      },
    ],
  });

  const original = await fetchRajniProfileConfigText(page);
  try {
    await page.goto('/#/setup');
    const card = page.locator('[data-qa="card-scheduled-runs"]');
    // `schedule-skip-next` only ever carries a `data-qa` on the ACTIVE
    // row (`ScheduledRunsCard.tsx`'s `ScheduleRow`) — the pinned profile
    // is `rajni`, the only entry this stub returns, so this button is
    // unambiguously rajni's.
    await card.locator('[data-qa="schedule-skip-next"]').click();
    await expect(card.getByText('Next run skipped')).toBeVisible();

    // Server round-trip, not the form's own echo (the e2e idiom this
    // suite follows throughout): re-fetch the doc the mutation wrote and
    // check its persisted `schedule.skipNext`.
    const saved = JSON.parse(await fetchRajniProfileConfigText(page)) as {
      schedule?: { skipNext?: { date: string; slot: string } };
    };
    expect(saved.schedule?.skipNext).toEqual({ date: expectedDate, slot: expectedSlot });
  } finally {
    await putRajniProfileConfigText(page, original);
  }
});

test('operate-schedule: schedule-pause-<profile> writes schedule.enabled=false through a real config PUT, and shows the Paused chip', async ({
  page,
}) => {
  await stubDaemon(page, {
    state: 'running',
    profiles: [
      {
        profile: 'rajni',
        enabled: true,
        nextRunAt: null,
        degraded: false,
        degradedReason: null,
        schemaVersion: null,
        buildVersion: null,
      },
    ],
  });

  const original = await fetchRajniProfileConfigText(page);
  try {
    await page.goto('/#/setup');
    const card = page.locator('[data-qa="card-scheduled-runs"]');
    // Re-review finding: the Pause button's `data-qa` is now per-row
    // (`schedule-pause-${profile}`), not active-row-only — the pinned
    // profile is `rajni`, the only entry this stub returns.
    await card.locator('[data-qa="schedule-pause-rajni"]').click();
    await expect(card.getByText('Paused')).toBeVisible();

    const saved = JSON.parse(await fetchRajniProfileConfigText(page)) as {
      schedule?: { enabled?: boolean };
    };
    expect(saved.schedule?.enabled).toBe(false);
  } finally {
    await putRajniProfileConfigText(page, original);
  }
});

test("operate-schedule: every row's Pause button carries its own profile-scoped data-qa and accessible name", async ({
  page,
}) => {
  // A second, non-active fixture-only row (`harish`) never gets clicked —
  // this test only proves per-row disambiguation is visible in the DOM,
  // it never PUTs against a profile the real board server doesn't have.
  await stubDaemon(page, {
    state: 'running',
    profiles: [
      {
        profile: 'rajni',
        enabled: true,
        nextRunAt: null,
        degraded: false,
        degradedReason: null,
        schemaVersion: null,
        buildVersion: null,
      },
      {
        profile: 'harish',
        enabled: true,
        nextRunAt: null,
        degraded: false,
        degradedReason: null,
        schemaVersion: null,
        buildVersion: null,
      },
    ],
  });

  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-scheduled-runs"]');
  await expect(card.locator('[data-qa="schedule-pause-rajni"]')).toBeVisible();
  await expect(card.locator('[data-qa="schedule-pause-harish"]')).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Pause schedule — rajni' }),
  ).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Pause schedule — harish' }),
  ).toBeVisible();
});

// --- Setup & health (blueprint step 35's e2e half) ----------------------

test('operate-health: all-ok findings collapse to a single summary line, with zero visible rows until the disclosure is opened', async ({
  page,
}) => {
  const findings: Finding[] = Array.from({ length: 5 }, (_, i) => ({
    check: `ok-check-${i}`,
    status: 'ok',
    detail: `check ${i} passing`,
  }));
  await stubDoctor(page, 'ok', findings);
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-setup-health"]');

  const trigger = card.getByRole('button', {
    name: 'Setup complete · 5/5 checks passing',
  });
  await expect(trigger).toBeVisible();
  // Radix's Accordion.Content unmounts (not merely hides) while closed —
  // zero `health-row-*` elements exist in the DOM at all until opened.
  await expect(card.locator('[data-qa^="health-row-"]')).toHaveCount(0);

  await trigger.click();
  await expect(card.locator('[data-qa^="health-row-"]')).toHaveCount(5);
});

test('operate-health: a warn finding with a cli-command destination renders a Copy button that writes the exact command to the clipboard', async ({
  page,
}) => {
  await stubDoctor(page, 'warn', [
    { check: 'daemon-liveness', status: 'warn', detail: 'the daemon is not running' },
  ]);
  // Chromium denies `clipboard-write` by default in a fresh Playwright
  // context (see `shell.spec.ts`'s identical grant for the same reason) —
  // without it `navigator.clipboard.writeText` throws `NotAllowedError`.
  await page.context().grantPermissions(['clipboard-write'], {
    origin: 'http://127.0.0.1:4199',
  });
  // The spy: wraps (never replaces) the real `writeText` so both the
  // mockup's `copyCmd()` contract (a real clipboard write happens) and
  // this test's assertion (the exact string written) hold at once.
  await page.addInitScript(() => {
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    (window as unknown as { __copyCalls: string[] }).__copyCalls = [];
    navigator.clipboard.writeText = (text: string) => {
      (window as unknown as { __copyCalls: string[] }).__copyCalls.push(text);
      return original(text);
    };
  });

  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-setup-health"]');
  const copyButton = card.getByRole('button', { name: 'Copy: jobbunny serve start' });
  await expect(copyButton).toBeVisible();
  await copyButton.click();

  const calls = await page.evaluate(
    () => (window as unknown as { __copyCalls: string[] }).__copyCalls,
  );
  expect(calls).toEqual(['jobbunny serve start']);
});

test('operate-health: a warn finding with a settings-link destination renders inside health-group-needs-action and navigates on click', async ({
  page,
}) => {
  await stubDoctor(page, 'warn', [
    {
      check: 'notion-db-reachable',
      status: 'warn',
      detail: "the Notion database isn't reachable",
    },
  ]);
  await page.goto('/#/setup');
  const card = page.locator('[data-qa="card-setup-health"]');

  // Group MEMBERSHIP, not mere presence on the card: the row must be a
  // descendant of `health-group-needs-action` specifically, not
  // `health-group-not-configured` (both are candidate `warn` homes —
  // `checkDestination.ts`'s `groupHealthFindings` sorts by destination
  // kind, and a `settings-link` destination belongs in needs-action).
  const group = card.locator('[data-qa="health-group-needs-action"]');
  const row = group.locator('[data-qa="health-row-notion-db-reachable"]');
  await expect(row).toBeVisible();
  await expect(
    card.locator(
      '[data-qa="health-group-not-configured"] [data-qa="health-row-notion-db-reachable"]',
    ),
  ).toHaveCount(0);

  await row.getByRole('button', { name: 'Settings' }).click();
  // `navigate()` sets `window.location.hash` to the route it's given
  // (`lib/router.ts`) — the URL is the observable proof `navigate()` fired
  // with `{name:'settings', section:'delivery'}`.
  await expect(page).toHaveURL(/#\/settings\/delivery/);
});

// B6 (QA settings-overhaul, round 2): the missing-secret row's destination
// used to point at `{name:'setup'}` with a bare `navigate()` — a no-op on
// the page it's already rendered on. Real Operate page, both cards
// mounted for real (not the component test's synthetic stand-in DOM) —
// proves the actual `card-secrets` scrolls into view and its first row's
// action button receives focus.
test('operate-health: a missing-secret finding is labelled Secrets and scrolls+focuses card-secrets', async ({
  page,
}) => {
  await stubDoctor(page, 'warn', [
    {
      check: 'env-tokens',
      status: 'warn',
      detail: 'NOTION_TOKEN is not set; TELEGRAM_BOT_TOKEN is not set',
    },
  ]);
  await page.goto('/#/setup');
  const healthCard = page.locator('[data-qa="card-setup-health"]');
  const group = healthCard.locator('[data-qa="health-group-needs-action"]');
  const row = group.locator('[data-qa="health-row-env-tokens"]');
  await expect(row).toBeVisible();

  const secretsCard = page.locator('[data-qa="card-secrets"]');
  const firstSecretButton = secretsCard.getByRole('button', { name: 'Set' }).first();

  await row.getByRole('button', { name: 'Secrets' }).click();
  await expect(page).toHaveURL(/#\/setup/);
  await expect(firstSecretButton).toBeInViewport();
  await expect(firstSecretButton).toBeFocused();
});

test('operate-health: Set up a new profile navigates to the onboarding wizard', async ({
  page,
}) => {
  // Carried over from the deleted `hub.spec.ts` ("hub: Set up a new
  // profile navigates to the onboarding wizard") unchanged in substance —
  // new host file and page context only, per the e2e Disposition Ledger's
  // SURVIVE disposition for this test.
  await page.goto('/#/setup');
  await page.getByRole('button', { name: 'Set up a new profile' }).click();
  await expect(page).toHaveURL(/#\/onboarding/);
  await expect(page.getByTestId('wizard')).toBeVisible();
});

// --- Secrets (blueprint step 36's e2e half) -----------------------------

test('operate-secrets: the [Set] dialog writes a value, flips the row to configured, and the typed value never renders anywhere in the DOM', async ({
  page,
}) => {
  // Security-flagged (this brief's own note): `PUT /api/secrets/:key`
  // upserts into the data home's real `.env`, which `playwright.config.ts`
  // pins to the repo root — the SAME file a developer's real
  // `NOTION_TOKEN`/`TELEGRAM_BOT_TOKEN` live in. `env-guard.ts`'s
  // snapshot/restore (the same guard `env-guard.spec.ts`'s own live PUT
  // test uses) backs up the raw bytes and restores them in `finally`,
  // whether this test passes or throws — never reads or asserts against
  // any *real* secret value. `TELEGRAM_BOT_TOKEN`, not `NOTION_TOKEN`, to
  // avoid racing `env-guard.spec.ts`'s own NOTION_TOKEN write under
  // Playwright's cross-file worker parallelism. The typed value itself is
  // an obviously-fake placeholder, never a real token.
  const root = repoRoot();
  const before = snapshotEnvFile(root);
  const fakeValue = 'test-fake-token-not-real';
  try {
    await page.goto('/#/setup');
    const row = page.locator('[data-qa="secret-row-telegram-bot-token"]');
    await expect(row.getByText('not configured')).toBeVisible();

    await row.getByRole('button', { name: 'Set' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Value').fill(fakeValue);
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(row.getByText('configured', { exact: true })).toBeVisible();

    // R24's "no secret value is ever returned/shown" as a positive,
    // mechanical assertion — a full-page content scan, not just the row.
    const content = await page.content();
    expect(content).not.toContain(fakeValue);
  } finally {
    restoreEnvFile(root, before);
  }
});
