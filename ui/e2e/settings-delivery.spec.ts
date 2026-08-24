/**
 * e2e coverage for `DeliverySection` (`#/settings/delivery`, task 19, routed
 * by task 22), driven against the REAL board server over `profiles/rajni`'s
 * seeded fixture: the Notion mirror toggle round-trip, and a proof that the
 * connector display exposes no interactive role (genuinely read-only, not a
 * disabled-but-present control).
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

test('settings: delivery section round-trips the Notion mirror toggle through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/delivery');
    await expect(section(page)).toHaveAttribute('data-section', 'delivery');

    const mirrorSwitch = section(page).getByRole('switch', { name: 'Mirror to Notion' });
    await expect(mirrorSwitch).not.toBeChecked();
    await mirrorSwitch.click();
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'profile.json');
    const settings = saved.settings as { notion: { mirror: boolean } };
    expect(settings.notion.mirror).toBe(true);
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings: delivery section connector control has no interactive role', async ({
  page,
}) => {
  await page.goto('/#/settings/delivery');
  await expect(section(page)).toHaveAttribute('data-section', 'delivery');

  // Same scoping precedent as `DeliverySection.test.tsx`'s own colocated
  // unit test: scope to the connector field's own testid, then prove zero
  // combobox AND zero button roles inside it — the proof this is genuinely
  // display-only, not a disabled-but-present control.
  const field = section(page).getByTestId('delivery-connector-field');
  await expect(field.getByRole('combobox')).toHaveCount(0);
  await expect(field.getByRole('button')).toHaveCount(0);
});
