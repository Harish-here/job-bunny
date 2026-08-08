/**
 * Onboarding-wizard e2e suite (phase 3 task 9) — the six-step wizard
 * (tasks 4–8) covered separately from `smoke.spec.ts`'s critical-path
 * board suite, for the same reason `shell.spec.ts` was split out in the
 * prior package: a wizard regression should fail with an unambiguous
 * file name, not inside an unrelated board spec. Every test pins the
 * profile via `localStorage` before navigating and creates its own
 * throwaway `wiz-*` profile through the real wizard UI and the real
 * board server — see `wizard.helpers.ts` for why that is safe here
 * (short version: `ui/playwright.config.ts` pins `JOBBUNNY_HOME` to the
 * repo root; Step 0 of this task's brief verifies that before any of
 * this file was written).
 */
import { expect, type Page, test } from '@playwright/test';
import { pinProfile, removeProfileDir, uniqueProfileName } from './wizard.helpers';

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

const createdProfiles: string[] = [];

test.afterAll(() => {
  for (const name of createdProfiles) {
    removeProfileDir(name);
  }
});

function wizardStep(page: Page, step: number) {
  return page.locator(`[data-testid="wizard-step"][data-step="${step}"]`);
}

async function clickNext(page: Page): Promise<void> {
  await page.getByTestId('wizard-next').click();
}

async function clickBack(page: Page): Promise<void> {
  await page.getByTestId('wizard-back').click();
}

/** Step 1 (Name it): navigates to the wizard, fills the profile name,
 * advances, and confirms step 2 is showing. */
async function createProfileStep(page: Page, name: string): Promise<void> {
  await page.goto('/#/onboarding');
  await page.getByLabel('Profile name').fill(name);
  await clickNext(page);
  await expect(wizardStep(page, 2)).toBeVisible();
}

/** Step 2 (Pick a persona): clicks the persona card by id, advances,
 * confirms step 3. */
async function pickPersonaStep(page: Page, personaId: string): Promise<void> {
  await page
    .locator(`[data-testid="wizard-persona"][data-persona-id="${personaId}"]`)
    .click();
  await clickNext(page);
  await expect(wizardStep(page, 3)).toBeVisible();
}

interface AboutFill {
  yoe?: string;
  homeCity: string;
  country?: string;
  workType: 'Onsite' | 'Hybrid' | 'Remote';
}

/** Step 3 (About you) field entry only — does NOT advance, so callers
 * can inspect `wizard-derived-json` before saving (test 8). */
async function fillAboutStep(page: Page, answers: AboutFill): Promise<void> {
  if (answers.yoe != null) {
    await page.getByLabel('Years of experience').fill(answers.yoe);
  }
  await page.getByLabel('Home city').fill(answers.homeCity);
  if (answers.country != null) {
    await page.getByLabel('Country').fill(answers.country);
  }
  await page.getByRole('checkbox', { name: answers.workType }).check();
}

async function submitAboutStep(page: Page): Promise<void> {
  await clickNext(page);
  await expect(wizardStep(page, 4)).toBeVisible();
}

interface ExtrasFill {
  notionDbId?: string;
  notionToken?: string;
  telegramToken?: string;
  telegramChatId?: string;
}

async function fillExtrasStep(page: Page, answers: ExtrasFill): Promise<void> {
  if (answers.notionDbId != null) {
    await page.getByLabel('Notion database ID').fill(answers.notionDbId);
  }
  if (answers.notionToken != null) {
    await page.getByLabel('Notion token').fill(answers.notionToken);
  }
  if (answers.telegramToken != null) {
    await page.getByLabel('Telegram bot token').fill(answers.telegramToken);
  }
  if (answers.telegramChatId != null) {
    await page.getByLabel('Telegram chat ID').fill(answers.telegramChatId);
  }
}

async function submitExtrasStep(page: Page): Promise<void> {
  await clickNext(page);
  await expect(wizardStep(page, 6)).toBeVisible();
}

