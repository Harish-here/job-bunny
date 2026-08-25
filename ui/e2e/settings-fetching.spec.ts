/**
 * e2e coverage for `FetchingSection` (`#/settings/fetching`, task 18, routed
 * by task 22), driven against the REAL board server over `profiles/rajni`'s
 * seeded fixture: the fetch-caps round-trip (`maxNewPerLane`), the Fast
 * pacing preset's save-time round-trip, and the R13 client-side validation
 * demo case (an inverted jitter range blocks Save, `profile.json` unwritten).
 */
import { expect, type Page, test } from '@playwright/test';
import { rangesFromPreset } from '../src/features/settings/sections/fetching.model.ts';
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

test('settings: fetching section round-trips maxNewPerLane through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/fetching');
    await expect(section(page)).toHaveAttribute('data-section', 'fetching');

    const field = section(page).locator('[data-qa="fetch-cap-max-new-per-lane"]');
    const input = field.getByRole('spinbutton');
    await input.fill('77');
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'profile.json');
    const settings = saved.settings as { source: { maxNewPerLane: number } };
    expect(settings.source.maxNewPerLane).toBe(77);
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings: fetching section round-trips the Fast pacing preset through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/fetching');
    await expect(section(page)).toHaveAttribute('data-section', 'fetching');

    // `[data-qa="pacing-preset-fast"]` is on the `<button role="radio">`
    // itself (`PacingPresetCard.tsx`'s `RadioGroupItem asChild`), so it IS
    // the radio — no nested `getByRole` needed (that would search
    // descendants only and never match the element it's scoped to).
    const fastCard = section(page).locator('[data-qa="pacing-preset-fast"]');
    await fastCard.click();
    await section(page).locator('[data-qa="pacing-fast-ack"] input').check();
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'profile.json');
    const linkedin = (saved.settings as { linkedin: Record<string, number> }).linkedin;
    const fast = rangesFromPreset('fast');
    expect(linkedin.jitterMinMs).toBe(fast.jitterMinMs);
    expect(linkedin.jitterMaxMs).toBe(fast.jitterMaxMs);
    expect(linkedin.interUrlDelayMinMs).toBe(fast.interUrlDelayMinMs);
    expect(linkedin.interUrlDelayMaxMs).toBe(fast.interUrlDelayMaxMs);
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings: fetching section blocks Save on an inverted jitter range (R13) and leaves profile.json unwritten', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  const before = await fetchConfigJson(page, 'profile.json');
  const beforeLinkedin = (
    before.settings as { linkedin?: Record<string, number> } | undefined
  )?.linkedin;
  try {
    await page.goto('/#/settings/fetching');
    await expect(section(page)).toHaveAttribute('data-section', 'fetching');

    await section(page).locator('[data-qa="pacing-advanced-disclosure"]').click();
    const jitterMin = section(page).locator('[data-qa="pacing-raw-jitter-min"]');
    await expect(jitterMin).toBeVisible();
    const jitterMax = section(page).locator('[data-qa="pacing-raw-jitter-max"]');

    await jitterMin.getByRole('spinbutton').fill('15000');
    await jitterMax.getByRole('spinbutton').fill('12000');

    await section(page).getByRole('button', { name: /save/i }).click();

    // B1/B3 (QA settings-overhaul): the summary renders at the top of the
    // content column (not in place of the save bar), and names both
    // fields, their values, and the consequence per ux-notes §11's named
    // case, verbatim.
    const summary = page.locator('[data-qa="validation-summary"]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Minimum jitter (15000 ms)');
    await expect(summary).toContainText('maximum jitter (12000 ms)');
    await expect(summary).toContainText('The run would fail to start.');
    // B12 (QA settings-overhaul, round 2): the max field gets its OWN
    // summary sentence (not the min field's sentence repeated) — this
    // failing pair renders TWO distinct list items, "2 problems to fix".
    await expect(summary).toContainText('2 problems to fix');
    await expect(summary).toContainText('Maximum jitter (12000 ms)');
    await expect(summary).toContainText('is below minimum jitter (15000 ms)');
    // ...and the inline field errors are the SHORT form, not the summary
    // sentence repeated under the field it's already sitting beside.
    await expect(jitterMin.locator('[data-slot="field-error"]')).toHaveText(
      'Above maximum jitter (12000 ms).',
    );
    await expect(jitterMax.locator('[data-slot="field-error"]')).toHaveText(
      'Below minimum jitter (15000 ms).',
    );
    await expect(section(page).locator('[data-qa="save-bar"]')).toBeVisible();
    await expect(
      section(page).getByRole('button', { name: 'Save changes' }),
    ).toBeEnabled();

    const after = await fetchConfigJson(page, 'profile.json');
    const afterLinkedin = (
      after.settings as { linkedin?: Record<string, number> } | undefined
    )?.linkedin;
    expect(afterLinkedin).toEqual(beforeLinkedin);
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});
