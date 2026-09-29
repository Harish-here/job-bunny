import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptureStore } from '../capture_store.ts';
import type { UrlStat } from '../evidence.ts';
import { ResumeState } from '../resume_state.ts';
import type { SearchUrlGroup } from '../search_urls.ts';
import {
  FakeBrowserProvider,
  FakeStateStore,
  fakeCtx,
  fixtureFilterConfig,
  newScript,
  seedTrivialUrl,
  singlePageInventory,
  URL_1,
  URL_2,
} from '../testkit/index.ts';
import { evaluateAllFailedCanary, runCanaryProbe } from './canary.ts';
import type { UrlRunnerState } from './loop/index.ts';

// These exercise runCanaryProbe/evaluateAllFailedCanary directly, mirroring
// probe.test.ts's own style ("never navigated" is asserted the same way
// there: via the fake browser handle's recorded `pages`, since neither
// function takes an injectable spy).

const TODAY = '2026-07-28';

async function trivialInventoryAndGroup(): Promise<{
  inv: Awaited<ReturnType<typeof singlePageInventory>>;
  urls: SearchUrlGroup[];
}> {
  const inv = await singlePageInventory();
  return { inv, urls: [{ page: inv.page, urls: [URL_1, URL_2] }] };
}

function statOf(url: string, messages: string[]): UrlStat {
  return {
    url,
    cardsAttempted: 1,
    captured: 0,
    anchorExtractions: 0,
    failed: true,
    failures: messages.map((message) => ({ kind: 'other', message })),
  };
}

async function buildState(
  overrides: Partial<UrlRunnerState> = {},
): Promise<UrlRunnerState> {
  return {
    stats: [],
    dropped: [],
    companiesSeen: new Set(),
    captureStore: await CaptureStore.load(new FakeStateStore()),
    resumeState: await ResumeState.load(new FakeStateStore(), TODAY),
    throttle: undefined,
    processedIds: new Set(),
    attemptedAnyUrl: false,
    throttleTripped: false,
    shellJdFailures: 0,
    ...overrides,
  };
}

test('runCanaryProbe: a throttle trip skips straight to unconfirmed, never probing', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '9301');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_1, 1);

  const verdict = await runCanaryProbe(
    {
      urls,
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
      interUrlPause: async () => {},
    },
    resumeState,
    { throttleTripped: true, shellJdFailures: 0 },
    handle,
    fakeCtx(),
  );

  assert.equal(verdict, 'unconfirmed');
  assert.equal(provider.handle?.pages.length, 0, 'runProbe must never be called');
});

test('runCanaryProbe: any shell this fire skips straight to unconfirmed, never probing', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '9302');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_1, 1);

  const verdict = await runCanaryProbe(
    {
      urls,
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
      interUrlPause: async () => {},
    },
    resumeState,
    { throttleTripped: false, shellJdFailures: 1 },
    handle,
    fakeCtx(),
  );

  assert.equal(verdict, 'unconfirmed');
  assert.equal(provider.handle?.pages.length, 0, 'runProbe must never be called');
});

test('runCanaryProbe: no done-today url among the candidates is not-attempted, never probing', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  // Fresh resume state: nothing marked done today.
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);

  const verdict = await runCanaryProbe(
    {
      urls,
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
      interUrlPause: async () => {},
    },
    resumeState,
    { throttleTripped: false, shellJdFailures: 0 },
    handle,
    fakeCtx(),
  );

  assert.equal(verdict, 'not-attempted');
  assert.equal(provider.handle?.pages.length, 0, 'runProbe must never be called');
});

test('runCanaryProbe: a present done-today url with an ok probe is confirmed-healthy', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '9303');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_1, 1);
  let pauseCalls = 0;

  const verdict = await runCanaryProbe(
    {
      urls,
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
      interUrlPause: async () => {
        pauseCalls += 1;
      },
    },
    resumeState,
    { throttleTripped: false, shellJdFailures: 0 },
    handle,
    fakeCtx(),
  );

  assert.equal(verdict, 'confirmed-healthy');
  assert.equal(provider.handle?.pages.length, 1, 'exactly one navigation for the probe');
  assert.equal(pauseCalls, 1, 'the canary paces itself before probing');
});

