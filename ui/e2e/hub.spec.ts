/**
 * e2e coverage for the Setup & Health hub (spec §3.2): the six status
 * cards, the nav item, doctor findings grouped under their mapped card,
 * the schedule-versus-daemon banner, and the Set-up/Edit-in-Settings
 * panel affordances. Every non-trivial state is produced by stubbing
 * `GET /api/profiles/rajni/doctor`, `GET /api/daemon`, and (for the
 * banner test only) `GET /api/profiles/rajni/config/profile.json` —
 * never by mutating rajni's real config or seeding a row. This file does
 * NOT re-test the wizard steps the hub's panels host (`Step3About`,
 * `Step4Hunt`) — `wizard.spec.ts` already owns that depth; here a panel
 * is proven mounted and dismissible, nothing more.
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

interface Finding {
  check: string;
  status: 'ok' | 'warn' | 'red';
  detail: string;
}

async function stubDoctor(
  page: Page,
  status: 'ok' | 'warn' | 'red',
  findings: Finding[],
): Promise<void> {
  await page.route('**/api/profiles/rajni/doctor', async (route) => {
    await route.fulfill({ json: { status, findings } });
  });
}

async function stubDaemon(
  page: Page,
  state: 'running' | 'stopped' | 'stale',
  profiles: { profile: string; enabled: boolean; nextRunAt: string | null }[],
): Promise<void> {
  await page.route('**/api/daemon', async (route) => {
    await route.fulfill({
      json: {
        state,
        pid: null,
        startedAt: null,
        lastTickAt: null,
        inFlight: null,
        profiles,
      },
    });
  });
}

const CARD_IDS = [
  'profile',
  'persona-filters',
  'search-urls',
  'integrations',
  'schedule-daemon',
  'pipeline-health',
];

test('hub: #/setup renders six status cards', async ({ page }) => {
  await page.goto('/#/setup');
  await expect(page.getByTestId('hub')).toBeVisible();
  await expect(page.getByTestId('hub-card')).toHaveCount(6);
  for (const id of CARD_IDS) {
    await expect(
      page.locator(`[data-testid="hub-card"][data-card-id="${id}"]`),
    ).toBeVisible();
  }
});

test('hub: the sidebar nav item reads Setup & Health and routes to the hub', async ({
  page,
}) => {
  await page.goto('/#/triage');
  await page.getByRole('button', { name: 'Setup & Health', exact: true }).click();
  await expect(page).toHaveURL(/#\/setup/);
  await expect(page.getByTestId('hub')).toBeVisible();
});

test('hub: a doctor finding renders under its mapped card', async ({ page }) => {
  await stubDoctor(page, 'warn', [
    { check: 'filter-parses', status: 'warn', detail: 'e2e-stubbed finding' },
  ]);
  await page.goto('/#/setup');

  const filtersCard = page.locator(
    '[data-testid="hub-card"][data-card-id="persona-filters"]',
  );
  await expect(filtersCard.getByTestId('hub-finding')).toContainText(
    'e2e-stubbed finding',
  );
});

test('hub: the schedule-vs-daemon banner appears when the daemon is stopped and the schedule is enabled, and is absent when the daemon is running', async ({
  page,
}) => {
  await page.route('**/api/profiles/rajni/config/profile.json*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      json: {
        text: JSON.stringify({
          connector: 'sqlite',
          lanes: ['linkedin'],
          notifiers: [],
          routines: [],
          settings: {},
          schedule: {
            enabled: true,
            times: ['09:00'],
            weekdays: [1, 2, 3, 4, 5],
            graceMinutes: 90,
          },
        }),
      },
    });
  });
  await stubDaemon(page, 'stopped', [
    { profile: 'rajni', enabled: true, nextRunAt: null },
  ]);
  await page.goto('/#/setup');
  await expect(page.getByTestId('hub-banner')).toContainText(
    "Scheduled for 09:00 but the daemon isn't running",
  );
  await expect(page.getByTestId('hub-banner')).toContainText('jobbunny serve start');

  await stubDaemon(page, 'running', [
    { profile: 'rajni', enabled: true, nextRunAt: null },
  ]);
  await page.reload();
  await expect(page.getByTestId('hub-banner')).toHaveCount(0);
});

test("hub: a non-ok card's Set up action opens the matching panel, and an ok card offers Edit in Settings with no dialog", async ({
  page,
}) => {
  await stubDoctor(page, 'warn', [
    { check: 'filter-parses', status: 'warn', detail: 'needs setup' },
  ]);
  await page.goto('/#/setup');

  const filtersCard = page.locator(
    '[data-testid="hub-card"][data-card-id="persona-filters"]',
  );
  await expect(filtersCard).toHaveAttribute('data-status', 'warn');
  await filtersCard.getByRole('button', { name: 'Set up' }).click();

  const panel = page.getByTestId('hub-panel');
  await expect(panel).toHaveAttribute('data-card-id', 'persona-filters');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);

  await stubDoctor(page, 'ok', [
    { check: 'filter-parses', status: 'ok', detail: 'fine' },
  ]);
  await page.reload();
  await expect(filtersCard).toHaveAttribute('data-status', 'ok');
  await expect(filtersCard.getByRole('button', { name: 'Set up' })).toHaveCount(0);
  await filtersCard.getByRole('button', { name: 'Edit in Settings' }).click();
  await expect(page).toHaveURL(/#\/settings/);
  await expect(page.getByTestId('hub-panel')).toHaveCount(0);
});

test('hub: Set up a new profile navigates to the onboarding wizard', async ({ page }) => {
  await page.goto('/#/setup');
  await page.getByRole('button', { name: 'Set up a new profile' }).click();
  await expect(page).toHaveURL(/#\/onboarding/);
  await expect(page.getByTestId('wizard')).toBeVisible();
});
