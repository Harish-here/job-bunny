import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageHandle } from '../../../../ports/browser.ts';
import type { Logger, RunContext } from '../../../../ports/context.ts';
import type { Inventory } from '../inventory.ts';
import { harvestCards } from './harvest.ts';

/** Real selectors from src/adapters/lanes/linkedin/page_inventory/
 * linkedin__jobs-search.json (pinned at phase start) — buildHarvestScript
 * must target these exactly. */
function fixtureInventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    page: 'linkedin__jobs-search',
    pageType: 'details-page',
    generatedAt: '2026-06-18',
    selectors: {
      cardList: '.scaffold-layout__list',
      card: 'li[data-occludable-job-id]',
      cardTitle: '.artdeco-entity-lockup__title',
      cardCompany: '.artdeco-entity-lockup__subtitle',
      cardLocation: '.artdeco-entity-lockup__caption',
      cardLink: 'a.job-card-container__link',
      jdRoot: '#job-details',
    },
    behaviors: {},
    ...overrides,
  };
}

/** Real selectors from src/adapters/lanes/linkedin/page_inventory/
 * linkedin__jobs-search-results.json — cardLink duplicates the card selector
 * (no href anywhere on the card);
 * the id lives in the componentkey attribute, per jobCardIdAttr /
 * jobCardIdAttrPrefix, and the job url is built from urlPatternOfJob. */
function componentkeyInventory(overrides: Partial<Inventory> = {}): Inventory {
  const cardSel = 'div[componentkey^="job-card-component-ref-"]';
  return {
    page: 'linkedin__jobs-search-results',
    pageType: 'details-page',
    generatedAt: '2026-06-30',
    selectors: {
      cardList: 'body',
      card: cardSel,
      cardTitle: 'p',
      cardCompany: 'p:nth(1)',
      cardLocation: 'p:nth(2)',
      cardLink: cardSel,
      jdRoot: '#job-details',
    },
    behaviors: {
      jobCardIdAttr: 'componentkey',
      jobCardIdAttrPrefix: 'job-card-component-ref-',
      urlPatternOfJob: 'https://www.linkedin.com/jobs/view/<id>/',
    },
    ...overrides,
  };
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
    beat() {},
    ...overrides,
  };
}

// --- harvestCards: fake PageHandle, id parsing + url resolution + skip-on-no-id ---

function fakePage(overrides: Partial<PageHandle> = {}): PageHandle {
  return {
    goto: async () => undefined,
    evaluate: async () => undefined as never,
    click: async () => undefined,
    waitFor: async () => undefined,
    content: async () => '',
    close: async () => undefined,
    ...overrides,
  };
}

test('harvestCards maps raw cards to HarvestedCard: id parsed from href, relative url resolved absolute', async () => {
  const inv = fixtureInventory();
  const page = fakePage({
    evaluate: async () =>
      [
        {
          title: 'Senior Backend Engineer',
          company: 'Acme Corp',
          location: 'Remote',
          href: '/jobs/view/4021337/',
        },
      ] as never,
  });

  const cards = await harvestCards(page, inv, fakeCtx());

  assert.deepEqual(cards, [
    {
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      url: 'https://www.linkedin.com/jobs/view/4021337/',
      id: 'li-4021337',
    },
  ]);
});

test('harvestCards resolves an already-absolute href unchanged and skips a card with no parseable id, warning', async () => {
  const inv = fixtureInventory();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });
  const page = fakePage({
    evaluate: async () =>
      [
        {
          title: 'Absolute URL Card',
          company: 'Foo',
          location: '',
          href: 'https://www.linkedin.com/jobs/view/555/',
        },
        {
          title: 'Broken Card',
          company: 'Bar',
          location: '',
          href: '/jobs/collections/whatever',
        },
      ] as never,
  });

  const cards = await harvestCards(page, inv, ctx);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.id, 'li-555');
  assert.equal(cards[0]?.url, 'https://www.linkedin.com/jobs/view/555/');
  assert.equal(warnings.length, 1);
});

test('harvestCards passes a timeoutMs through to page.evaluate opts', async () => {
  const inv = fixtureInventory();
  let seenTimeout: number | undefined;
  const page = fakePage({
    evaluate: async (_fn, opts) => {
      seenTimeout = (opts as { timeoutMs: number }).timeoutMs;
      return [
        { title: 'Staff Engineer', company: 'Acme', location: '', href: '/jobs/view/1/' },
      ] as never;
    },
  });
  await harvestCards(page, inv, fakeCtx(), { timeoutMs: 5000 });
  assert.equal(seenTimeout, 5000);
});

