import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ZodType } from 'zod';
import { FilterConfigSchema } from '../../../core/filter/config.ts';
import type {
  BrowserHandle,
  BrowserProvider,
  PageHandle,
} from '../../../ports/browser.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import type { Storage } from '../../../ports/storage.ts';
import type { Inventory } from './inventory.ts';
import { InventorySchema } from './inventory.ts';
import { LinkedInLane, parseSearchUrls } from './lane.ts';
import { RESUME_STATE_PATH } from './resume_state.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function realInventory(): Promise<Inventory> {
  const raw = JSON.parse(
    await readFile(`${REPO_ROOT}page_inventory/linkedin__jobs-search.json`, 'utf8'),
  );
  const inv = InventorySchema.parse(raw);
  assert.equal(inv.pageType, 'details-page');
  return inv;
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

/** In-memory fake mirroring the real FsStorage contract. */
class FakeStorage implements Storage {
  private readonly files = new Map<string, unknown>();

  set(relPath: string, value: unknown): void {
    this.files.set(relPath, value);
  }

  async readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined> {
    if (!this.files.has(relPath)) return undefined;
    return schema.parse(this.files.get(relPath));
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    this.files.set(relPath, value);
  }
}

interface RawCardFixture {
  title: string;
  company: string;
  location: string;
  href: string;
}

/** Shared scripted responses, keyed by url — one FakePage instance is
 * created per lane.newPage() call, but every instance reads from this same
 * script so harvest (search-page evaluate) and JD-open (card-page
 * evaluate/goto) stay consistent across the whole run. */
interface Script {
  gotoThrows: Set<string>;
  harvestByUrl: Map<string, RawCardFixture[]>;
  jdTextByUrl: Map<string, string>;
}

function newScript(): Script {
  return { gotoThrows: new Set(), harvestByUrl: new Map(), jdTextByUrl: new Map() };
}

class FakePage implements PageHandle {
  lastUrl = '';
  closed = false;
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  async goto(url: string): Promise<void> {
    this.lastUrl = url;
    if (this.script.gotoThrows.has(url)) {
      throw new Error(`goto failed for ${url}`);
    }
  }

  async evaluate<T>(fn: string): Promise<T> {
    // buildHarvestScript's source always declares `cardListSel` — a JD-text
    // script (buildJdTextScript) never does. This lets one fake `evaluate`
    // serve both call sites without inspecting PageHandle call order.
    if (fn.includes('cardListSel')) {
      const cards = this.script.harvestByUrl.get(this.lastUrl);
      if (!cards) throw new Error(`no harvest scripted for ${this.lastUrl}`);
      return cards as unknown as T;
    }
    // Missing scripted JD text resolves to '' — openJd treats an empty
    // extracted text as a SoftError, which is exactly how the
    // "card openJd fails" test scenario is triggered below.
    return (this.script.jdTextByUrl.get(this.lastUrl) ?? '') as unknown as T;
  }

  async click(): Promise<void> {}

  async waitFor(): Promise<void> {}

  async content(): Promise<string> {
    return '';
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowserHandle implements BrowserHandle {
  readonly cdpUrl = 'ws://fake-browser';
  readonly pages: FakePage[] = [];
  closed = false;
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  async newPage(): Promise<PageHandle> {
    const page = new FakePage(this.script);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowserProvider implements BrowserProvider {
  readonly name = 'fake-browser';
  handle: FakeBrowserHandle | null = null;
  private readonly script: Script;
  private readonly failLaunch: boolean;

  constructor(script: Script, failLaunch = false) {
    this.script = script;
    this.failLaunch = failLaunch;
  }

  async launch(): Promise<BrowserHandle> {
    if (this.failLaunch) {
      throw new Error('Chrome would not launch');
    }
    this.handle = new FakeBrowserHandle(this.script);
    return this.handle;
  }
}

const URL_1 =
  'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400&sortBy=R';
const URL_2 =
  'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400&sortBy=R';

function fixtureFilterConfig() {
  return FilterConfigSchema.parse({ companies: { avoid: ['Bad Co'] } });
}

/** url1: Acme (keep), Bad Co (gated out), Globex (keep).
 * url2: Acme (keep, dedup company w/ url1), Initech (keep). */
function seedHappyPathScript(script: Script): void {
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/1001/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/1002/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/1003/',
    },
  ]);
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Staff Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/2001/',
    },
    {
      title: 'Staff Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/2002/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/1001/', 'JD text — Acme FE');
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/1003/',
    'JD text — Globex FE',
  );
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/2001/',
    'JD text — Acme Staff',
  );
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/2002/',
    'JD text — Initech Staff',
  );
}

