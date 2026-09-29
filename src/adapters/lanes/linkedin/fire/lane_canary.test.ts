import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkedInLane } from '../lane.ts';
import { RESUME_STATE_PATH } from '../resume_state.ts';
import {
  BREAKER_DIR,
  FakeBrowserProvider,
  FakeStateStore,
  fakeBreakerFs,
  fakeCtx,
  fixtureFilterConfig,
  NOW,
  newScript,
  seedTrivialUrl,
  singlePageInventory,
  spySleepFn,
  URL_1,
  URL_2,
} from '../testkit/index.ts';

// Wiring tests for lane.ts's source() calling evaluateAllFailedCanary
// (AC9/AC10). fire/canary.test.ts already exhaustively covers
// runCanaryProbe/evaluateAllFailedCanary's own branching in isolation; these
// mirror lane_breaker.test.ts's precedent and exercise the full LinkedInLane
// end to end, proving the wiring itself — hoist, pre-`finally` call, guard,
// return shape — behaves as the contract specifies.

const today = () => new Date().toISOString().slice(0, 10);

test('(a) leftovers all fail but the canary confirms the session healthy: source() does not throw, and linkSoftErrors names every failed url', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1 is this fire's only attempted url, and it fails outright.
  script.gotoThrows.add(URL_1);
  // URL_2 is already done today (an earlier fire captured it) — the
  // canary's candidate — and probes healthy.
  seedTrivialUrl(script, URL_2, '9401');
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  stateStore.set(RESUME_STATE_PATH, { date: today(), done: { [URL_2]: 1 } });
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
  );

  const result = await lane.source(ctx);

  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.linkSoftErrors, [
    { url: URL_1, reason: `goto failed for ${URL_1}` },
  ]);
  // Two pages this fire: URL_1's failed attempt, plus one extra
  // navigation for the canary's probe of URL_2 (URL_2 itself is skipped
  // by the main loop — it's already marked done today, so it costs
  // nothing there).
  assert.equal(provider.handle?.pages.length, 2);
});

test('(b) leftovers all fail and the canary itself comes back a shell: the existing throw stays, message unchanged', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.gotoThrows.add(URL_1);
  // The canary's own probe target (URL_2, done earlier today) harvests a
  // card fine but its JD is a server-withheld shell — 'unconfirmed', not
  // proof of health.
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/9402/',
    },
  ]);
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/9402/');
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  stateStore.set(RESUME_STATE_PATH, { date: today(), done: { [URL_2]: 1 } });
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
  );

  await assert.rejects(
    () => lane.source(ctx),
    /all 1 attempted url\(s\) failed this run/,
  );
  // The canary DID run (one extra navigation against URL_2) — it just
  // didn't confirm the session healthy.
  assert.equal(provider.handle?.pages.length, 2);
});

test('(c) first slot of the day (no resume-state doc persisted at all): pickCanaryUrl finds nothing, the canary is never attempted, and the existing throw stays', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  // Nothing at RESUME_STATE_PATH at all — the very first slot of the day.
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    stateStore,
  );

  await assert.rejects(
    () => lane.source(ctx),
    /all 1 attempted url\(s\) failed this run/,
  );
  // Zero extra navigations: the canary never reaches runProbe.
  assert.equal(provider.handle?.pages.length, 1);
});

test('(d) later slot, nothing has ever succeeded today (resume-state doc exists but done is empty): same as the first-slot case', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  // A doc exists for today (an earlier slot already ran) but nothing in
  // it ever succeeded.
  stateStore.set(RESUME_STATE_PATH, { date: today(), done: {} });
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    stateStore,
  );

  await assert.rejects(
    () => lane.source(ctx),
    /all 1 attempted url\(s\) failed this run/,
  );
  assert.equal(provider.handle?.pages.length, 1);
});

test('(e) a done-today candidate exists, but this same fire already saw shell failures: runCanaryProbe short-circuits to unconfirmed without probing, and the existing throw stays', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/9403/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/9404/',
    },
  ]);
  // Two shells — below the 3-consecutive trip threshold, so the breaker
  // stays closed, but state.shellJdFailures is already > 0 from THIS
  // fire's own earlier card processing.
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/9403/');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/9404/');
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  // URL_2 is a done-today candidate — pickCanaryUrl WOULD find it if asked.
  stateStore.set(RESUME_STATE_PATH, { date: today(), done: { [URL_2]: 1 } });
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
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

  await assert.rejects(
    () => lane.source(fakeCtx()),
    /all 1 attempted url\(s\) failed this run/,
  );
  // Only URL_1's own single page (both its cards reuse it) was ever
  // opened — no extra navigation for the canary: URL_2 was skipped as
  // already-done and never probed either.
  assert.equal(provider.handle?.pages.length, 1);
});
