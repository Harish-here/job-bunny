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
 * When cardLink === card (linkedin__jobs-search-results' shape: no href on
 * any descendant), the card element's own getAttribute('href') is used
 * instead of a sub-element lookup — mirrors buildHarvestScript's
 * `el.matches(linkSel) ? el : el.querySelector(linkSel)` fallback. */
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
  // The script is now an async IIFE (hydration pass awaits between
  // chunks), so runInNewContext returns a promise — await it before
  // cloning. structuredClone: the vm context is a separate realm, so its
  // Array/Object aren't reference-equal to this realm's — clone into plain
  // values before a strict deepEqual (node:assert/strict's deepEqual IS
  // deepStrictEqual).
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  );

  assert.deepEqual(result, [
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
  );

  assert.deepEqual(result, [
    {
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      href: '',
      idAttr: 'job-card-component-ref-4021337',
    },
  ]);
});

test('buildHarvestScript returns [] when the card list container is absent', async () => {
  const inv = fixtureInventory();
  const document = { querySelector: () => null };
  const script = buildHarvestScript(inv);
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  );
  assert.deepEqual(result, []);
});

// --- hydration pass: the async IIFE, the budget constant, the scroll call ---

test('buildHarvestScript emits an async IIFE (hydration awaits between chunks, and page.evaluate awaits the returned promise automatically)', () => {
  const inv = fixtureInventory();
  const script = buildHarvestScript(inv);
  assert.match(script, /^\(async \(\) => \{/);
});

test('buildHarvestScript emits a hydration pass that scrolls each card into view before the read, bounded by an explicit deadline', () => {
  const inv = fixtureInventory();
  const script = buildHarvestScript(inv);
  assert.match(script, /scrollIntoView/);
  assert.match(script, /hydrationDeadline/);
  assert.match(script, /Date\.now\(\)/);
  // The budget constant itself is inlined into the script as a literal.
  assert.match(script, /hydrationBudgetMs = 8000/);
});

test('buildHarvestScript emits a settle-poll phase bounded by its own deadline, distinct from the hydration deadline', () => {
  const inv = fixtureInventory();
  const script = buildHarvestScript(inv);
  assert.match(script, /needsSettle/);
  assert.match(script, /settleDeadline/);
  assert.match(script, /cardSettleBudgetMs = 8000/);
});

test('buildHarvestScript, evaluated with a card whose title/company populate a bit late, still returns non-empty text once it settles within the budget', async () => {
  const inv = fixtureInventory();
  // A fake element whose textContent starts empty and flips to real text
  // after a few polls — mirrors a card still hydrating when the hydration
  // pass's own deadline already elapsed.
  function lateElement(finalText: string, readyAfterReads: number): unknown {
    let reads = 0;
    return {
      get textContent() {
        reads += 1;
        return reads > readyAfterReads ? finalText : '';
      },
      getAttribute() {
        return null;
      },
    };
  }
  const sel = inv.selectors;
  const titleEl = lateElement('Late Title', 2);
  const companyEl = lateElement('Late Co', 3);
  const cardEl = {
    querySelector(s: string) {
      if (s === sel.cardTitle) return titleEl;
      if (s === sel.cardCompany) return companyEl;
      if (s === sel.cardLocation) return null;
      if (s === sel.cardLink) return { getAttribute: () => '/jobs/view/1/' };
      return null;
    },
    matches() {
      return false;
    },
  };
  const listEl = { querySelectorAll: () => [cardEl] };
  const document = {
    querySelector: (s: string) => (s === sel.cardList ? listEl : null),
  };
  const script = buildHarvestScript(inv, 2_000, 10);
  const result = structuredClone(
    await vm.runInNewContext(script, { document, setTimeout }),
  );

  assert.deepEqual(result, [
    {
      title: 'Late Title',
      company: 'Late Co',
      location: '',
      href: '/jobs/view/1/',
      idAttr: null,
    },
  ]);
});

test('buildHarvestScript, evaluated with a card whose title/company never settle, returns whatever is present without throwing', async () => {
  const inv = fixtureInventory();
  const sel = inv.selectors;
  const cardEl = {
    querySelector(s: string) {
      if (s === sel.cardTitle) return { textContent: '', getAttribute: () => null };
      if (s === sel.cardCompany) return null; // never present at all
      if (s === sel.cardLocation) return null;
      if (s === sel.cardLink) return { getAttribute: () => '/jobs/view/2/' };
      return null;
    },
    matches() {
      return false;
    },
  };
  const listEl = { querySelectorAll: () => [cardEl] };
  const document = {
    querySelector: (s: string) => (s === sel.cardList ? listEl : null),
  };
  const script = buildHarvestScript(inv, 30, 10);

  const result = await vm.runInNewContext(script, { document, setTimeout });

  assert.deepEqual(structuredClone(result), [
    { title: '', company: '', location: '', href: '/jobs/view/2/', idAttr: null },
  ]);
});

test('buildHarvestScript, evaluated in a fake DOM with a card list larger than one hydration chunk, still returns every card (hydration loop covers the whole list)', async () => {
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
  );
  assert.equal(result.length, 12);
});
