/**
 * Blueprint §6 Phase D steps 15–18 (tasks 5–6 of the ui-design-system epic) —
 * created at step 15 with `e2e-triage-verdict-header`, appended to at step
 * 16 with `e2e-jd-expand`, and appended to again at steps 17–18 (task 6)
 * with `e2e-decide-labels`/`e2e-row-lane-and-pip`. All tests run against the
 * real board server over `profiles/rajni`'s seeded fixtures
 * (`seed.ts`/`fixtures.ts`).
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

test('e2e-triage-verdict-header', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await row1.click();
  await expect(row1).toHaveAttribute('aria-selected', 'true');

  const matchScore = page.locator('[data-qa="match-score"]');
  await expect(matchScore).toContainText('/100');

  const laneLabel = page.locator('[data-qa="lane-label"]');
  await expect(laneLabel).toContainText('LinkedIn');
  await expect(laneLabel).not.toHaveText('linkedin');

  const companyLink = page.locator('[data-qa="provenance-line"] a').first();
  await expect(companyLink).toHaveAttribute(
    'href',
    'https://example.com/jobs/rajni-e2e-1',
  );
});

test('e2e-jd-expand', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await row1.click();

  const clamp = page.locator('[data-testid="jd-clamp"]');
  await expect(clamp).toHaveCSS('max-height', '240px');

  const toggle = page.locator('[data-qa="jd-toggle"]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(clamp).not.toHaveCSS('max-height', '240px');

  const row2 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-2"]');
  await row2.click();
  await expect(row2).toHaveAttribute('aria-selected', 'true');

  // Session-sticky: `jdExpanded` lives above `selectedId` in `TriagePage`,
  // so selecting a different job renders it already expanded.
  await expect(page.locator('[data-qa="jd-toggle"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.locator('[data-testid="jd-clamp"]')).not.toHaveCSS(
    'max-height',
    '240px',
  );
});

test('e2e-decide-labels', async ({ page }) => {
  await page.goto('/#/triage');

  const apply = page.locator('[data-qa="decide-apply"]');
  const lead = page.locator('[data-qa="decide-lead"]');
  const pass = page.locator('[data-qa="decide-pass"]');

  // The three buttons read exactly Apply / Lead / Pass — never the old
  // Save/Skip jargon (R11, the collision this rewrite closes).
  await expect(apply).toContainText('Apply');
  await expect(apply).not.toContainText('Save');
  await expect(apply).not.toContainText('Skip');
  await expect(lead).toContainText('Lead');
  await expect(lead).not.toContainText('Save');
  await expect(pass).toContainText('Pass');
  await expect(pass).not.toContainText('Skip');

  // decide-pass is styled `outline`, never `destructive` — a whole action
  // rendered as an error state was the collision this closes. `data-variant`
  // is the deterministic signal; the button's base class list always
  // includes `aria-invalid:*destructive*` utilities regardless of variant,
  // so a bare class-string substring match would false-positive — check for
  // the destructive variant's own distinguishing background class instead.
  await expect(pass).toHaveAttribute('data-variant', 'outline');
  const passClass = (await pass.getAttribute('class')) ?? '';
  expect(passClass).not.toContain('bg-destructive/10');
});

test('e2e-row-lane-and-pip', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await expect(row1).toContainText('LinkedIn');

  const pip = row1.locator('[data-testid="job-row-status"]');
  const ariaLabel = await pip.getAttribute('aria-label');
  expect(ariaLabel).toBeTruthy();
});

// Blueprint step 19 (task 7) — pins S1/`triage-default`: the 7 pane zones
// render in the DOM order `DetailPane.tsx` composes them, inside one
// `detail-pane` Card.
test('e2e-triage-default', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await row1.click();

  const pane = page.locator('[data-qa="detail-pane"]');
  await expect(pane).toBeVisible();

  const zoneIds = [
    'verdict-header',
    'signals',
    'eligibility',
    'skills',
    'jd',
    'tracking',
    'decide-bar',
  ];
  for (const id of zoneIds) {
    await expect(pane.locator(`[data-qa="${id}"]`)).toBeVisible();
  }

  const positions = await pane.evaluate((el, ids: string[]) => {
    const all = Array.from(el.querySelectorAll('[data-qa]'));
    return ids.map((id) => all.findIndex((n) => n.getAttribute('data-qa') === id));
  }, zoneIds);
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i]).toBeGreaterThan(positions[i - 1] as number);
  }
});

// Blueprint step 19 (task 7) — pins S8/`detail-decided`. Orchestrator
// ruling B: decide-and-advance (`useTriageKeyboard.ts`'s documented `a`/`x`/
// `s` behaviour, `TriagePage.tsx`'s `decide()`) calls `select()` in the same
// handler as `mutate()`, so the pane moves off the decided job before any
// paint — there is no tick where the SAME pane shows its own flipped badge.
// This mirrors `smoke.spec.ts`'s "decide persists" model instead: assert the
// decided job's own row pip now carries the Applied glyph/aria-label, and
// that the pane has advanced to a different (the next undecided) job.
test('e2e-triage-decided', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await row1.click();

  const titleBefore = await page.locator('[data-qa="verdict-header"] h1').textContent();

  await page.keyboard.press('a');

  await expect(row1.locator('[data-qa="job-row-pip"]')).toHaveAttribute(
    'aria-label',
    'Applied',
  );
  await expect(page.locator('[data-qa="verdict-header"] h1')).not.toHaveText(
    titleBefore ?? '',
  );
});

// Blueprint step 19 (task 7) — pins S7/`detail-sparse`: `rajni-e2e-11` has
// no content/structured/evaluation, so every zone renders its
// empty-within-populated case. Orchestrator ruling A: `locationCity` is
// derived only from `structured.locations[0].city` (`store.ts`'s
// `jobRowValues()`) — `identity.location` never reaches it, and fixing that
// is an `src/adapters/**` change this UI-only task is forbidden from making
// — so the sparse job is legitimately empty in all four eligibility cells,
// not just three.
test('e2e-triage-sparse', async ({ page }) => {
  await page.goto('/#/triage');

  const row11 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-11"]');
  await row11.click();

  const signals = page.locator('[data-qa="signals"]');
  await expect(signals).toContainText('No match reasons recorded.');
  await expect(signals.locator('[data-qa="review-flags"]')).toHaveCount(0);

  const skills = page.locator('[data-qa="skills"]');
  await expect(skills).toContainText('No skills extracted.');
  await expect(skills.locator('[data-slot="badge"]')).toHaveCount(0);

  const jd = page.locator('[data-qa="jd"]');
  await expect(jd).toContainText('No description captured for this job.');
  await expect(jd.getByRole('link', { name: /Open original/ })).toBeVisible();

  const eligibility = page.locator('[data-qa="eligibility"]');
  await expect(eligibility.getByText('—', { exact: true })).toHaveCount(4);
});

// Blueprint step 20 (task 7) — pins S2/`triage-loading`: the list-pane
// skeleton renders while the jobs-list fetch is in flight, then is replaced
// by real rows once it resolves.
// Blueprint step 21 (task 8) — pins the `JobPage.tsx` zone swap: `JobFacts`
// is replaced by `JobSignals` -> `EligibilityGrid` -> `SkillsList` in the
// right column, in that order (matching the triage pane's zone ordering,
// AC 12). Note: unlike the triage pane's single-column `DetailPane`,
// `JobPage` is a two-column layout (JD prose left; signals/eligibility/
// skills/tracking right) settled by task 5's forced `JdText` call-site fix
// (out of this task's scope) — so `jd` (left column) DOM-precedes the
// right-column zones here, the reverse of `e2e-triage-default`'s
// single-stream ordering. What IS invariant, and what this test pins, is
// the relative order that carried over from the triage pane: `signals` <
// `eligibility` < `skills`, with `verdict-header` first (both columns'
// first element).
test('e2e-job-page-order', async ({ page }) => {
  await page.goto('/#/job/rajni-e2e-1');

  const zoneIds = ['verdict-header', 'jd', 'signals', 'eligibility', 'skills'];
  for (const id of zoneIds) {
    await expect(page.locator(`[data-qa="${id}"]`)).toBeVisible();
  }

  const positions = await page.evaluate((ids: string[]) => {
    const all = Array.from(document.querySelectorAll('[data-qa]'));
    return ids.map((id) => all.findIndex((n) => n.getAttribute('data-qa') === id));
  }, zoneIds);
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i]).toBeGreaterThan(positions[i - 1] as number);
  }
});

test('e2e-triage-loading', async ({ page }) => {
  await page.route('**/api/profiles/rajni/jobs*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await page.goto('/#/triage');

  await expect(page.locator('[data-qa="list-skeleton"]')).toBeVisible();

  await expect(page.locator('[data-testid="job-row"]').first()).toBeVisible();
  await expect(page.locator('[data-qa="list-skeleton"]')).toHaveCount(0);
});
