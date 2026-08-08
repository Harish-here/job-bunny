import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import type { Inventory } from '../inventory.ts';
import { buildHarvestScript } from './script.ts';

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

// --- buildHarvestScript, evaluated over a minimal fake `document` via node:vm ---

interface FakeElSpec {
  title?: string;
  company?: string;
  location?: string;
  href?: string | null;
  /** Value returned for the inventory's behaviors.jobCardIdAttr, read
   * directly off the card element (mirrors real componentkey reads). */
  idAttr?: string | null;
}

/** Minimal DOM element stub: textContent for text reads, getAttribute for
 * the href read (mirrors what the real in-page script calls). */
function fakeElement(props: Record<string, string | null | undefined> = {}): unknown {
  return {
    get textContent() {
      return props.textContent ?? null;
    },
    getAttribute(name: string) {
      return props[name] ?? null;
    },
  };
}

/** Builds a fake `document` whose card-list -> card -> sub-selector chain
 * mirrors the real inventory selectors, backed by a fixture list of cards.
 * Every card is already fully "mounted" (text present from the first
 * read), so this helper is for tests about mapping and chunk counting, not
 * about the mount/settle/repair loops. */
function fakeDocument(inv: Inventory, cards: FakeElSpec[]): unknown {
  const sel = inv.selectors;
  const selfLinksToCard = sel.cardLink === sel.card;
  const idAttrName = inv.behaviors.jobCardIdAttr;
  const cardEls = cards.map((c) => {
    const subEls: Record<string, unknown> = {
      [sel.cardTitle]: fakeElement({ textContent: c.title }),
      [sel.cardCompany]: fakeElement({ textContent: c.company }),
      [sel.cardLocation]: fakeElement({ textContent: c.location }),
    };
    if (!selfLinksToCard) {
      subEls[sel.cardLink] = c.href === null ? null : fakeElement({ href: c.href ?? '' });
    }
    return {
      querySelector(s: string) {
        return subEls[s] ?? null;
      },
      matches(s: string) {
        return s === sel.card;
      },
      getAttribute(name: string) {
        if (selfLinksToCard && name === 'href') return c.href ?? null;
        if (idAttrName && name === idAttrName) return c.idAttr ?? null;
        return null;
      },
      scrollIntoView() {},
    };
  });
  const listEl = {
    querySelectorAll(s: string) {
      return s === sel.card ? cardEls : [];
    },
  };
  return {
    querySelector(s: string) {
      return s === sel.cardList ? listEl : null;
    },
  };
}

test('buildHarvestScript, evaluated in a fake DOM, returns the raw cards read via the inventory selectors', async () => {
  const inv = fixtureInventory();
  const cards: FakeElSpec[] = [
    {
      title: '  Senior Backend Engineer  ',
      company: 'Acme Corp',
      location: 'Remote',
      href: '/jobs/view/4021337/',
    },
    {
      title: 'Staff Engineer',
      company: 'Widgets Inc',
      location: 'Bengaluru, India',
      href: '/jobs/view/9988776/?refId=abc',
    },
  ];
  const document = fakeDocument(inv, cards);
  const script = buildHarvestScript(inv);
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: unknown[]; diag: Record<string, number> };

  assert.deepEqual(result.cards, [
    {
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      href: '/jobs/view/4021337/',
      idAttr: null,
    },
    {
      title: 'Staff Engineer',
      company: 'Widgets Inc',
      location: 'Bengaluru, India',
      href: '/jobs/view/9988776/?refId=abc',
      idAttr: null,
    },
  ]);
  assert.equal(result.diag.cardCount, 2);
  assert.equal(result.diag.emptyAfterRead, 0);
  assert.equal(result.diag.repairAttempted, 0);
  assert.equal(result.diag.emptyAfterRepair, 0);
});

test('buildHarvestScript, evaluated against the componentkey inventory shape, reads the id off the card element itself (no descendant href)', async () => {
  const inv = componentkeyInventory();
  const cards: FakeElSpec[] = [
    {
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      href: null,
      idAttr: 'job-card-component-ref-4021337',
    },
  ];
  const document = fakeDocument(inv, cards);
  const script = buildHarvestScript(inv);
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: unknown[] };

  assert.deepEqual(result.cards, [
    {
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      href: '',
      idAttr: 'job-card-component-ref-4021337',
    },
  ]);
});

