import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinkedinBreakerDeps } from './breaker_store.ts';
import { LinkedInLane } from './lane.ts';
import { RESUME_STATE_PATH } from './resume_state.ts';
import {
  BREAKER_DIR,
  FakeBrowserProvider,
  FakeStorage,
  fakeBreakerFs,
  fakeCtx,
  fixtureFilterConfig,
  NOW,
  newScript,
  noopLogger,
  OPENED_LONG_AGO,
  OPENED_RECENTLY,
  seedHappyPathScript,
  seedTrivialUrl,
  singlePageInventory,
  spySleepFn,
  URL_1,
  URL_2,
} from './testkit/index.ts';

test('open breaker: the lane returns skipped with a reopen time and NEVER launches the browser (D9)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_RECENTLY, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
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

  assert.deepEqual(result.jobs, []);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.companiesSeen, []);
  assert.match(result.skipped?.reason ?? '', /throttle cooldown until/);
  // openedAt 11:00 + 4h cooldown = 15:00.
  assert.match(result.skipped?.reason ?? '', /2026-07-28T15:00:00\.000Z/);
  // The defining assertion of D9: a blocked fire leaves zero footprint.
  assert.equal(provider.handle, null);
  // And it changed nothing on "disk".
  assert.deepEqual(fs.writes, []);
  assert.deepEqual(fs.unlinks, []);
});

test('corrupt breaker state: the lane warns that the guard is disabled this fire and farms normally (spec §5 row 1)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);
  // A file that exists but holds garbage — the case that used to disable
  // the whole guard with nothing in the log to show for it.
  const deps: LinkedinBreakerDeps = {
    ...fs.deps,
    existsSync: () => true,
    readFileSync: () => '{not json',
  };
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
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps },
  );

  const result = await lane.source(ctx);

  const warned = warnings.find((w) =>
    (w as { msg: string }).msg.includes('breaker state unreadable'),
  ) as { data: { detail: string } } | undefined;
  assert.ok(warned, 'a silently-disabled guard must announce itself');
  assert.match(warned.data.detail, /jobbunny-linkedin-breaker\.json/);
  // Unreadable reads as CLOSED, never as blocked (D12): the fire runs in
  // full rather than being skipped by a file nobody can parse.
  assert.equal(result.skipped, undefined);
  assert.equal(result.jobs.length, 4);
});

test('half-open: a probe returning real text deletes the breaker file and the fire proceeds normally', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
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

  assert.equal(result.skipped, undefined);
  assert.equal(fs.current(), undefined, 'breaker file must be deleted on recovery');
  assert.equal(fs.unlinks.length, 1);
  // The whole fire ran: the happy-path fixture's 4 JD-opens all landed.
  assert.equal(result.jobs.length, 4);
});

test('half-open: after a successful probe the first main-loop url is paced like any other (the probe already spent a request on it)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0, // jitter off, so sleepCalls records inter-url pauses only
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.equal(result.skipped, undefined);
  // Three navigations happen this fire — probe(URL_1), URL_1, URL_2 — but
  // the probe only ever visits its one target here (URL_1 succeeds
  // immediately), so runProbe's own inter-target pause never fires; a
  // pause must still precede BOTH main-loop urls. Without the probe
  // marking the fire as started, URL_1 would follow the probe's own
  // request to the same url instantly, which is the one moment (recovery
  // from a block) that burst looks worst.
  assert.equal(sleepCalls.length, 2);
  for (const ms of sleepCalls) {
    assert.equal(ms, 20_000 + Math.floor(0.5 * (45_000 - 20_000)));
  }
});

test('half-open: a probe returning a shell re-opens the breaker and ends the fire after ONE JD-open', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1's single card harvests fine, but its JD is a shell: no text
  // scripted, and jdRoot IS present.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/5001/',
    },
  ]);
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/5001/');
  seedTrivialUrl(script, URL_2, '5002');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
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

  assert.match(result.skipped?.reason ?? '', /still throttled/);
  assert.deepEqual(result.jobs, []);
  const state = fs.current();
  assert.equal(state?.openedAt, NOW.toISOString(), 'openedAt must be rewritten');
  assert.equal(state?.tripCount, 2);
  // ~2 requests spent: exactly one page was opened, and URL_2 was never
  // visited.
  assert.equal(provider.handle?.pages.length, 1);
  const gotos = provider.handle?.pages[0]?.gotoCalls ?? [];
  assert.equal(gotos.includes(URL_2), false);
});

test('half-open: a probe that THROWS leaves the breaker open with openedAt unchanged (spec §5)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // The probe url's navigation fails outright — a real error, unlike
  // no-candidate, still proves nothing and must not close the breaker.
  // The fail-open path (no-candidate) must not leak into this genuine
  // failure: a broken page is conclusive enough to hold the breaker open,
  // not the absence-of-evidence case that closes it.
  script.gotoThrows.add(URL_1);
  seedTrivialUrl(script, URL_2, '5102');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
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

  assert.match(result.skipped?.reason ?? '', /probe inconclusive/);
  const state = fs.current();
  assert.equal(state?.openedAt, OPENED_LONG_AGO.openedAt, 'openedAt must NOT move');
  assert.equal(state?.tripCount, 1, 'an inconclusive probe is not a trip');
  assert.equal(state?.lastProbeAt, NOW.toISOString());
  assert.deepEqual(fs.unlinks, [], 'a broken page must never close the breaker');
});

