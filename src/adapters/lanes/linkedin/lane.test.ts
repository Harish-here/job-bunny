import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ZodType } from 'zod';
import { FilterConfigSchema } from '../../../core/filter/config.ts';
import { type JD, JDSchema } from '../../../core/jd/index.ts';
import type {
  BrowserHandle,
  BrowserProvider,
  PageHandle,
} from '../../../ports/browser.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import type { Storage } from '../../../ports/storage.ts';
import { CAPTURE_PATH } from './capture_store.ts';
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

/** In-memory fake mirroring the real FsStorage contract. `writes` logs
 * every writeJson call's relPath, in order — used to assert persistence
 * happens incrementally (per-url) rather than once at the end. */
class FakeStorage implements Storage {
  private readonly files = new Map<string, unknown>();
  readonly writes: string[] = [];

  set(relPath: string, value: unknown): void {
    this.files.set(relPath, value);
  }

  get(relPath: string): unknown {
    return this.files.get(relPath);
  }

  async readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined> {
    if (!this.files.has(relPath)) return undefined;
    return schema.parse(this.files.get(relPath));
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    this.files.set(relPath, value);
    this.writes.push(relPath);
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
  /** 0-based call indices on which newPage() throws instead of
   * succeeding — models a dead CDP context (finding 4). */
  private readonly failNewPageAt: Set<number>;
  private newPageCalls = 0;

  constructor(script: Script, failNewPageAt: Set<number> = new Set()) {
    this.script = script;
    this.failNewPageAt = failNewPageAt;
  }

  async newPage(): Promise<PageHandle> {
    const callIndex = this.newPageCalls;
    this.newPageCalls += 1;
    if (this.failNewPageAt.has(callIndex)) {
      throw new Error(`newPage failed (CDP context dead) on call #${callIndex}`);
    }
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
  private readonly failNewPageAt: Set<number>;

  constructor(
    script: Script,
    failLaunch = false,
    failNewPageAt: Set<number> = new Set(),
  ) {
    this.script = script;
    this.failLaunch = failLaunch;
    this.failNewPageAt = failNewPageAt;
  }

  async launch(): Promise<BrowserHandle> {
    if (this.failLaunch) {
      throw new Error('Chrome would not launch');
    }
    this.handle = new FakeBrowserHandle(this.script, this.failNewPageAt);
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

/** A previously-flushed capture, as CaptureStore would have persisted it —
 * used to seed CAPTURE_PATH directly in the fake Storage. */
function fakeCapturedJD(id: string, company = 'Acme'): JD {
  return JDSchema.parse({
    identity: {
      id,
      lane: 'linkedin',
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      company,
      title: 'Frontend Engineer',
      scrapedAt: '2026-07-20T09:00:00.000Z',
    },
    content: { rawText: `JD text — ${id}` },
  });
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

  const { jobs, dropped, companiesSeen } = await lane.source(ctx);

  assert.equal(jobs.length, 4);
  for (const jd of jobs) {
    assert.equal(jd.identity.lane, 'linkedin');
    assert.ok(jd.content?.rawText);
  }
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1001', 'li-1003', 'li-2001', 'li-2002']);

  // Bad Co (li-1002) was gated out by the card-gate — its DroppedRecord
  // must flow through source(), not be silently discarded (finding 5).
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.jd.identity.id, 'li-1002');
  assert.equal(dropped[0]?.jd.identity.company, 'Bad Co');
  assert.ok(
    dropped[0]?.reasons.some((v) => v.rule === 'company.avoid' && v.pass === false),
  );

  assert.deepEqual([...companiesSeen].sort(), ['Acme', 'Globex', 'Initech']);
  assert.ok(beats >= 4);
});

test("one url's goto/harvest throws: logged and skipped, the other url is still processed, source() does not throw (partial failure isn't aggregate failure)", async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

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
  const urlFailedWarning = warnings.find(
    (w) => (w as { msg: string }).msg === 'linkedin lane: url failed',
  ) as { data: { message: string } } | undefined;
  assert.ok(urlFailedWarning);
  assert.match(urlFailedWarning.data.message, /goto failed/);

  // markDone must NOT have been called for the failed url — only url2 is
  // in the persisted done-map (finding 2b).
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.equal(Object.hasOwn(persisted.done, URL_1), false);
  assert.equal(Object.hasOwn(persisted.done, URL_2), true);
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

  // The url itself succeeded (only one card within it failed) — it must
  // still be marked done, unlike a whole-url failure.
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.ok(Object.hasOwn(persisted.done, URL_1));
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

test('resume: captures already flushed by an earlier fire today are reloaded, so a skipped (already-done) url still contributes its jobs (finding 2c)', async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 2 } });
  // url1's jobs from the earlier fire, already durably flushed.
  storage.set(CAPTURE_PATH, [
    fakeCapturedJD('li-1001', 'Acme'),
    fakeCapturedJD('li-1003', 'Globex'),
  ]);
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  // url1 is skipped (page never opened) but its previously-flushed
  // captures still surface, alongside url2's freshly harvested jobs.
  assert.equal(provider.handle?.pages.length, 1);
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1001', 'li-1003', 'li-2001', 'li-2002']);
});

