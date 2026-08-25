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

// Fix-round finding: DecideBar must stay sticky-bottom (D8/Fitts) even once
// the JD is expanded and the detail pane scrolls. Action-based checks (a
// bare visibility assert) don't catch a clipped/non-sticky element — the
// repo's own Playwright auto-scroll lesson — so this drives a real wheel
// gesture over the scroll container and asserts viewport membership after.
test('e2e-decide-bar-sticky', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await row1.click();

  const toggle = page.locator('[data-qa="jd-toggle"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  const decideBar = page.locator('[data-qa="decide-bar"]');
  await page.locator('[data-qa="detail-pane"]').hover();
  await page.mouse.wheel(0, 2000);

  await expect(decideBar).toBeInViewport();
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

// QA round 1 bug 1 (major) — `rajni-e2e-6` (`fixtures.ts`) carries 2
// soft-fail verdicts, projected by `reviewFlags()` into REVIEW FLAGS.
// Pins R19/AC 7: reasons and flags are visually distinct kinds of thing —
// reasons wrap horizontally as rounded chips, flags stack vertically behind
// a left rule, and each carries its own icon.
test('e2e-signals-flags', async ({ page }) => {
  await page.goto('/#/triage');

  const row6 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-6"]');
  await row6.click();
  await expect(row6).toHaveAttribute('aria-selected', 'true');

  const signals = page.locator('[data-qa="signals"]');
  const reasons = signals.locator('[data-qa="match-reasons"]');
  const flags = signals.locator('[data-qa="review-flags"]');
  await expect(reasons).toBeVisible();
  await expect(flags).toBeVisible();

  await expect(signals).toContainText('WHY IT MATCHES · 2');
  await expect(signals).toContainText('REVIEW FLAGS · 2');

  // Distinct containers: reasons wrap horizontally, flags stack vertically
  // behind a coloured left rule — never the same shape.
  await expect(reasons).toHaveClass(/flex-wrap/);
  await expect(flags).toHaveClass(/flex-col/);
  await expect(flags).toHaveClass(/border-l-2/);

  // Each zone carries its own icon per entry (Check vs AlertTriangle).
  await expect(reasons.locator('svg')).toHaveCount(2);
  await expect(flags.locator('svg')).toHaveCount(2);
});

// QA round 1 bug 2 (S6 `detail-archived`) — `rajni-e2e-12` (`fixtures.ts` +
// `seed.ts`'s `markArchived`) is hidden by every default query; reachable
// only via the FilterPopover's "Show archived" toggle. Also pins bug 7: the
// strip precedes verdict-header in document order.
test('e2e-archived-strip', async ({ page }) => {
  await page.goto('/#/triage');

  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByLabel('Show archived').check();
  await page.keyboard.press('Escape');

  const row12 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-12"]');
  await expect(row12).toBeVisible();
  await row12.click();
  await expect(row12).toHaveAttribute('aria-selected', 'true');

  const strip = page.locator('[data-qa="archived-strip"]');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Archived — this job is out of the queue.');

  const pane = page.locator('[data-qa="detail-pane"]');
  const [stripIndex, headerIndex] = await pane.evaluate((el) => {
    const all = Array.from(el.querySelectorAll('[data-qa]'));
    return [
      all.findIndex((n) => n.getAttribute('data-qa') === 'archived-strip'),
      all.findIndex((n) => n.getAttribute('data-qa') === 'verdict-header'),
    ];
  });
  expect(stripIndex).toBeGreaterThanOrEqual(0);
  expect(stripIndex).toBeLessThan(headerIndex);
});

// QA round 1 bug 2 (`skills-more`) — `rajni-e2e-6` carries 10 skills, above
// the 8-visible cap.
test('e2e-skills-more', async ({ page }) => {
  await page.goto('/#/triage');

  const row6 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-6"]');
  await row6.click();

  const skills = page.locator('[data-qa="skills"]');
  await expect(skills).toContainText('SKILLS ASKED FOR · 10');

  const badges = skills.locator('[data-slot="badge"]');
  await expect(badges).toHaveCount(8);

  const more = page.locator('[data-qa="skills-more"]');
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toContainText('+2 more');

  await more.click();

  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(badges).toHaveCount(10);
});

// QA round 1 bug 2 (`tracking-excitement`) — `rajni-e2e-6` carries an
// excitement level; the badge is read-only (accepted deviation, no
// segmented control, no write path).
test('e2e-tracking-excitement', async ({ page }) => {
  await page.goto('/#/triage');

  const row6 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-6"]');
  await row6.click();

  const excitement = page.locator('[data-qa="tracking-excitement"]');
  await expect(excitement).toBeVisible();
  await expect(excitement).toContainText('Excitement');
  await expect(excitement).toContainText('Vera level');
  await expect(excitement.locator('select, input, button')).toHaveCount(0);
});

// QA round 1 bug 3 (S3 `triage-empty`) — the filtered-empty copy, reached
// by driving the company search to a term matching nothing.
test('e2e-list-empty', async ({ page }) => {
  await page.goto('/#/triage');

  const search = page.getByLabel('Search company');
  await search.fill('zzz-no-such-company-zzz');

  const empty = page.locator('[data-qa="list-empty"]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No jobs match these filters.');

  await page.locator('[data-qa="clear-filters"]').click();
  await expect(page.locator('[data-testid="job-row"]').first()).toBeVisible();
});

// The true-empty variant (no filter active, the board itself has zero
// jobs) — cheap via a route stub, so pinned alongside the filtered case.
test('e2e-list-empty-true', async ({ page }) => {
  await page.route('**/api/profiles/rajni/jobs*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/jobs')) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rows: [], total: 0 }),
    });
  });

  await page.goto('/#/triage');

  const empty = page.locator('[data-qa="list-empty"]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('Nothing left to decide.');
  await expect(page.getByText('View the tracker →')).toBeVisible();
});

// QA round 1 bug 3 (S4 `triage-error`) — the jobs-list fetch failing
// renders `list-error` with a working "Try again" that recovers once the
// underlying request succeeds again.
test('e2e-list-error', async ({ page }) => {
  await page.route('**/api/profiles/rajni/jobs*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/jobs')) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'server_error', message: 'boom' } }),
    });
  });

  await page.goto('/#/triage');

  const error = page.locator('[data-qa="list-error"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText("Couldn't load jobs");

  const retry = error.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();

  await page.unroute('**/api/profiles/rajni/jobs*');
  await retry.click();

  await expect(page.locator('[data-testid="job-row"]').first()).toBeVisible();
  await expect(error).toHaveCount(0);
});

// QA round 1 bug 3 (S9, dark twin of S1) — `page.emulateMedia` before
// navigation so `main.tsx`'s `matchMedia('(prefers-color-scheme: dark)')`
// already reports dark on first paint; asserts both the `html.dark` class
// and that the pane's rendered background is the dark `--card` token
// (`#241d30` -> `rgb(36, 29, 48)`, pinned byte-exact in `tokens.test.ts`).
test('e2e-dark-mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#/triage');

  await expect(page.locator('html')).toHaveClass(/dark/);

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await row1.click();

  const pane = page.locator('[data-qa="detail-pane"]');
  await expect(pane).toBeVisible();
  const background = await pane.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).toBe('rgb(36, 29, 48)');
});