test('buildHarvestScript returns an empty cards array when the card list container is absent', async () => {
  const inv = fixtureInventory();
  const document = { querySelector: () => null };
  const script = buildHarvestScript(inv);
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: unknown[]; diag: Record<string, number> };
  assert.deepEqual(result.cards, []);
  assert.equal(result.diag.cardCount, 0);
});

test('buildHarvestScript, evaluated in a fake DOM with a card list larger than one chunk, still returns every card, chunked in groups of 5', async () => {
  const inv = fixtureInventory();
  const cards: FakeElSpec[] = Array.from({ length: 12 }, (_, i) => ({
    title: `Job ${i}`,
    company: `Company ${i}`,
    location: 'Remote',
    href: `/jobs/view/${1000 + i}/`,
  }));
  const document = fakeDocument(inv, cards);
  const script = buildHarvestScript(inv);
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: unknown[]; diag: Record<string, number> };
  assert.equal(result.cards.length, 12);
  assert.equal(result.diag.chunks, 3);
});

/** Builds a fake document whose cards mirror LinkedIn's real virtualized
 * behavior for the purpose of this regression test: a card's title/company
 * only read as real text while it is the MOST RECENTLY scrolled-to card —
 * scrolling any later card blanks every earlier one. This is what makes
 * "scroll everything, then read everything" (the old design) lose every
 * card but the last one it touched, while "read a chunk immediately after
 * scrolling it, then individually re-scroll-and-read stragglers in the
 * repair pass" (the new design) recovers all of them. */
function scrollTrackedDocument(
  inv: Inventory,
  cards: Array<{ title: string; company: string; href: string }>,
): { document: unknown; scrollOrder: number[] } {
  const sel = inv.selectors;
  const active = { index: -1 };
  const scrollOrder: number[] = [];
  const cardEls = cards.map((c, i) => {
    const titleEl = {
      get textContent() {
        return active.index === i ? c.title : '';
      },
    };
    const companyEl = {
      get textContent() {
        return active.index === i ? c.company : '';
      },
    };
    const linkEl = { getAttribute: () => c.href };
    return {
      querySelector(s: string) {
        if (s === sel.cardTitle) return titleEl;
        if (s === sel.cardCompany) return companyEl;
        if (s === sel.cardLink) return linkEl;
        return null;
      },
      matches() {
        return false;
      },
      getAttribute() {
        return null;
      },
      scrollIntoView() {
        active.index = i;
        scrollOrder.push(i);
      },
    };
  });
  const listEl = { querySelectorAll: (s: string) => (s === sel.card ? cardEls : []) };
  const document = { querySelector: (s: string) => (s === sel.cardList ? listEl : null) };
  return { document, scrollOrder };
}

/** Builds a fake document that models a WINDOW of `windowSize` consecutive
 * cards visible at once, anchored at whichever card was most recently
 * scrolled to (scrollIntoView's default block:'start' puts that card at the
 * top, so the cards after it — up to windowSize — come along for free).
 * This is what actually discriminates "scroll only chunk[0]" from "scroll
 * every card in the chunk": the single-most-recent-card model in
 * scrollTrackedDocument above shows only one card visible no matter which
 * element gets scrolled, so it can't tell the two strategies apart — both
 * end up rescuing almost everything through the repair pass. A window wide
 * enough to hold a whole chunk (windowSize > chunkSize) makes the correct
 * strategy mount the entire chunk on the FIRST read, with the repair pass
 * barely touched. */
function windowTrackedDocument(
  inv: Inventory,
  cards: Array<{ title: string; company: string; href: string }>,
  windowSize: number,
): { document: unknown } {
  const sel = inv.selectors;
  const windowStart = { index: 0 };
  const visible = (i: number) =>
    i >= windowStart.index && i < windowStart.index + windowSize;
  const cardEls = cards.map((c, i) => {
    const titleEl = {
      get textContent() {
        return visible(i) ? c.title : '';
      },
    };
    const companyEl = {
      get textContent() {
        return visible(i) ? c.company : '';
      },
    };
    const linkEl = { getAttribute: () => c.href };
    return {
      querySelector(s: string) {
        if (s === sel.cardTitle) return titleEl;
        if (s === sel.cardCompany) return companyEl;
        if (s === sel.cardLink) return linkEl;
        return null;
      },
      matches() {
        return false;
      },
      getAttribute() {
        return null;
      },
      scrollIntoView() {
        windowStart.index = i;
      },
    };
  });
  const listEl = { querySelectorAll: (s: string) => (s === sel.card ? cardEls : []) };
  const document = { querySelector: (s: string) => (s === sel.cardList ? listEl : null) };
  return { document };
}

