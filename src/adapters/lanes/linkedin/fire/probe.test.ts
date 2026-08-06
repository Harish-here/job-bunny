import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinkedinBreakerConfig } from '../breaker_store.ts';
import { linkedinBreakerPath } from '../breaker_store.ts';
import { CaptureStore } from '../capture_store.ts';
import type { UrlStat } from '../evidence.ts';
import {
  BREAKER_DIR,
  FakeBrowserProvider,
  FakeStateStore,
  fakeBreakerFs,
  fakeCtx,
  fixtureFilterConfig,
  NOW,
  newScript,
  OPENED_LONG_AGO,
  seedTrivialUrl,
  singlePageInventory,
  URL_1,
  URL_2,
  URL_3,
} from '../testkit/index.ts';
import { runHalfOpenProbe, runProbe } from './probe.ts';

// These exercise runProbe/runHalfOpenProbe directly rather than through the
// full LinkedInLane — this is the module the pacing/no-candidate/max-urls
// behaviors actually live in, and the lane-level breaker scenarios (trip,
// corrupt state, etc.) already have their own suite in lane_breaker.test.ts.

test('probe finds its candidate on a later url when the first is barren — breaker file unlinked, fire not skipped', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1's only card fails the company gate (fixtureFilterConfig avoids
  // "Bad Co") — barren, not proof of anything. URL_2's card passes and
  // opens with real text.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/8001/',
    },
  ]);
  seedTrivialUrl(script, URL_2, '8002');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const stateStore = new FakeStateStore();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);
  const breaker: LinkedinBreakerConfig = { userDataDir: BREAKER_DIR, deps: fs.deps };
  const captureStore = await CaptureStore.load(stateStore);
  const processedIds = new Set<string>();
  const stats: UrlStat[] = [];

  const result = await runHalfOpenProbe(
    breaker,
    OPENED_LONG_AGO,
    {
      urls: [{ page: inv.page, urls: [URL_1, URL_2] }],
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
    },
    handle,
    { captureStore, stateStore, processedIds, stats },
    fakeCtx(),
  );

  assert.equal(result.skipped, undefined, 'the fire must not be skipped on recovery');
  assert.deepEqual(fs.unlinks, [linkedinBreakerPath(BREAKER_DIR)]);
  assert.equal(fs.current(), undefined, 'breaker file must be deleted on recovery');
  assert.equal(processedIds.size, 1);
  assert.equal(stats.length, 1);
  assert.equal(captureStore.all().length, 1);
});

test('probe stops after PROBE_MAX_URLS targets rather than walking the whole list', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  const THIRD_URL = URL_3;
  const FOURTH_URL =
    'https://www.linkedin.com/jobs/search/?keywords=Fourth+Frontend+Engineer&f_TPR=r86400&sortBy=R';
  const urls = [URL_1, URL_2, THIRD_URL, FOURTH_URL];
  // Every url harvests fine but gates out its only card — none is a
  // candidate, so the probe would walk the whole list if not capped.
  urls.forEach((url, i) => {
    script.harvestByUrl.set(url, [
      {
        title: 'Frontend Engineer',
        company: 'Bad Co',
        location: 'Remote',
        href: `/jobs/view/91${i}/`,
      },
    ]);
  });
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();

  const result = await runProbe(
    {
      urls: [{ page: inv.page, urls }],
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
    },
    handle,
    fakeCtx(),
  );

  assert.equal(result.result, 'no-candidate');
  assert.match(
    result.result === 'no-candidate' ? result.message : '',
    /first 3 url\(s\) tried/,
  );
  // The defining assertion: only 3 pages ever opened, never a 4th.
  assert.equal(provider.handle?.pages.length, 3);
});

test('no-candidate everywhere fails the breaker OPEN — closed (file unlinked), result.skipped undefined', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Every url's only card is company-gated out — the probe finds nothing
  // to test on either url, but that is an absence of evidence, not proof
  // of a block.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/9201/',
    },
  ]);
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/9202/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const stateStore = new FakeStateStore();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);
  const breaker: LinkedinBreakerConfig = { userDataDir: BREAKER_DIR, deps: fs.deps };
  const captureStore = await CaptureStore.load(stateStore);
  const processedIds = new Set<string>();
  const stats: UrlStat[] = [];

  const result = await runHalfOpenProbe(
    breaker,
    OPENED_LONG_AGO,
    {
      urls: [{ page: inv.page, urls: [URL_1, URL_2] }],
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
    },
    handle,
    { captureStore, stateStore, processedIds, stats },
    fakeCtx(),
  );

  // The defining assertion: no evidence must not mean a permanent block.
  // closeBreaker deletes the file — absence IS the closed state.
  assert.deepEqual(fs.unlinks, [linkedinBreakerPath(BREAKER_DIR)]);
  assert.equal(fs.current(), undefined);
  assert.equal(result.skipped, undefined);
  // No card was ever attempted — pushing a zero/zero UrlStat here would
  // dilute the all-urls-failed denominator downstream.
  assert.equal(stats.length, 0);
  assert.equal(processedIds.size, 0);
});

test('a genuine probe error still holds the breaker open: no unlink, openedAt unchanged, lastProbeAt stamped', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // The probe url's navigation fails outright — a real error, unlike
  // no-candidate, still proves nothing and must not close the breaker.
  script.gotoThrows.add(URL_1);
  seedTrivialUrl(script, URL_2, '5102');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const stateStore = new FakeStateStore();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);
  const breaker: LinkedinBreakerConfig = { userDataDir: BREAKER_DIR, deps: fs.deps };
  const captureStore = await CaptureStore.load(stateStore);
  const processedIds = new Set<string>();
  const stats: UrlStat[] = [];

  const result = await runHalfOpenProbe(
    breaker,
    OPENED_LONG_AGO,
    {
      urls: [{ page: inv.page, urls: [URL_1, URL_2] }],
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
    },
    handle,
    { captureStore, stateStore, processedIds, stats },
    fakeCtx(),
  );

  assert.match(result.skipped?.reason ?? '', /probe inconclusive:/);
  const state = fs.current();
  assert.equal(state?.openedAt, OPENED_LONG_AGO.openedAt, 'openedAt must NOT move');
  assert.equal(state?.tripCount, 1, 'an inconclusive probe is not a trip');
  assert.equal(state?.lastProbeAt, NOW.toISOString());
  assert.deepEqual(fs.unlinks, [], 'a broken page must never close the breaker');
  // A real failure is conclusive enough to stop the walk immediately —
  // unlike a barren url it must not try the next target.
  assert.equal(provider.handle?.pages.length, 1);
});

test('the probe paces the pause between its own targets, never before the first', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1's only card fails the company gate — barren, so the probe must
  // walk on to URL_2, and that walk must be paced like any other
  // navigation right after a 4-hour cooldown.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/8101/',
    },
  ]);
  seedTrivialUrl(script, URL_2, '8102');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  let pauseCalls = 0;

  const result = await runProbe(
    {
      urls: [{ page: inv.page, urls: [URL_1, URL_2] }],
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
      interUrlPause: async () => {
        pauseCalls += 1;
      },
    },
    handle,
    fakeCtx(),
  );

  assert.equal(result.result, 'ok');
  // Exactly one pause for two targets — never before the first.
  assert.equal(pauseCalls, 1);
});
