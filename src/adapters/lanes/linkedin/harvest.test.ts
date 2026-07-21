import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { FilterConfigSchema } from '../../../core/filter/config.ts';
import type { PageHandle } from '../../../ports/browser.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { buildHarvestScript, gateCards, harvestCards } from './harvest.ts';
import type { Inventory } from './inventory.ts';

/** Real selectors from page_inventory/linkedin__jobs-search.json (pinned at
 * phase start) — buildHarvestScript must target these exactly. */
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

// --- buildHarvestScript, evaluated over a minimal fake `document` via node:vm ---

interface FakeElSpec {
  title?: string;
  company?: string;
  location?: string;
  href?: string | null;
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
 * mirrors the real inventory selectors, backed by a fixture list of cards. */
function fakeDocument(inv: Inventory, cards: FakeElSpec[]): unknown {
  const sel = inv.selectors;
  const cardEls = cards.map((c) => {
    const subEls: Record<string, unknown> = {
      [sel.cardTitle]: fakeElement({ textContent: c.title }),
      [sel.cardCompany]: fakeElement({ textContent: c.company }),
      [sel.cardLocation]: fakeElement({ textContent: c.location }),
      [sel.cardLink]: c.href === null ? null : fakeElement({ href: c.href ?? '' }),
    };
    return {
      querySelector(s: string) {
        return subEls[s] ?? null;
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

test('buildHarvestScript, evaluated in a fake DOM, returns the raw cards read via the inventory selectors', () => {
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
  // structuredClone: the vm context is a separate realm, so its Array/Object
  // aren't reference-equal to this realm's — clone into plain values before
  // a strict deepEqual (node:assert/strict's deepEqual IS deepStrictEqual).
  const result = structuredClone(vm.runInNewContext(script, { document }));

  assert.deepEqual(result, [
    {
      title: 'Senior Backend Engineer',
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
  ]);
});

test('buildHarvestScript returns [] when the card list container is absent', () => {
  const inv = fixtureInventory();
  const document = { querySelector: () => null };
  const script = buildHarvestScript(inv);
  const result = structuredClone(vm.runInNewContext(script, { document }));
  assert.deepEqual(result, []);
});

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
      return [] as never;
    },
  });
  await harvestCards(page, inv, fakeCtx(), { timeoutMs: 5000 });
  assert.equal(seenTimeout, 5000);
});

// --- gateCards: real FilterConfig, pass/dropped partition ---

test('gateCards partitions cards by the card-gate rules and records identity-only JDs for drops', () => {
  const cfg = FilterConfigSchema.parse({
    companies: { avoid: ['Bad Co'] },
  });
  const keeper = {
    title: 'Backend Engineer',
    company: 'Good Co',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/111/',
    id: 'li-111',
  };
  const dropped = {
    title: 'Backend Engineer',
    company: 'Bad Co',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/222/',
    id: 'li-222',
  };

  const result = gateCards([keeper, dropped], cfg);

  assert.deepEqual(result.pass, [keeper]);
  assert.equal(result.dropped.length, 1);
  const record = result.dropped.at(0);
  assert.equal(record?.jd.identity.id, 'li-222');
  assert.equal(record?.jd.identity.lane, 'linkedin');
  assert.equal(record?.jd.identity.company, 'Bad Co');
  assert.equal(record?.jd.identity.title, 'Backend Engineer');
  assert.equal(record?.jd.identity.url, 'https://www.linkedin.com/jobs/view/222/');
  assert.ok(record?.reasons.some((v) => v.rule === 'company.avoid' && v.pass === false));
});

test('gateCards keeps a card when no rule fails (empty FilterConfig ⇒ everything passes)', () => {
  const cfg = FilterConfigSchema.parse({});
  const card = {
    title: 'Anything',
    company: 'Anyone',
    location: 'Anywhere',
    url: 'https://www.linkedin.com/jobs/view/333/',
    id: 'li-333',
  };
  const result = gateCards([card], cfg);
  assert.deepEqual(result.pass, [card]);
  assert.deepEqual(result.dropped, []);
});
