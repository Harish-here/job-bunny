/**
 * e2e coverage for `HousekeepingSection` (`#/settings/housekeeping`, task
 * 20, routed by task 22): the cleanup-TTL round-trip, driven against the
 * REAL board server over `profiles/rajni`'s seeded fixture.
 */
import { expect, type Page, test } from '@playwright/test';
import { pinProfile } from './run-fixtures';

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

async function fetchConfigText(page: Page, doc: string): Promise<string> {
  const res = await page.request.get(`/api/profiles/rajni/config/${doc}`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { text: string };
  return body.text;
}

async function fetchConfigJson(
  page: Page,
  doc: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await fetchConfigText(page, doc)) as Record<string, unknown>;
}

async function putConfigText(page: Page, doc: string, text: string): Promise<void> {
  const res = await page.request.put(`/api/profiles/rajni/config/${doc}`, {
    data: { text },
  });
  expect(res.ok()).toBe(true);
}

function section(page: Page) {
  return page.getByTestId('settings-section');
}

async function saveSection(page: Page): Promise<void> {
  await section(page).getByRole('button', { name: /save/i }).click();
  await expect(page.getByTestId('settings-error')).toHaveCount(0);
}

test('settings: housekeeping section round-trips runsOlderThanDays through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/housekeeping');
    await expect(section(page)).toHaveAttribute('data-section', 'housekeeping');

    await section(page).getByLabel('Runs older than (days)').fill('45');
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'profile.json');
    const settings = saved.settings as { cleanup: { runsOlderThanDays: number } };
    expect(settings.cleanup.runsOlderThanDays).toBe(45);
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});