test('runCanaryProbe: a shell probe result is unconfirmed', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/9304/',
    },
  ]);
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/9304/');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_1, 1);

  const verdict = await runCanaryProbe(
    {
      urls,
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
      interUrlPause: async () => {},
    },
    resumeState,
    { throttleTripped: false, shellJdFailures: 0 },
    handle,
    fakeCtx(),
  );

  assert.equal(verdict, 'unconfirmed');
});

test('runCanaryProbe: a no-candidate probe result is unconfirmed', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  // Only card is company-gated out by fixtureFilterConfig — no candidate.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/9305/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_1, 1);

  const verdict = await runCanaryProbe(
    {
      urls,
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
      interUrlPause: async () => {},
    },
    resumeState,
    { throttleTripped: false, shellJdFailures: 0 },
    handle,
    fakeCtx(),
  );

  assert.equal(verdict, 'unconfirmed');
});

test('runCanaryProbe: an inconclusive probe result is unconfirmed', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_1, 1);

  const verdict = await runCanaryProbe(
    {
      urls,
      inventories: [inv],
      filterCfg: fixtureFilterConfig(),
      interUrlPause: async () => {},
    },
    resumeState,
    { throttleTripped: false, shellJdFailures: 0 },
    handle,
    fakeCtx(),
  );

  assert.equal(verdict, 'unconfirmed');
});

test('evaluateAllFailedCanary: zero attempted urls short-circuits, never probing', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '9306');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_1, 1);
  const state = await buildState({ stats: [], resumeState });

  const evaluation = await evaluateAllFailedCanary(
    state,
    urls,
    [inv],
    fixtureFilterConfig(),
    async () => {},
    handle,
    fakeCtx(),
  );

  assert.deepEqual(evaluation, { confirmedHealthy: false });
  assert.equal(provider.handle?.pages.length, 0, 'a cheap short-circuit never navigates');
});

test('evaluateAllFailedCanary: not-all-failed stats short-circuits, never probing', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '9307');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_1, 1);
  const state = await buildState({
    stats: [
      statOf(URL_1, ['boom']),
      {
        url: URL_2,
        cardsAttempted: 1,
        captured: 1,
        anchorExtractions: 0,
        failed: false,
        failures: [],
      },
    ],
    resumeState,
  });

  const evaluation = await evaluateAllFailedCanary(
    state,
    urls,
    [inv],
    fixtureFilterConfig(),
    async () => {},
    handle,
    fakeCtx(),
  );

  assert.deepEqual(evaluation, { confirmedHealthy: false });
  assert.equal(provider.handle?.pages.length, 0, 'a cheap short-circuit never navigates');
});

test('evaluateAllFailedCanary: all failed + confirmed-healthy names each failed url with its first failure', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  seedTrivialUrl(script, URL_2, '9308');
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  resumeState.markDone(URL_2, 1);
  const state = await buildState({
    stats: [statOf(URL_1, ['first failure for URL_1', 'second, ignored'])],
    attemptedAnyUrl: true,
    resumeState,
  });

  const evaluation = await evaluateAllFailedCanary(
    state,
    urls,
    [inv],
    fixtureFilterConfig(),
    async () => {},
    handle,
    fakeCtx(),
  );

  assert.equal(evaluation.confirmedHealthy, true);
  assert.deepEqual(evaluation.linkSoftErrors, [
    { url: URL_1, reason: 'first failure for URL_1' },
  ]);
});

test('evaluateAllFailedCanary: all failed but an unconfirmed canary keeps confirmedHealthy false', async () => {
  const { urls, inv } = await trivialInventoryAndGroup();
  const script = newScript();
  const provider = new FakeBrowserProvider(script);
  const handle = await provider.launch();
  // Nothing marked done today — the canary itself resolves 'not-attempted'.
  const resumeState = await ResumeState.load(new FakeStateStore(), TODAY);
  const state = await buildState({
    stats: [statOf(URL_1, ['boom'])],
    attemptedAnyUrl: true,
    resumeState,
  });

  const evaluation = await evaluateAllFailedCanary(
    state,
    urls,
    [inv],
    fixtureFilterConfig(),
    async () => {},
    handle,
    fakeCtx(),
  );

  assert.deepEqual(evaluation, { confirmedHealthy: false });
});