async function pickPreset(page: Page, preset: string): Promise<void> {
  await page.locator(`[data-testid="wizard-preset"][data-preset="${preset}"]`).click();
}

async function finishWizard(page: Page): Promise<void> {
  await clickNext(page);
}

async function fetchConfigText(
  page: Page,
  profile: string,
  doc: string,
): Promise<string> {
  const res = await page.request.get(
    `/api/profiles/${encodeURIComponent(profile)}/config/${doc}`,
  );
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { text: string };
  return body.text;
}

async function fetchConfigJson(
  page: Page,
  profile: string,
  doc: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await fetchConfigText(page, profile, doc)) as Record<string, unknown>;
}

test('wizard: happy path with a frontend persona creates a runnable profile', async ({
  page,
}) => {
  const name = uniqueProfileName();
  createdProfiles.push(name);

  await createProfileStep(page, name);
  await pickPersonaStep(page, 'frontend');
  await fillAboutStep(page, {
    yoe: '5',
    homeCity: 'Bengaluru',
    country: 'India',
    workType: 'Remote',
  });
  await submitAboutStep(page);

  await page
    .getByLabel('Search URL', { exact: true })
    .fill('https://www.linkedin.com/jobs/search/?keywords=frontend');
  await page.getByLabel('Label').fill('Frontend roles');
  await expect(page.getByTestId('wizard-url-row')).toHaveCount(1);
  await clickNext(page);
  await expect(wizardStep(page, 5)).toBeVisible();

  await fillExtrasStep(page, {
    notionDbId: '12345678123412341234123456789012',
    notionToken: 'secret_abc123',
    telegramToken: `123456789:${'A'.repeat(35)}`,
    telegramChatId: '-100123456',
  });
  await submitExtrasStep(page);

  const daemonState = page.getByTestId('wizard-daemon-state');
  await expect(daemonState).toBeVisible();
  const state = await daemonState.getAttribute('data-state');
  // Structural, never value-specific: CI never runs `jobbunny serve
  // start`, so a fixed expected value would be flaky by construction —
  // see this brief's Rationale.
  expect(['running', 'stopped', 'stale']).toContain(state);

  await pickPreset(page, 'morning-afternoon');
  await finishWizard(page);
  await expect(page).toHaveURL(/#\/runs/);

  const profileCfg = await fetchConfigJson(page, name, 'profile.json');
  expect(profileCfg.lanes).toEqual(
    expect.arrayContaining(['linkedin', 'greenhouse', 'keka']),
  );
  // toMatchObject, not a strict toEqual: the server's own schedule
  // schema may fill in a `graceMinutes` default the wizard never wrote
  // (design ledger: "graceMinutes is NOT exposed ... Settings owns it
  // later") — this only pins the fields the wizard actually controls.
  expect(profileCfg.schedule).toMatchObject({
    times: ['09:00', '14:00'],
    enabled: true,
    weekdays: [1, 2, 3, 4, 5],
  });
});

test('wizard: happy path with a sales persona', async ({ page }) => {
  const name = uniqueProfileName();
  createdProfiles.push(name);

  await createProfileStep(page, name);
  await pickPersonaStep(page, 'sales');
  await fillAboutStep(page, { homeCity: 'Mumbai', workType: 'Hybrid' });
  await submitAboutStep(page);

  // Step 4 left empty on purpose — exercises the frozen "no URL added"
  // branch of the lanes rule: `['greenhouse', 'keka']`, no linkedin.
  await clickNext(page);
  await expect(wizardStep(page, 5)).toBeVisible();

  await page.getByTestId('wizard-skip').click();
  await expect(wizardStep(page, 6)).toBeVisible();

  await pickPreset(page, 'manual');
  await finishWizard(page);
  await expect(page).toHaveURL(/#\/runs/);

  const profileCfg = await fetchConfigJson(page, name, 'profile.json');
  expect(profileCfg.lanes).toEqual(['greenhouse', 'keka']);
  expect(profileCfg.schedule).toMatchObject({ times: [], enabled: false });
});

test('wizard: start from scratch collects answers without a persona', async ({
  page,
}) => {
  const name = uniqueProfileName();
  createdProfiles.push(name);

  await createProfileStep(page, name);
  await pickPersonaStep(page, 'scratch');
  await fillAboutStep(page, {
    homeCity: 'Kochi',
    country: 'India',
    workType: 'Onsite',
  });
  await submitAboutStep(page);

  await clickNext(page); // Step 4 left empty
  await expect(wizardStep(page, 5)).toBeVisible();
  await page.getByTestId('wizard-skip').click();
  await expect(wizardStep(page, 6)).toBeVisible();
  await pickPreset(page, 'manual');
  await finishWizard(page);
  await expect(page).toHaveURL(/#\/runs/);

  const filterCfg = await fetchConfigJson(page, name, 'filter.json');
  // `scratch` pre-fills nothing and no seniority was picked, so
  // `deriveFilter`'s title block is entirely omitted — only
  // `locations` (from the home city + work type) survives.
  expect(filterCfg.title).toBeUndefined();
  expect(filterCfg.locations).toEqual([
    { city: 'Kochi', country: 'India', workTypes: ['onsite'] },
  ]);
});

test('wizard: back navigation keeps every answer', async ({ page }) => {
  const name = uniqueProfileName();
  createdProfiles.push(name);

  await createProfileStep(page, name);
  // Back to step 1 and check the created name is still there — Back is
  // pure navigation, it never re-runs or reverts a write.
  await clickBack(page);
  await expect(wizardStep(page, 1)).toBeVisible();
  await expect(page.getByLabel('Profile name')).toHaveValue(name);
  await clickNext(page);
  await expect(wizardStep(page, 2)).toBeVisible();

  await pickPersonaStep(page, 'frontend');
  await fillAboutStep(page, {
    yoe: '7',
    homeCity: 'Pune',
    country: 'India',
    workType: 'Hybrid',
  });

  // Back to step 2, then forward again — proves the About answers
  // survive a round trip through an earlier step, not just a reload
  // (test 5 covers the reload case separately).
  await clickBack(page);
  await expect(wizardStep(page, 2)).toBeVisible();
  await clickNext(page);
  await expect(wizardStep(page, 3)).toBeVisible();

  await expect(page.getByLabel('Years of experience')).toHaveValue('7');
  await expect(page.getByLabel('Home city')).toHaveValue('Pune');
  await expect(page.getByLabel('Country')).toHaveValue('India');
  await expect(page.getByRole('checkbox', { name: 'Hybrid' })).toBeChecked();
});

test('wizard: closing mid-wizard resumes at the same step', async ({ page }) => {
  const name = uniqueProfileName();
  createdProfiles.push(name);

  await createProfileStep(page, name);
  await pickPersonaStep(page, 'backend');
  // Step 3 is now showing. Type an answer but do NOT click Next — this
  // proves the draft is written continuously as the user types (design
  // ledger: "every answer stays in component state and in the draft"),
  // not only on step transitions.
  await page.getByLabel('Home city').fill('Mumbai');

  // The reload is the load-bearing assertion of this whole test (see
  // this brief's Rationale) — `pinProfile`'s init script re-fires on
  // this reload too, but it touches ONLY `jobbunny.profile`, never a
  // `jobbunny.wizard.*` key, so the draft it is about to check survives.
  await page.reload();

  await expect(wizardStep(page, 3)).toBeVisible();
  await expect(page.getByLabel('Home city')).toHaveValue('Mumbai');
});

test('wizard: extras can be skipped in one click', async ({ page }) => {
  const name = uniqueProfileName();
  createdProfiles.push(name);

  await createProfileStep(page, name);
  await pickPersonaStep(page, 'devops');
  await fillAboutStep(page, { homeCity: 'Hyderabad', workType: 'Remote' });
  await submitAboutStep(page);

  await clickNext(page); // Step 4 left empty
  await expect(wizardStep(page, 5)).toBeVisible();

  await page.getByTestId('wizard-skip').click();
  await expect(wizardStep(page, 6)).toBeVisible();

  await pickPreset(page, 'manual');
  await finishWizard(page);
  await expect(page).toHaveURL(/#\/runs/);

  const profileCfg = await fetchConfigJson(page, name, 'profile.json');
  expect(profileCfg.notifiers).not.toContain('telegram');
  const settings = profileCfg.settings as Record<string, unknown> | undefined;
  expect(settings?.notion).toBeUndefined();
});

test('wizard: invalid url, time, and token shapes show inline field errors', async ({
  page,
}) => {
  const name = uniqueProfileName();
  createdProfiles.push(name);

  await createProfileStep(page, name);
  await pickPersonaStep(page, 'product');
  await fillAboutStep(page, { homeCity: 'Delhi', workType: 'Onsite' });
  await submitAboutStep(page);

  // Step 4: a well-formed https URL whose host is not linkedin.com —
  // a blocking field error, so the step does not advance.
  await page.getByLabel('Search URL', { exact: true }).fill('https://example.com/jobs');
  await page.getByLabel('Label').fill('Not LinkedIn');
  await clickNext(page);
  await expect(page.getByText('That URL is not a linkedin.com address.')).toBeVisible();
  await expect(wizardStep(page, 4)).toBeVisible();

  // Step 4: a linkedin.com URL whose pathname is not `/jobs/search/` —
  // frozen (progress.md's step 4 URL rule) as a NON-blocking warning:
  // `wizard-url-warning` renders, but the step still advances on Next.
  await page
    .getByLabel('Search URL', { exact: true })
    .fill('https://www.linkedin.com/jobs/collections/recommended/');
  await expect(page.getByTestId('wizard-url-warning')).toBeVisible();
  await clickNext(page);
  await expect(wizardStep(page, 5)).toBeVisible();

  // Step 5: a malformed Telegram bot token.
  await page.getByLabel('Telegram bot token').fill('12345:short');
  await clickNext(page);
  await expect(
    page.getByText('A Telegram bot token looks like 123456789:AA… .'),
  ).toBeVisible();
  await expect(wizardStep(page, 5)).toBeVisible();
  await page.getByTestId('wizard-skip').click();
  await expect(wizardStep(page, 6)).toBeVisible();

  // Step 6: an HH:MM time missing its leading zero, under the custom
  // preset. Step 6's custom-time input is a plain text input — never
  // `type="time"` — labelled exactly 'Run time': frozen by
  // progress.md's "Frozen UI labels and controls the e2e suite depends
  // on" bullet (tasks 5, 6, 8, 9).
  await pickPreset(page, 'custom');
  await page.getByLabel('Run time').fill('9:00');
  await page.getByRole('button', { name: 'Add time' }).click();
  await clickNext(page);
  await expect(page.getByText('Enter a time as HH:MM (24-hour).')).toBeVisible();
  await expect(wizardStep(page, 6)).toBeVisible();
});

test('wizard: the derived rules view matches the saved filter.json', async ({ page }) => {
  const name = uniqueProfileName();
  createdProfiles.push(name);

  await createProfileStep(page, name);
  await pickPersonaStep(page, 'data');
  await fillAboutStep(page, {
    homeCity: 'Chennai',
    country: 'India',
    workType: 'Remote',
  });

  // `wizard-derived-json` sits behind Step3About's own advanced
  // disclosure toggle (`Show derived filter rules`) — it must be opened
  // before the pre-save text can be read.
  await page.getByRole('button', { name: 'Show derived filter rules' }).click();
  const preSaveJson = await page.getByTestId('wizard-derived-json').textContent();
  expect(preSaveJson).toBeTruthy();

  await submitAboutStep(page);

  const filterText = await fetchConfigText(page, name, 'filter.json');
  expect(JSON.parse(filterText)).toEqual(JSON.parse(preSaveJson ?? ''));
});