test('buildHarvestScript scrolls only chunk[0] per chunk, so a viewport window that fits a whole chunk mounts every card on the first read — no reliance on the repair pass', async () => {
  const inv = fixtureInventory();
  const cards = Array.from({ length: 12 }, (_, i) => ({
    title: `Job ${i}`,
    company: `Company ${i}`,
    href: `/jobs/view/${4000 + i}/`,
  }));
  // Window of 7 visible cards from the last scrolled-to index — bigger than
  // CHUNK_SIZE (5), mirroring a real results list where more cards fit on
  // screen than one chunk holds.
  const { document } = windowTrackedDocument(inv, cards, 7);
  const script = buildHarvestScript(inv, {
    chunkSettleBudgetMs: 30,
    chunkSettlePollMs: 5,
  });
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: Array<{ title: string; company: string }>; diag: Record<string, number> };

  assert.equal(result.cards.length, 12);
  for (const c of result.cards) {
    assert.notEqual(c.title, '');
    assert.notEqual(c.company, '');
  }
  assert.ok(
    result.diag.emptyAfterRead !== undefined && result.diag.emptyAfterRead <= 1,
    `expected emptyAfterRead <= 1, got ${result.diag.emptyAfterRead}`,
  );
  assert.ok(
    result.diag.repairAttempted !== undefined && result.diag.repairAttempted <= 1,
    `expected repairAttempted <= 1, got ${result.diag.repairAttempted}`,
  );
});

test('buildHarvestScript reads a chunk before scrolling past it — the regression test for the whole fix (fails against the old scroll-all-then-read design)', async () => {
  const inv = fixtureInventory();
  const cards = Array.from({ length: 12 }, (_, i) => ({
    title: `Job ${i}`,
    company: `Company ${i}`,
    href: `/jobs/view/${2000 + i}/`,
  }));
  const { document } = scrollTrackedDocument(inv, cards);
  // Budgets shrunk purely so the settle loop (which cannot itself recover
  // anything here — only the repair pass's per-card re-scroll can) doesn't
  // burn its full real-time allowance; the assertion this makes is
  // unaffected by the shrink.
  const script = buildHarvestScript(inv, {
    chunkSettleBudgetMs: 30,
    chunkSettlePollMs: 5,
  });
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: Array<{ title: string; company: string }> };

  assert.equal(result.cards.length, 12);
  for (const c of result.cards) {
    assert.notEqual(c.title, '');
    assert.notEqual(c.company, '');
  }
});

/** A fake element whose textContent starts empty and flips to real text
 * once `Date.now()` passes a deadline computed at construction — models a
 * card genuinely mounting shortly after being scrolled into view, without
 * depending on how many times it happens to be read. */
function timedElement(finalText: string, delayMs: number): unknown {
  const readyAt = Date.now() + delayMs;
  return {
    get textContent() {
      return Date.now() >= readyAt ? finalText : '';
    },
  };
}

test('buildHarvestScript: a late-mounting card settles within its chunk budget, without needing the repair pass', async () => {
  const inv = fixtureInventory();
  const sel = inv.selectors;
  const titleEl = timedElement('Late Title', 150);
  const companyEl = timedElement('Late Co', 150);
  const cardEl = {
    querySelector(s: string) {
      if (s === sel.cardTitle) return titleEl;
      if (s === sel.cardCompany) return companyEl;
      if (s === sel.cardLink) return { getAttribute: () => '/jobs/view/1/' };
      return null;
    },
    matches() {
      return false;
    },
    scrollIntoView() {},
  };
  const listEl = { querySelectorAll: () => [cardEl] };
  const document = { querySelector: (s: string) => (s === sel.cardList ? listEl : null) };
  const script = buildHarvestScript(inv, {
    chunkSettleBudgetMs: 1_000,
    chunkSettlePollMs: 10,
  });
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: Array<{ title: string; company: string }>; diag: Record<string, number> };

  assert.equal(result.cards[0]?.title, 'Late Title');
  assert.equal(result.cards[0]?.company, 'Late Co');
  assert.equal(result.diag.repairAttempted, 0);
});