test('trip: 3 consecutive shells mid-fire open the breaker, stop the remaining urls, and KEEP prior captures (D6)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1: card 1 captures real text, cards 2-4 are shells. The third
  // shell trips the counter.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/6001/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/6002/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/6003/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Umbrella',
      location: 'Remote',
      href: '/jobs/view/6004/',
    },
  ]);
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/6001/',
    'JD text — real, captured before the block',
  );
  for (const id of ['6002', '6003', '6004']) {
    script.jdShellUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '6100');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  // No file on disk ⇒ phase closed ⇒ the fire starts normally.
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
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

  // Returns NORMALLY — it did attempt work (D6), so this is not `skipped`.
  assert.equal(result.skipped, undefined);
  assert.deepEqual(
    result.jobs.map((j) => j.identity.id),
    ['li-6001'],
  );
  const state = fs.current();
  assert.equal(state?.openedAt, NOW.toISOString());
  assert.equal(state?.tripCount, 1);
  // URL_2 was never visited: only ONE page was ever opened.
  assert.equal(provider.handle?.pages.length, 1);
  // The interrupted url is NOT marked done — the next fire must retry it.
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.equal(Object.hasOwn(persisted.done, URL_1), false);
});

test('trip: a fire that trips before capturing anything still writes the breaker, and the pre-existing all-urls-failed guard still throws (spec §4.5 step 6)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Every card on URL_1 is a shell: the counter trips on card 3 with zero
  // captures to keep.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/6701/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/6702/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/6703/',
    },
  ]);
  for (const id of ['6701', '6702', '6703']) {
    script.jdShellUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '6800');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  // Pinned deliberately rather than left unknown: with nothing captured,
  // the trip leaves the fire in exactly the shape the pre-existing
  // all-urls-failed guard is built to shout about, and spec §4.5 step 6
  // keeps those rules applying unchanged. So this run DOES fail loud — the
  // throttle guard changes what the next fire does, not whether this one
  // reports an outage it genuinely had.
  await assert.rejects(() => lane.source(fakeCtx()), /all 1 attempted url\(s\) failed/);

  // The breaker must have been written BEFORE that throw — otherwise the
  // next fire would relearn the block the expensive way instead of
  // skipping cheaply, which is the entire point of the guard.
  const state = fs.current();
  assert.equal(state?.openedAt, NOW.toISOString());
  assert.equal(state?.tripCount, 1);
  // And it stopped early all the same: URL_2 was never opened.
  assert.equal(provider.handle?.pages.length, 1);
});

test('trip: an ok between shells resets the streak — a mostly-healthy fire never trips', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/6201/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/6202/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/6203/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Umbrella',
      location: 'Remote',
      href: '/jobs/view/6204/',
    },
  ]);
  // shell, shell, ok, shell -> longest streak 2, never trips.
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6201/');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6202/');
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/6203/', 'JD text — healthy');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6204/');
  seedTrivialUrl(script, URL_2, '6300');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
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

  assert.equal(fs.current(), undefined, 'breaker must stay closed');
  // Both urls were visited: 2 pages opened, and URL_2's job landed.
  assert.equal(provider.handle?.pages.length, 2);
  assert.ok(result.jobs.some((j) => j.identity.id === 'li-6300'));
});

test('no breaker configured: the lane never reads or writes breaker state (every legacy call site is unaffected)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/6401/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/6402/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/6403/',
    },
  ]);
  for (const id of ['6401', '6402', '6403']) {
    script.jdShellUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '6500');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  // 13th argument omitted entirely — the pre-throttle-guard call shape.
  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const result = await lane.source(fakeCtx());

  // Three shells in a row and yet URL_2 still got visited: with no breaker
  // configured there is no counter and no early stop.
  assert.equal(result.skipped, undefined);
  assert.equal(provider.handle?.pages.length, 2);
});

test('all-urls-failed evidence: shell JD failures are reported as server-withheld content, not as an inventory problem (D13)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Two cards, both shells: jdRoot present, no text. Two is below the
  // 3-shell trip threshold, so the fire runs to completion and the
  // all-urls-failed guard produces the message under test.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/7001/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/7002/',
    },
  ]);
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/7001/');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/7002/');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  let message = '';
  await assert.rejects(
    () => lane.source(fakeCtx()),
    (err: Error) => {
      message = err.message;
      return true;
    },
  );

  assert.match(message, /server withheld the JD content/);
  assert.match(message, /rate-limit|soft-block/);
  assert.match(message, /cooldown/);
  // The defining assertion: a throttle must NOT send anyone to the page
  // inventory or /page-analyse.
  assert.doesNotMatch(message, /page_inventory/);
  assert.doesNotMatch(message, /page-analyse/);
});

test('no trip: 3 consecutive JD-open failures whose jdRoot is present AND still holds text (a stale pane) leave the breaker closed (D4)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Three cards in a row whose JD open fails while jdRoot matches an
  // element that still holds text — e.g. a goto timeout leaving the
  // PREVIOUS card's JD pane on screen. Under presence-only classification
  // these read as three shells and open a 4-hour breaker for something
  // that is not a throttle at all.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/7101/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/7102/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/7103/',
    },
  ]);
  for (const id of ['7101', '7102', '7103']) {
    script.jdStalePaneUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '7200');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
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

  assert.equal(fs.current(), undefined, 'a stale populated pane must never trip');
  assert.deepEqual(fs.writes, []);
  // The fire ran to completion: URL_2 was still visited and captured.
  assert.equal(result.skipped, undefined);
  assert.equal(provider.handle?.pages.length, 2);
  assert.ok(result.jobs.some((j) => j.identity.id === 'li-7200'));
});