test('same-day second fire: when ResumeState already has ALL urls marked done, source() rescan-resets and re-opens/harvests every url instead of skipping them, and clears stale captures (finding 2)', async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 3, [URL_2]: 2 } });
  // A stale ghost from the earlier fire(s) today, no longer part of any
  // card this run harvests — rescanReset's capture-file clear must drop
  // it, or it would linger forever.
  storage.set(CAPTURE_PATH, [fakeCapturedJD('li-9999', 'GhostCo')]);
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  // Both urls' pages were opened (not skipped) and jobs came back from both.
  assert.equal(provider.handle?.pages.length, 2);
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1001', 'li-1003', 'li-2001', 'li-2002']);
  assert.ok(!ids.includes('li-9999'));
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

test('every attempted url failing is a loud aggregate failure — shaped like an expired LinkedIn session (finding 3)', async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  script.gotoThrows.add(URL_2);
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

  await assert.rejects(() => lane.source(ctx), /expired LinkedIn session|logout wall/);
});

test('zero attempted urls (empty url list) does not trip the aggregate-failure check', async () => {
  const inv = await realInventory();
  const script = newScript();
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(provider, [inv], [], fixtureFilterConfig(), storage);

  const { jobs } = await lane.source(ctx);
  assert.deepEqual(jobs, []);
});

test("newPage() throwing (dead CDP context) is this url's SoftError alone, not a whole-lane failure (finding 4)", async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
  // url1 is the first newPage() call (index 0); url2 is the second (index 1).
  const provider = new FakeBrowserProvider(script, false, new Set([0]));
  const storage = new FakeStorage();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

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
  const urlFailedWarning = warnings.find(
    (w) => (w as { msg: string }).msg === 'linkedin lane: url failed',
  ) as { data: { message: string } } | undefined;
  assert.ok(urlFailedWarning);
  assert.match(urlFailedWarning.data.message, /newPage failed/);
});

test('resumeState.persist is called after EVERY url (success or failure), not once at the end (finding 2a)', async () => {
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

  const resumeWrites = storage.writes.filter((path) => path === RESUME_STATE_PATH);
  // One persist after url1 (failed) and one after url2 (succeeded) — not
  // a single write at the very end, which would lose url1's outcome (and
  // url2's, if the crash happened before that single end-of-run write).
  assert.equal(resumeWrites.length, 2);
});

test('captured JDs are flushed incrementally (per-JD), not batched at end-of-run (finding 2c)', async () => {
  const inv = await realInventory();
  const script = newScript();
  seedHappyPathScript(script);
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

  // 4 jobs are captured across both urls in the happy-path script — each
  // must have triggered its own persist to CAPTURE_PATH.
  const captureWrites = storage.writes.filter((path) => path === CAPTURE_PATH);
  assert.equal(captureWrites.length, 4);
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

test('a url group with no matching inventory is logged and skipped, not thrown', async () => {
  const inv = await realInventory();
  const script = newScript();
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv], // only has 'linkedin__jobs-search' — 'unknown-page' has none
    [{ page: 'unknown-page', urls: ['https://www.linkedin.com/jobs/search/?x=1'] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  assert.deepEqual(jobs, []);
  const groupWarning = warnings.find(
    (w) => (w as { msg: string }).msg === 'linkedin lane: no inventory found for page',
  ) as { data: { page: string } } | undefined;
  assert.ok(groupWarning);
  assert.equal(groupWarning.data.page, 'unknown-page');
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