test('buildHarvestScript: a card that never mounts is reported in diag, not thrown', async () => {
  const inv = fixtureInventory();
  const sel = inv.selectors;
  const cardEl = {
    querySelector(s: string) {
      if (s === sel.cardTitle) return { textContent: '' };
      if (s === sel.cardCompany) return null; // never present at all
      if (s === sel.cardLink) return { getAttribute: () => '/jobs/view/2/' };
      return null;
    },
    matches() {
      return false;
    },
    scrollIntoView() {},
  };
  const listEl = { querySelectorAll: () => [cardEl] };
  const document = { querySelector: (s: string) => (s === sel.cardList ? listEl : null) };
  const script = buildHarvestScript(inv, {
    chunkSettleBudgetMs: 20,
    chunkSettlePollMs: 5,
    repairPerCardBudgetMs: 20,
    repairPageBudgetMs: 50,
    totalBudgetMs: 300,
  });

  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: Array<{ title: string; company: string }>; diag: Record<string, number> };

  assert.deepEqual(result.cards, [
    { title: '', company: '', location: '', href: '/jobs/view/2/', idAttr: null },
  ]);
  assert.equal(result.diag.emptyAfterRead, 1);
  assert.equal(result.diag.repairAttempted, 1);
  assert.equal(result.diag.repairRecovered, 0);
  assert.equal(result.diag.emptyAfterRepair, 1);
});

test('buildHarvestScript: the repair pass recovers a card that only mounts on its second scroll', async () => {
  const inv = fixtureInventory();
  const sel = inv.selectors;
  let scrollCount = 0;
  const titleEl = {
    get textContent() {
      return scrollCount >= 2 ? 'Recovered Title' : '';
    },
  };
  const companyEl = {
    get textContent() {
      return scrollCount >= 2 ? 'Recovered Co' : '';
    },
  };
  const cardEl = {
    querySelector(s: string) {
      if (s === sel.cardTitle) return titleEl;
      if (s === sel.cardCompany) return companyEl;
      if (s === sel.cardLink) return { getAttribute: () => '/jobs/view/3/' };
      return null;
    },
    matches() {
      return false;
    },
    scrollIntoView() {
      scrollCount += 1;
    },
  };
  const listEl = { querySelectorAll: () => [cardEl] };
  const document = { querySelector: (s: string) => (s === sel.cardList ? listEl : null) };
  const script = buildHarvestScript(inv, {
    chunkSettleBudgetMs: 20,
    chunkSettlePollMs: 5,
  });

  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  ) as { cards: Array<{ title: string; company: string }>; diag: Record<string, number> };

  assert.equal(result.cards[0]?.title, 'Recovered Title');
  assert.equal(result.cards[0]?.company, 'Recovered Co');
  assert.equal(result.diag.repairRecovered, 1);
  assert.equal(result.diag.emptyAfterRepair, 0);
});

test('buildHarvestScript emits an async IIFE, with no trace of the deleted whole-list hydrate-then-settle design, and interpolates opts-provided budgets', () => {
  const inv = fixtureInventory();
  const defaultScript = buildHarvestScript(inv);
  assert.match(defaultScript, /^\(async \(\) => \{/);
  // Built via concatenation rather than a literal regex so this assertion
  // doesn't itself keep the deleted identifiers alive as greppable text.
  const deletedHydrationDeadline = ['hydration', 'Deadline'].join('');
  const deletedSettleDeadline = ['settle', 'Deadline'].join('');
  assert.equal(defaultScript.includes(deletedHydrationDeadline), false);
  assert.equal(defaultScript.includes(deletedSettleDeadline), false);

  const customScript = buildHarvestScript(inv, {
    totalBudgetMs: 5_000,
    chunkSettleBudgetMs: 250,
  });
  assert.match(customScript, /totalBudgetMs = 5000/);
  assert.match(customScript, /chunkSettleBudgetMs = 250/);
});
