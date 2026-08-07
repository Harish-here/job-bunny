import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD } from '../../../core/jd/index.ts';
import { CAPTURE_PATH } from './capture_store.ts';
import { LinkedInLane } from './lane.ts';
import {
  BREAKER_DIR,
  FakeBrowserProvider,
  FakeStateStore,
  fakeBreakerFs,
  fakeCapturedJD,
  fakeCtx,
  fixtureFilterConfig,
  NOW,
  newScript,
  noopLogger,
  OPENED_LONG_AGO,
  seedTrivialUrl,
  singlePageInventory,
  spySleepFn,
  URL_1,
  URL_2,
} from './testkit/index.ts';

// ---------- cache-skip / cross-url dedup / per-url cap (Task B) ----------

test('cache-skip: a card whose id is already in the Notion cache never gets a JD open', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/1001/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/1003/',
    },
  ]);
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/1003/',
    'JD text — Globex FE',
  );
  // Deliberately no jdTextByUrl entry for 1001 — if the cache gate failed
  // to skip it, openJd would see '' and throw (empty-text SoftError),
  // which the assertions below would catch as an unexpected drop/failure.

  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  stateStore.set('cache/entries.json', [
    { id: 'li-1001', company: 'Acme', title: 'Frontend Engineer', pageId: 'page-1' },
  ]);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    stateStore,
  );

  const { jobs, dropped } = await lane.source(fakeCtx());

  assert.deepEqual(
    jobs.map((j) => j.identity.id),
    ['li-1003'],
  );
  // Cache-skip is silent, same posture as the ATS lanes' cache gate — no
  // DroppedRecord, no jdOpenFailed noise for the cached card.
  assert.equal(dropped.length, 0);
});

test('cross-url run-dedup: the same job id harvested under two different search urls is JD-opened only once', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Both urls harvest the exact same job (same href -> same id li-9001).
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/9001/',
    },
  ]);
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/9001/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/9001/', 'JD text — Acme FE');

  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
  );

  const { jobs, dropped } = await lane.source(fakeCtx());

  assert.deepEqual(
    jobs.map((j) => j.identity.id),
    ['li-9001'],
  );
  assert.equal(dropped.length, 0);
  // 2 newPage() calls, one per url — the dedup must skip the second
  // harvest's already-processed card before any per-card work (openJd)
  // happens for it, not merely dedup the final output.
  assert.equal(provider.handle?.pages.length, 2);
});

test('per-url cap: more gate-passed cards than maxCardsPerUrl for one url -> only the cap gets a JD open, cap fires loud with a DroppedRecord per truncated card', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  const hrefs = ['5001', '5002', '5003', '5004', '5005'];
  script.harvestByUrl.set(
    URL_1,
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

  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  const warnings: Array<{ msg: string; data?: unknown }> = [];
  const ctx = fakeCtx({
    logger: { ...noopLogger, warn: (msg, data) => warnings.push({ msg, data }) },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    stateStore,
    2, // maxCardsPerUrl
  );

  const { jobs, dropped } = await lane.source(ctx);

  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.identity.id).sort(), ['li-5001', 'li-5002']);

  const capDrops = dropped.filter(
    (d) => d.reasons[0]?.rule === 'linkedin.maxCardsPerUrlCap',
  );
  assert.equal(capDrops.length, 3);
  assert.deepEqual(capDrops.map((d) => d.jd.identity.id).sort(), [
    'li-5003',
    'li-5004',
    'li-5005',
  ]);

  assert.ok(warnings.some((w) => w.msg.includes('maxCardsPerUrl cap hit')));
});
test('half-open: a successful probe records its own UrlStat, so a single-url fire whose remaining cards all fail still returns the probe capture instead of throwing', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // One url, three cards: the probe opens card 1 (the only one with
  // scripted text); the main loop then attempts cards 2-3 and both fail
  // with no jdRoot at all (neutral, so nothing trips).
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/7301/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/7302/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/7303/',
    },
  ]);
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/7301/',
    'JD text — recovered by the probe',
  );
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    stateStore,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  // Without the probe's UrlStat the only stat on record is URL_1's, which
  // failed every card it attempted — so the all-urls-failed guard would
  // throw away a fire that demonstrably captured a JD.
  const result = await lane.source(fakeCtx());

  assert.equal(result.skipped, undefined);
  assert.deepEqual(
    result.jobs.map((j) => j.identity.id),
    ['li-7301'],
  );
  assert.equal(fs.current(), undefined, 'a recovered probe closes the breaker');
});

test('half-open: a probe re-opening a card an earlier same-day fire already captured does NOT append it twice', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '7401');
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  // The earlier fire's flushed capture — CaptureStore seeds itself from
  // this file, and the probe always re-opens the first card of the first
  // url, i.e. exactly this job.
  stateStore.set(CAPTURE_PATH, [fakeCapturedJD('li-7401')]);
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    stateStore,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  // Exactly once: a duplicate here costs a compress `duplicate-id` drop
  // and one wasted LLM row on every recovery.
  assert.deepEqual(
    result.jobs.map((j) => j.identity.id),
    ['li-7401'],
  );
  const persisted = stateStore.get(CAPTURE_PATH) as JD[];
  assert.equal(persisted.length, 1);
});
test('page-level heartbeat: ctx.beat() ticks once per harvested page even when every card on that page is gated out (no card ever reaches processCard)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Every card on every url is avoid-listed, so gateCards' `pass` is
  // empty for both pages — processCard (and its own per-card beat) is
  // never invoked. If the only heartbeat lived inside processCard, this
  // run would tick zero times despite two full page harvests of real,
  // ongoing work (the bug this test guards against).
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/1001/',
    },
  ]);
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Staff Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/2001/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
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
    stateStore,
  );

  const { jobs, dropped } = await lane.source(ctx);

  assert.deepEqual(jobs, []);
  assert.ok(dropped.length >= 2);
  // One page harvested per url (singlePageInventory has no pagination),
  // zero cards ever gate-passed — the page-level beat is the only
  // heartbeat source here, so it must have ticked exactly twice.
  assert.equal(beats, 2);
});

test('pacing: the constructor puts each pacing argument in its own slot (no transposition), read via a structural cast on the four private fields', async () => {
  const inv = await singlePageInventory();
  const provider = new FakeBrowserProvider(newScript());

  // Four deliberately distinct values: any swapped pair shows up here.
  const lane = new LinkedInLane(
    provider,
    [inv],
    [],
    fixtureFilterConfig(),
    new FakeStateStore(),
    undefined,
    1_001,
    2_002,
    () => 0.5,
    spySleepFn([]),
    3_003,
    4_004,
  );

  const pacing = lane as unknown as {
    jitterMinMs: number;
    jitterMaxMs: number;
    interUrlDelayMinMs: number;
    interUrlDelayMaxMs: number;
  };
  assert.deepEqual(
    {
      jitterMinMs: pacing.jitterMinMs,
      jitterMaxMs: pacing.jitterMaxMs,
      interUrlDelayMinMs: pacing.interUrlDelayMinMs,
      interUrlDelayMaxMs: pacing.interUrlDelayMaxMs,
    },
    {
      jitterMinMs: 1_001,
      jitterMaxMs: 2_002,
      interUrlDelayMinMs: 3_003,
      interUrlDelayMaxMs: 4_004,
    },
  );
});