test('harvestCards, for the componentkey inventory shape (no href), derives the id from the idAttr and builds the url from urlPatternOfJob', async () => {
  const inv = componentkeyInventory();
  const page = fakePage({
    evaluate: async () =>
      [
        {
          title: 'Senior Backend Engineer',
          company: 'Acme Corp',
          location: 'Remote',
          href: '',
          idAttr: 'job-card-component-ref-4021337',
        },
      ] as never,
  });

  const cards = await harvestCards(page, inv, fakeCtx());

  assert.deepEqual(cards, [
    {
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      url: 'https://www.linkedin.com/jobs/view/4021337/',
      id: 'li-4021337',
    },
  ]);
});

test('harvestCards skips a card with neither a parseable href nor an idAttr, warning', async () => {
  // minJobCards 0 — as the real linkedin__jobs-search-results inventory
  // declares. Ending with zero cards IS the behavior under test here, so the
  // min-cards assertion must not be what fires.
  const inv = componentkeyInventory({
    behaviors: { ...componentkeyInventory().behaviors, minJobCards: '0' },
  });
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });
  const page = fakePage({
    evaluate: async () =>
      [
        {
          title: 'No Id Card',
          company: 'Foo',
          location: '',
          href: '',
          idAttr: null,
        },
      ] as never,
  });

  const cards = await harvestCards(page, inv, ctx);

  assert.deepEqual(cards, []);
  // Two warns now: the skip itself, plus harvestCards' "harvested 0 cards"
  // (minJobCards 0 tolerates empty, but never silently). Assert on the skip.
  const skipWarn = (warnings as Array<{ msg: string }>).filter((w) =>
    /skipping card/.test(w.msg),
  );
  assert.equal(skipWarn.length, 1);
});

test('harvestCards skips a card with an idAttr but no url pattern and no href, warning (id resolved, url not)', async () => {
  const inv = componentkeyInventory({
    behaviors: {
      jobCardIdAttr: 'componentkey',
      jobCardIdAttrPrefix: 'job-card-component-ref-',
      // Ending with zero cards IS the behavior under test — the min-cards
      // assertion must not be what fires.
      minJobCards: '0',
    },
  });
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });
  const page = fakePage({
    evaluate: async () =>
      [
        {
          title: 'No Pattern Card',
          company: 'Foo',
          location: '',
          href: '',
          idAttr: 'job-card-component-ref-777',
        },
      ] as never,
  });

  const cards = await harvestCards(page, inv, ctx);

  assert.deepEqual(cards, []);
  // Two warns now: the skip itself, plus harvestCards' "harvested 0 cards"
  // (minJobCards 0 tolerates empty, but never silently). Assert on the skip.
  const skipWarn = (warnings as Array<{ msg: string }>).filter((w) =>
    /skipping card/.test(w.msg),
  );
  assert.equal(skipWarn.length, 1);
});

test('harvestCards prefers an href-derived id over the idAttr when both are present', async () => {
  const inv = componentkeyInventory();
  const page = fakePage({
    evaluate: async () =>
      [
        {
          title: 'Both Present',
          company: 'Acme Corp',
          location: 'Remote',
          href: '/jobs/view/999/',
          idAttr: 'job-card-component-ref-4021337',
        },
      ] as never,
  });

  const cards = await harvestCards(page, inv, fakeCtx());

  assert.equal(cards[0]?.id, 'li-999');
  assert.equal(cards[0]?.url, 'https://www.linkedin.com/jobs/view/999/');
});

// --- harvest readiness: the wait + the min-cards assertion ---
//
// Regression tests, 2026-07-25. The first real v2 run harvested ZERO cards
// from all 21 of harish's search URLs, logged nothing, threw nothing, marked
// every URL done, and reported `outcome: passed`. Cause: harvestCards ran its
// in-page read immediately after page.goto(), so it read a still-hydrating SPA
// DOM, and `listEl ? ... : []` returned [] silently. v0 never had this hole —
// scripts/pipeline/extract/cards.js's runAssertions waits (bounded) for
// must_exist and job_card to attach and THROWS on count < min_job_cards. Both
// values already live in the inventory (behaviors.mustExist / minJobCards);
// v2 simply ignored them.

