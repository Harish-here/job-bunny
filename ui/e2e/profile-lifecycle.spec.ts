/**
 * e2e coverage for Settings' Profile list (spec §7) plus §7's Acceptance
 * verification items 1 and 2: creating a profile through the REAL wizard
 * UI lands both visually and server-side, and the Danger zone's three
 * guard paths (wrong name, the protected `rajni` fixture, a real
 * throwaway profile) behave exactly as the server's own guard order
 * (membership → protected → running run → pending intent).
 *
 * Acceptance verification item 3 — a live production run of the `harish`
 * profile triggered from the UI — is OWNER-DIRECTED and OUT OF SCOPE
 * here: it is a manual step the profile owner performs, never automated
 * by this or any other suite, and no test in this repo may touch the
 * `harish` profile.
 */
import { expect, type Page, test } from '@playwright/test';
import { removeProfileDir, uniqueProfileName } from './wizard.helpers';

// A parameterized pin, not `wizard.helpers.ts`'s `pinProfile` (which always
// pins the literal `rajni`) — this file also needs to pin the throwaway
// profile it creates itself, a capability that module doesn't provide.
async function pinProfile(page: Page, name: string): Promise<void> {
  await page.addInitScript((profile) => {
    localStorage.setItem('jobbunny.profile', profile);
  }, name);
}

function wizardStep(page: Page, step: number) {
  return page.locator(`[data-testid="wizard-step"][data-step="${step}"]`);
}

async function clickNext(page: Page): Promise<void> {
  await page.getByTestId('wizard-next').click();
}

/** Drives the real wizard end to end: frontend persona, no search URL,
 * skip Extras (never touches `.env`), `manual` schedule (never queues a
 * run intent). Mirrors `wizard.spec.ts`'s own step helpers in SHAPE, not
 * imported from there — those are private to that file, and this suite
 * needs one fixed happy path, not eight variations, which doesn't
 * justify a shared driver module. */
async function createProfileThroughWizard(
  page: Page,
  name: string,
  yoe: string,
): Promise<void> {
  await page.goto('/#/onboarding');
  await page.getByLabel('Profile name').fill(name);
  await clickNext(page);
  await expect(wizardStep(page, 2)).toBeVisible();

  await page
    .locator('[data-testid="wizard-persona"][data-persona-id="frontend"]')
    .click();
  await clickNext(page);
  await expect(wizardStep(page, 3)).toBeVisible();

  await page.getByLabel('Years of experience').fill(yoe);
  await page.getByLabel('Home city').fill('Pune');
  await page.getByLabel('Country').fill('India');
  await page.getByRole('checkbox', { name: 'Remote' }).check();
  await clickNext(page);
  await expect(wizardStep(page, 4)).toBeVisible();

  await clickNext(page); // step 4 left empty on purpose
  await expect(wizardStep(page, 5)).toBeVisible();
  await page.getByTestId('wizard-skip').click();
  await expect(wizardStep(page, 6)).toBeVisible();

  await page.locator('[data-testid="wizard-preset"][data-preset="manual"]').click();
  await clickNext(page);
  await expect(page).toHaveURL(/#\/runs/);
}

async function fetchConfigJson(
  page: Page,
  profile: string,
  doc: string,
): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/profiles/${profile}/config/${doc}`);
  expect(res.ok()).toBe(true);
  const { text } = (await res.json()) as { text: string };
  return JSON.parse(text) as Record<string, unknown>;
}

async function listProfileNames(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/profiles');
  const body = (await res.json()) as { profiles: { name: string }[] };
  return body.profiles.map((p) => p.name);
}

let createdName: string | undefined;

test.afterAll(() => {
  if (createdName) removeProfileDir(createdName);
});

test('profile lifecycle: creating a profile through the wizard makes it appear in the profile switcher and its data lands in Settings and on the server', async ({
  page,
}) => {
  const name = uniqueProfileName();
  createdName = name;
  await pinProfile(page, 'rajni');

  await createProfileThroughWizard(page, name, '8');

  // The wizard selects the new profile on finish — confirm the switcher
  // reflects it directly, not by re-navigating (Acceptance item 1).
  await page.getByLabel('Profile').click();
  await expect(page.getByRole('option', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Server-side (Acceptance item 2, half 1).
  const resumeCfg = await fetchConfigJson(page, name, 'resume.json');
  expect(resumeCfg.current_yoe).toBe(8);
  const filterCfg = await fetchConfigJson(page, name, 'filter.json');
  expect(filterCfg.locations).toEqual([
    { city: 'Pune', country: 'India', workTypes: ['remote'] },
  ]);
  const profileCfg = await fetchConfigJson(page, name, 'profile.json');
  expect(profileCfg.lanes).toEqual(['greenhouse', 'keka']);

  // Visually, through Settings (Acceptance item 2, half 2).
  await page.goto('/#/settings/resume');
  await expect(
    page.getByTestId('settings-section').getByLabel('Current years of experience'),
  ).toHaveValue('8');
});

test('profile lifecycle: a wrong name in the danger dialog leaves the confirm button disabled and deletes nothing', async ({
  page,
}) => {
  await pinProfile(page, 'rajni');
  await page.goto('/#/settings/danger');
  await page.getByTestId('danger-open').click();
  await page.getByTestId('danger-confirm-input').fill('not-rajni');
  await expect(page.getByTestId('danger-confirm')).toBeDisabled();

  expect(await listProfileNames(page)).toContain('rajni');
});

test('profile lifecycle: the server refuses to delete the protected rajni fixture', async ({
  page,
}) => {
  await pinProfile(page, 'rajni');
  await page.goto('/#/settings/danger');
  await page.getByTestId('danger-open').click();
  await page.getByTestId('danger-confirm-input').fill('rajni');
  await expect(page.getByTestId('danger-confirm')).toBeEnabled();
  await page.getByTestId('danger-confirm').click();

  await expect(page.getByTestId('settings-error')).toContainText(
    'is a protected fixture profile',
  );
  expect(await listProfileNames(page)).toContain('rajni');
});

test('profile lifecycle: the throwaway profile removes successfully and disappears from the switcher', async ({
  page,
}) => {
  expect(createdName, 'test 1 must run first and create a profile').toBeTruthy();
  const name = createdName as string;
  await pinProfile(page, name);
  await page.goto('/#/settings/danger');
  await page.getByTestId('danger-open').click();
  await page.getByTestId('danger-confirm-input').fill(name);
  await expect(page.getByTestId('danger-confirm')).toBeEnabled();
  await page.getByTestId('danger-confirm').click();

  await expect
    .poll(async () => (await listProfileNames(page)).includes(name), { timeout: 10_000 })
    .toBe(false);
});
