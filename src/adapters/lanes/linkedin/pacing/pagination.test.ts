import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkedInLane } from '../lane.ts';
import { RESUME_STATE_PATH } from '../resume_state.ts';
import {
  FakeBrowserProvider,
  FakeStorage,
  fakeCtx,
  fixtureFilterConfig,
  newScript,
  noopLogger,
  pagedInventory,
  realInventory,
  seedHappyPathScript,
  spySleepFn,
  URL_1,
  URL_2,
} from '../testkit/index.ts';
import { buildPageUrl } from './pagination.ts';

// ---------- pagination ----------

test('buildPageUrl: page 1 returns baseUrl byte-unchanged (no start=0 added)', () => {
  const base = 'https://www.linkedin.com/jobs/search/?keywords=Engineer&sortBy=R';
  assert.equal(buildPageUrl(base, 1, 'start', 25), base);
});

test('buildPageUrl: page 2 sets the param to (pageIndex-1)*pageSize', () => {
  const base = 'https://www.linkedin.com/jobs/search/?keywords=Engineer';
  const result = buildPageUrl(base, 2, 'start', 25);
  const url = new URL(result);
  assert.equal(url.searchParams.get('start'), '25');
});

test('buildPageUrl: overrides an existing start param rather than duplicating it', () => {
  const base = 'https://www.linkedin.com/jobs/search/?keywords=Engineer&start=999';
  const result = buildPageUrl(base, 3, 'start', 25);
  const url = new URL(result);
  assert.equal(url.searchParams.get('start'), '50');
  assert.equal(url.searchParams.getAll('start').length, 1);
});

test('buildPageUrl: preserves every other query param already on the base url', () => {
  const base =
    'https://www.linkedin.com/jobs/search/?keywords=Engineer&f_TPR=r86400&sortBy=R';
  const result = buildPageUrl(base, 2, 'start', 25);
  const url = new URL(result);
  assert.equal(url.searchParams.get('keywords'), 'Engineer');
  assert.equal(url.searchParams.get('f_TPR'), 'r86400');
  assert.equal(url.searchParams.get('sortBy'), 'R');
  assert.equal(url.searchParams.get('start'), '25');
});