test('happy path: 2 urls, some cards gated out, surviving JDs opened, companiesSeen deduped, beat() ticked', async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  let beats = 0;
  const ctx = fakeCtx({
    beat() {
      beats += 1;
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs, companiesSeen } = await lane.source(ctx);

  assert.equal(jobs.length, 4);
  for (const jd of jobs) {
    assert.equal(jd.identity.lane, 'linkedin');
    assert.ok(jd.content?.rawText);
  }
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1001', 'li-1003', 'li-2001', 'li-2002']);

  assert.deepEqual([...companiesSeen].sort(), ['Acme', 'Globex', 'Initech']);
  assert.ok(beats >= 4);
  assert.equal(lane.errors.length, 0);
});

test("one url's goto/harvest throws: recorded as a SoftError, the other url is still processed, source() does not throw", async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-2001', 'li-2002']);
  assert.equal(lane.errors.length, 1);
  assert.equal(lane.errors[0]?.scope, 'url');
  assert.match(lane.errors[0]?.message ?? '', /goto failed/);
});

test("one card's openJd throws (empty text): that card is skipped, other cards in the same url are still captured", async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1001/'); // Acme in url1 fails to open
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs, companiesSeen } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1003', 'li-2001', 'li-2002']);
  // companiesSeen is recorded at the card-gate step, before JD open —
  // Acme still counts as "seen" even though its JD open failed.
  assert.deepEqual([...companiesSeen].sort(), ['Acme', 'Globex', 'Initech']);
  const cardErrors = lane.errors.filter((e) => /1001/.test(e.message));
  assert.equal(cardErrors.length, 1);
});

test('resume: a url already marked done in ResumeState is skipped entirely — its page is never opened', async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 2 } });
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-2001', 'li-2002']);
  assert.equal(provider.handle?.pages.length, 1); // only url2's page was ever opened
});

test('browser.launch throwing is a loud lane failure: source() rejects', async () => {
  const inv = await realInventory();
  const script = newScript();
  const provider = new FakeBrowserProvider(script, true);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
  );

  await assert.rejects(() => lane.source(ctx), /Chrome would not launch/);
});

test('handle.close() is always called, including when a url fails, and every opened page is closed', async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  await lane.source(ctx);

  assert.equal(provider.handle?.closed, true);
  assert.ok(provider.handle);
  for (const page of provider.handle?.pages ?? []) {
    assert.equal(page.closed, true);
  }
});

test('a url group with no matching inventory is recorded as a SoftError and skipped, not thrown', async () => {
  const inv = await realInventory();
  const script = newScript();
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv], // only has 'linkedin__jobs-search' — 'unknown-page' has none
    [{ page: 'unknown-page', urls: ['https://www.linkedin.com/jobs/search/?x=1'] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  assert.deepEqual(jobs, []);
  assert.equal(lane.errors.length, 1);
  assert.equal(lane.errors[0]?.scope, 'group');
});

// ---------- parseSearchUrls ----------

test('parseSearchUrls parses the rajni search_urls.md fixture into page groups with their urls', async () => {
  const md = await readFile(`${REPO_ROOT}profiles/rajni/search_urls.md`, 'utf8');
  const groups = parseSearchUrls(md);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.page, 'linkedin__jobs-search');
  assert.deepEqual(groups[0]?.urls, [
    'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400&sortBy=R',
    'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400&sortBy=R',
  ]);
});

test('parseSearchUrls drops a page heading with zero urls beneath it', () => {
  const md = [
    '## linkedin',
    '### empty-page',
    '<!-- inventory: page_inventory/empty-page.md -->',
    '',
    '### linkedin__jobs-search',
    '  • Some Search - https://www.linkedin.com/jobs/search/?keywords=X',
  ].join('\n');

  const groups = parseSearchUrls(md);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.page, 'linkedin__jobs-search');
  assert.deepEqual(groups[0]?.urls, ['https://www.linkedin.com/jobs/search/?keywords=X']);
});