test('harvestCards waits for the mustExist selector before reading the DOM', async () => {
  const inv = fixtureInventory({
    behaviors: { mustExist: '.scaffold-layout__list', minJobCards: '1' },
  });
  const waited: string[] = [];
  let evaluatedAfterWait = false;
  const page = fakePage({
    waitFor: async (selector: string) => {
      waited.push(selector);
    },
    evaluate: async () => {
      evaluatedAfterWait = waited.length > 0;
      return [
        { title: 'Staff Engineer', company: 'Acme', location: '', href: '/jobs/view/1/' },
      ] as never;
    },
  });

  await harvestCards(page, inv, fakeCtx());

  assert.deepEqual(waited, ['.scaffold-layout__list']);
  assert.equal(evaluatedAfterWait, true);
});

test('harvestCards falls back to the cardList selector when no mustExist behavior is declared', async () => {
  const inv = fixtureInventory();
  const waited: string[] = [];
  const page = fakePage({
    waitFor: async (selector: string) => {
      waited.push(selector);
    },
    evaluate: async () =>
      [
        { title: 'Staff Engineer', company: 'Acme', location: '', href: '/jobs/view/1/' },
      ] as never,
  });

  await harvestCards(page, inv, fakeCtx());

  assert.deepEqual(waited, ['.scaffold-layout__list']);
});

test('harvestCards throws when the mustExist selector never attaches', async () => {
  const inv = fixtureInventory();
  const page = fakePage({
    waitFor: async () => {
      throw new Error('timeout waiting for selector');
    },
  });

  await assert.rejects(
    () => harvestCards(page, inv, fakeCtx()),
    /never attached|timeout waiting for selector/,
  );
});

test('harvestCards throws when the page yields fewer cards than minJobCards', async () => {
  const inv = fixtureInventory({ behaviors: { minJobCards: '1' } });
  const page = fakePage({ evaluate: async () => [] as never });

  await assert.rejects(() => harvestCards(page, inv, fakeCtx()), /0 card\(s\).*min/);
});

// --- allowEmpty (tail-page quiet end-of-results) ---

test('harvestCards with allowEmpty: true returns [] instead of throwing when the page yields zero cards', async () => {
  const inv = fixtureInventory({ behaviors: { minJobCards: '1' } });
  const page = fakePage({ evaluate: async () => [] as never });

  const cards = await harvestCards(page, inv, fakeCtx(), { allowEmpty: true });

  assert.deepEqual(cards, []);
});

test('harvestCards with allowEmpty: false (the default) still throws when the page yields zero cards', async () => {
  const inv = fixtureInventory({ behaviors: { minJobCards: '1' } });
  const page = fakePage({ evaluate: async () => [] as never });

  await assert.rejects(() => harvestCards(page, inv, fakeCtx()), /0 card\(s\).*min/);
});

test('harvestCards with allowEmpty: true returns [] instead of throwing when the readiness selector never attaches (container missing entirely)', async () => {
  const inv = fixtureInventory({ behaviors: { minJobCards: '1' } });
  const page = fakePage({
    waitFor: async () => {
      throw new Error('timeout waiting for selector');
    },
  });

  const cards = await harvestCards(page, inv, fakeCtx(), { allowEmpty: true });

  assert.deepEqual(cards, []);
});

test('harvestCards with allowEmpty: true does not suppress a genuinely unexpected evaluate error', async () => {
  const inv = fixtureInventory({ behaviors: { minJobCards: '1' } });
  const page = fakePage({
    evaluate: async () => {
      throw new Error('evaluate crashed: execution context was destroyed');
    },
  });

  await assert.rejects(
    () => harvestCards(page, inv, fakeCtx(), { allowEmpty: true }),
    /execution context was destroyed/,
  );
});

test('harvestCards tolerates an empty page when minJobCards is 0, but says so loudly', async () => {
  const inv = componentkeyInventory({
    behaviors: {
      ...componentkeyInventory().behaviors,
      minJobCards: '0',
    },
  });
  const warnings: string[] = [];
  const ctx = fakeCtx({
    logger: {
      debug() {},
      info() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
    },
  });
  const page = fakePage({ evaluate: async () => [] as never });

  const cards = await harvestCards(page, inv, ctx);

  assert.deepEqual(cards, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /harvested 0 cards/);
});