test('pagination: 2 pages of distinct cards are both harvested, goto uses the correct per-page urls, jitter runs once per page load plus once per JD open, one log line per page reports harvested/gated counts', async () => {
  const inv = await realInventory();
  const paged = pagedInventory(inv, { maxPages: '2' });
  const script = newScript();
  const baseUrl = 'https://www.linkedin.com/jobs/search/?keywords=Pagination+Test';
  const page2Url = buildPageUrl(baseUrl, 2, 'start', 25);

  script.harvestByUrl.set(baseUrl, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/7001/',
    },
  ]);
  script.harvestByUrl.set(page2Url, [
    {
      title: 'Backend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/7002/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/7001/', 'JD text — 7001');
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/7002/', 'JD text — 7002');

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];
  const infos: Array<{ msg: string; data?: unknown }> = [];
  const ctx = fakeCtx({
    logger: { ...noopLogger, info: (msg, data) => infos.push({ msg, data }) },
  });

  const lane = new LinkedInLane(
    provider,
    [paged],
    [{ page: paged.page, urls: [baseUrl] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    1_000,
    2_000,
    () => 0.5,
    spySleepFn(sleepCalls),
  );

  const { jobs } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-7001', 'li-7002']);

  // A single page (browser tab) is reused across a url's pages — goto is
  // also called for each card's JD open on that same page, so filter down
  // to just the listing-page navigations to check page order.
  assert.equal(provider.handle?.pages.length, 1);
  const listingGotoCalls = (provider.handle?.pages[0]?.gotoCalls ?? []).filter(
    (u) => u === baseUrl || u === page2Url,
  );
  assert.deepEqual(listingGotoCalls, [baseUrl, page2Url]);

  // 2 page-load jitters + 2 JD-open jitters = 4.
  assert.equal(sleepCalls.length, 4);

  const pageLogs = infos.filter(
    (i) => i.msg === 'linkedin lane: page harvested',
  ) as Array<{
    data: { page: number; harvested: number; gated: number };
  }>;
  assert.equal(pageLogs.length, 2);
  assert.deepEqual(
    pageLogs.map((l) => l.data.page),
    [1, 2],
  );
  assert.ok(pageLogs.every((l) => l.data.harvested === 1 && l.data.gated === 1));
});

test('pagination: stop-on-empty (minJobCards 0) — page 2 harvests 0 cards, the loop stops and page 3 is never fetched', async () => {
  const inv = await realInventory();
  const paged = pagedInventory(inv, { maxPages: '5', minJobCards: '0' });
  const script = newScript();
  const baseUrl = 'https://www.linkedin.com/jobs/search/?keywords=Stop+Empty';
  const page2Url = buildPageUrl(baseUrl, 2, 'start', 25);
  const page3Url = buildPageUrl(baseUrl, 3, 'start', 25);

  script.harvestByUrl.set(baseUrl, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/8001/',
    },
  ]);
  script.harvestByUrl.set(page2Url, []);
  script.harvestByUrl.set(page3Url, [
    {
      title: 'Should Not Fetch',
      company: 'Nope',
      location: 'Remote',
      href: '/jobs/view/8003/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/8001/', 'JD text — 8001');

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  const lane = new LinkedInLane(
    provider,
    [paged],
    [{ page: paged.page, urls: [baseUrl] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(fakeCtx());

  assert.deepEqual(
    jobs.map((jd) => jd.identity.id),
    ['li-8001'],
  );
  const listingGotoCalls = (provider.handle?.pages[0]?.gotoCalls ?? []).filter(
    (u) => u === baseUrl || u === page2Url || u === page3Url,
  );
  assert.deepEqual(listingGotoCalls, [baseUrl, page2Url]);
});

test('pagination: an end-of-results tail page (minJobCards 1, the real inventory default) is a quiet stop, not a SoftError — page 1 captures kept, page 3 never fetched', async () => {
  const inv = await realInventory();
  // Deliberately NOT overriding minJobCards — this is the real committed
  // inventory's default (1), the exact shape that used to route an
  // ordinary empty tail page through harvestCards' minJobCards throw and
  // the outer catch's SoftError-and-warn path.
  const paged = pagedInventory(inv, { maxPages: '5' });
  const script = newScript();
  const baseUrl = 'https://www.linkedin.com/jobs/search/?keywords=End+Of+Results';
  const page2Url = buildPageUrl(baseUrl, 2, 'start', 25);
  const page3Url = buildPageUrl(baseUrl, 3, 'start', 25);

  script.harvestByUrl.set(baseUrl, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/8101/',
    },
  ]);
  script.harvestByUrl.set(page2Url, []);
  script.harvestByUrl.set(page3Url, [
    {
      title: 'Should Not Fetch',
      company: 'Nope',
      location: 'Remote',
      href: '/jobs/view/8103/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/8101/', 'JD text — 8101');

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: Array<{ msg: string; data?: unknown }> = [];
  const infos: Array<{ msg: string; data?: unknown }> = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn: (msg, data) => warnings.push({ msg, data }),
      info: (msg, data) => infos.push({ msg, data }),
    },
  });

  const lane = new LinkedInLane(
    provider,
    [paged],
    [{ page: paged.page, urls: [baseUrl] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  // Page 1's capture survives, page 3 is never fetched.
  assert.deepEqual(
    jobs.map((jd) => jd.identity.id),
    ['li-8101'],
  );
  const listingGotoCalls = (provider.handle?.pages[0]?.gotoCalls ?? []).filter(
    (u) => u === baseUrl || u === page2Url || u === page3Url,
  );
  assert.deepEqual(listingGotoCalls, [baseUrl, page2Url]);

  // No pagination/harvest-failure warn — this is the whole point of the
  // fix: an ordinary end-of-results tail page must not be logged as a
  // failure. (The "no Notion cache found" warn is unrelated noise from
  // this FakeStorage not seeding cache/entries.json — filtered out here.)
  const relevantWarnings = warnings.filter(
    (w) =>
      w.msg !==
      'linkedin lane: no Notion cache found — cache gate disabled, known jobs may reach the LLM stage',
  );
  assert.deepEqual(relevantWarnings, []);
  // The quiet-stop path logs at info level instead.
  const endOfResultsLog = infos.find(
    (i) => i.msg === 'linkedin lane: end of results — stopping pagination',
  ) as { data: { url: string; page: number } } | undefined;
  assert.ok(endOfResultsLog);
  assert.equal(endOfResultsLog.data.url, baseUrl);
  assert.equal(endOfResultsLog.data.page, 2);

  // The url still succeeded and was marked done — no SoftError, no
  // dropped/failure evidence recorded for it.
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.ok(Object.hasOwn(persisted.done, baseUrl));
});

test('pagination: a page 2 whose container/mustExist selector matches nothing at all is the same quiet stop as a harvested-empty page', async () => {
  const inv = await realInventory();
  const paged = pagedInventory(inv, { maxPages: '5' });
  const script = newScript();
  const baseUrl = 'https://www.linkedin.com/jobs/search/?keywords=No+Container';
  const page2Url = buildPageUrl(baseUrl, 2, 'start', 25);
  const page3Url = buildPageUrl(baseUrl, 3, 'start', 25);

  script.harvestByUrl.set(baseUrl, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/8201/',
    },
  ]);
  // Page 2's readiness selector never attaches at all (container missing
  // entirely) — no harvestByUrl entry is even needed for page2Url since
  // harvestCards returns before ever reaching the in-page read.
  script.waitForThrows.add(page2Url);
  script.harvestByUrl.set(page3Url, [
    {
      title: 'Should Not Fetch',
      company: 'Nope',
      location: 'Remote',
      href: '/jobs/view/8203/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/8201/', 'JD text — 8201');

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: Array<{ msg: string; data?: unknown }> = [];
  const ctx = fakeCtx({
    logger: { ...noopLogger, warn: (msg, data) => warnings.push({ msg, data }) },
  });

  const lane = new LinkedInLane(
    provider,
    [paged],
    [{ page: paged.page, urls: [baseUrl] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  assert.deepEqual(
    jobs.map((jd) => jd.identity.id),
    ['li-8201'],
  );
  const listingGotoCalls = (provider.handle?.pages[0]?.gotoCalls ?? []).filter(
    (u) => u === baseUrl || u === page2Url || u === page3Url,
  );
  assert.deepEqual(listingGotoCalls, [baseUrl, page2Url]);
  // No pagination/harvest-failure warn (the "no Notion cache found" warn is
  // unrelated noise from this FakeStorage not seeding cache/entries.json).
  const relevantWarnings = warnings.filter(
    (w) =>
      w.msg !==
      'linkedin lane: no Notion cache found — cache gate disabled, known jobs may reach the LLM stage',
  );
  assert.deepEqual(relevantWarnings, []);

  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.ok(Object.hasOwn(persisted.done, baseUrl));
});

test('pagination: stop-on-repeat — page 2 harvests the identical card set as page 1 (LinkedIn repeating its last page), the loop stops without double-processing', async () => {
  const inv = await realInventory();
  const paged = pagedInventory(inv, { maxPages: '5' });
  const script = newScript();
  const baseUrl = 'https://www.linkedin.com/jobs/search/?keywords=Stop+Repeat';
  const page2Url = buildPageUrl(baseUrl, 2, 'start', 25);
  const page3Url = buildPageUrl(baseUrl, 3, 'start', 25);

  const repeatedCard = {
    title: 'Frontend Engineer',
    company: 'Acme',
    location: 'Remote',
    href: '/jobs/view/9001/',
  };
  script.harvestByUrl.set(baseUrl, [repeatedCard]);
  script.harvestByUrl.set(page2Url, [repeatedCard]);
  script.harvestByUrl.set(page3Url, [
    {
      title: 'Should Not Fetch',
      company: 'Nope',
      location: 'Remote',
      href: '/jobs/view/9003/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/9001/', 'JD text — 9001');

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  const lane = new LinkedInLane(
    provider,
    [paged],
    [{ page: paged.page, urls: [baseUrl] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(fakeCtx());

  // Captured once (page 1) — page 2's repeat hits the run-dedup set, not a
  // second capture, and stops the loop before page 3.
  assert.deepEqual(
    jobs.map((jd) => jd.identity.id),
    ['li-9001'],
  );
  const listingGotoCalls = (provider.handle?.pages[0]?.gotoCalls ?? []).filter(
    (u) => u === baseUrl || u === page2Url || u === page3Url,
  );
  assert.deepEqual(listingGotoCalls, [baseUrl, page2Url]);
});

test('pagination: stop-on-cap — maxCardsPerUrl reached on page 1 means page 2 is never fetched', async () => {
  const inv = await realInventory();
  const paged = pagedInventory(inv, { maxPages: '5' });
  const script = newScript();
  const baseUrl = 'https://www.linkedin.com/jobs/search/?keywords=Stop+Cap';
  const page2Url = buildPageUrl(baseUrl, 2, 'start', 25);
  const hrefs = ['9101', '9102', '9103'];
  script.harvestByUrl.set(
    baseUrl,
    hrefs.map((id) => ({
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: `/jobs/view/${id}/`,
    })),
  );
  for (const id of hrefs) {
    script.jdTextByUrl.set(
      `https://www.linkedin.com/jobs/view/${id}/`,
      `JD text — ${id}`,
    );
  }
  script.harvestByUrl.set(page2Url, [
    {
      title: 'Should Not Fetch',
      company: 'Nope',
      location: 'Remote',
      href: '/jobs/view/9104/',
    },
  ]);

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  const lane = new LinkedInLane(
    provider,
    [paged],
    [{ page: paged.page, urls: [baseUrl] }],
    fixtureFilterConfig(),
    storage,
    2, // maxCardsPerUrl
  );

  const { jobs } = await lane.source(fakeCtx());

  assert.equal(jobs.length, 2);
  const listingGotoCalls = (provider.handle?.pages[0]?.gotoCalls ?? []).filter(
    (u) => u === baseUrl || u === page2Url,
  );
  assert.deepEqual(listingGotoCalls, [baseUrl]);
});

test('pagination: an inventory with no pagination behaviors fetches exactly one page per url (backward compat)', async () => {
  const inv = await realInventory();
  const noPagination = pagedInventory(inv, {});
  noPagination.behaviors = {};
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  const lane = new LinkedInLane(
    provider,
    [noPagination],
    [{ page: noPagination.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(fakeCtx());

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1001', 'li-1003', 'li-2001', 'li-2002']);
  // Exactly one listing-page navigation per url — the rest of each page's
  // gotoCalls are its cards' JD opens (same PageHandle, reused), not
  // further pagination.
  for (const page of provider.handle?.pages ?? []) {
    const listingGotoCalls = page.gotoCalls.filter((u) => u === URL_1 || u === URL_2);
    assert.equal(listingGotoCalls.length, 1);
  }
});

test('pagination: a page-2 navigation failure records a SoftError and stops paginating that url, but keeps page-1 captures and does not fail the whole url', async () => {
  const inv = await realInventory();
  const paged = pagedInventory(inv, { maxPages: '5' });
  const script = newScript();
  const baseUrl = 'https://www.linkedin.com/jobs/search/?keywords=Page+2+Fails';
  const page2Url = buildPageUrl(baseUrl, 2, 'start', 25);
  script.harvestByUrl.set(baseUrl, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/9201/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/9201/', 'JD text — 9201');
  script.gotoThrows.add(page2Url);

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: Array<{ msg: string; data?: unknown }> = [];
  const ctx = fakeCtx({
    logger: { ...noopLogger, warn: (msg, data) => warnings.push({ msg, data }) },
  });

  const lane = new LinkedInLane(
    provider,
    [paged],
    [{ page: paged.page, urls: [baseUrl] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  // Page 1's capture survives even though page 2 failed.
  assert.deepEqual(
    jobs.map((jd) => jd.identity.id),
    ['li-9201'],
  );

  const pageFailWarning = warnings.find(
    (w) =>
      w.msg ===
      'linkedin lane: pagination page failed — stopping pagination for this url, keeping earlier captures',
  ) as { data: { page: number; message: string } } | undefined;
  assert.ok(pageFailWarning);
  assert.equal(pageFailWarning.data.page, 2);
  assert.match(pageFailWarning.data.message, /goto failed/);

  // A page-2+ soft failure does not fail the whole url retroactively
  // (page 1 succeeded) — the url is still marked done.
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.ok(Object.hasOwn(persisted.done, baseUrl));
});
