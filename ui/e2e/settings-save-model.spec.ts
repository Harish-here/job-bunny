/**
 * e2e coverage for the shared S8 save model — `save-bar`, `save-success-line`,
 * `discard-button` and `dirty-nav-dialog` (blueprint.md's e2e Disposition
 * Ledger; ux-notes §11) — driven against the REAL board server over
 * `profiles/rajni`'s seeded fixture. B10 fix (QA settings-overhaul): none of
 * these four states had e2e coverage before this file.
 *
 * Every test edits the SAME single `profile.json` field —
 * `settings.cleanup.checkpointsOlderThanDays` (Housekeeping's "Checkpoints
 * older than (days)") — to limit shared-fixture contention, following
 * `settings-where-you-work.spec.ts`'s fetch-mutate-put-restore idiom:
 * capture the doc's original text BEFORE mutating, restore it in a
 * `finally`. This field is deliberately NOT the one
 * `settings-housekeeping.spec.ts` already round-trips
 * (`runsOlderThanDays`) — sharing that field with an existing spec raced
 * the two files' concurrent full-document PUTs and was observed to fail
 * reliably (not the suite's usual one-off flake). Every round-trip (or
 * non-round-trip) asserts server-side state via `page.request`, never the
 * form alone.
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

async function fetchCheckpointsOlderThanDays(page: Page): Promise<number> {
  const text = await fetchConfigText(page, 'profile.json');
  const doc = JSON.parse(text) as {
    settings?: { cleanup?: { checkpointsOlderThanDays?: number } };
  };
  return doc.settings?.cleanup?.checkpointsOlderThanDays ?? 2;
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

function checkpointsOlderThanField(page: Page) {
  return section(page).getByLabel('Checkpoints older than (days)');
}

test('settings save model: editing a field shows save-bar, Save shows save-success-line, and the value round-trips through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/housekeeping');
    await expect(section(page)).toHaveAttribute('data-section', 'housekeeping');

    await expect(page.getByTestId('save-bar')).toHaveCount(0);
    await checkpointsOlderThanField(page).fill('7');
    await expect(page.getByTestId('save-bar')).toBeVisible();

    await page.getByTestId('save-bar').getByTestId('save-button').click();
    await expect(page.getByTestId('save-success-line')).toBeVisible();
    await expect(page.getByTestId('save-bar')).toHaveCount(0);

    expect(await fetchCheckpointsOlderThanDays(page)).toBe(7);
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings save model: discard-button reverts the field and hides save-bar, without writing to the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/housekeeping');
    await expect(section(page)).toHaveAttribute('data-section', 'housekeeping');

    const originalValue = await checkpointsOlderThanField(page).inputValue();
    await checkpointsOlderThanField(page).fill('9');
    await expect(page.getByTestId('save-bar')).toBeVisible();

    await page.getByTestId('discard-button').click();
    await expect(page.getByTestId('save-bar')).toHaveCount(0);
    await expect(checkpointsOlderThanField(page)).toHaveValue(originalValue);

    const checkpointsOlderThanDays = await fetchCheckpointsOlderThanDays(page);
    expect(String(checkpointsOlderThanDays)).toBe(originalValue);
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings save model: dirty-nav-dialog "Save and continue" navigates and persists the value', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/housekeeping');
    await expect(section(page)).toHaveAttribute('data-section', 'housekeeping');

    await checkpointsOlderThanField(page).fill('11');
    await expect(page.getByTestId('save-bar')).toBeVisible();

    await page
      .locator('[data-qa="settings-nav"]')
      .getByRole('button', { name: 'Delivery' })
      .click();
    const dialog = page.getByTestId('dirty-nav-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Save and continue' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(section(page)).toHaveAttribute('data-section', 'delivery');

    expect(await fetchCheckpointsOlderThanDays(page)).toBe(11);
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings save model: dirty-nav-dialog "Discard changes" navigates and does NOT persist the value', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  const originalCheckpointsOlderThanDays = await fetchCheckpointsOlderThanDays(page);
  try {
    await page.goto('/#/settings/housekeeping');
    await expect(section(page)).toHaveAttribute('data-section', 'housekeeping');

    await checkpointsOlderThanField(page).fill('13');
    await expect(page.getByTestId('save-bar')).toBeVisible();

    await page
      .locator('[data-qa="settings-nav"]')
      .getByRole('button', { name: 'Delivery' })
      .click();
    const dialog = page.getByTestId('dirty-nav-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Discard changes' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(section(page)).toHaveAttribute('data-section', 'delivery');

    expect(await fetchCheckpointsOlderThanDays(page)).toBe(
      originalCheckpointsOlderThanDays,
    );
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});
