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
  seedHappyPathScript,
  seedTrivialUrl,
  singlePageInventory,
  spySleepFn,
  URL_1,
  URL_2,
  URL_3,
} from '../testkit/index.ts';
import { jitterMs } from './pacing.ts';

// ---------- jitter (P9 tail: v0->v2 parity regression fix) ----------

test('jitterMs: rand=0 returns exactly minMs (inclusive lower bound)', () => {
  assert.equal(
    jitterMs(2_000, 5_000, () => 0),
    2_000,
  );
});

test('jitterMs: rand=~1 returns just under maxMs (exclusive upper bound), never maxMs itself', () => {
  const result = jitterMs(2_000, 5_000, () => 0.999_999);
  assert.ok(result < 5_000);
  assert.ok(result >= 2_000);
});

test('jitterMs: rand=0.5 returns the midpoint of the range', () => {
  assert.equal(
    jitterMs(2_000, 5_000, () => 0.5),
    2_000 + Math.floor(0.5 * 3_000),
  );
});

test('jitter: applied once before every JD open (card loop) and once per attempted url (url loop), never a real multi-second wait', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined, // maxCardsPerUrl: default
    1_234, // jitterMinMs
    4_321, // jitterMaxMs
    () => 0.5, // randomFn: deterministic midpoint
    spySleepFn(sleepCalls),
  );

  const start = Date.now();
  const { jobs } = await lane.source(fakeCtx());
  const elapsedMs = Date.now() - start;

  // Happy-path fixture: 2 urls attempted (1 jitter each) + 4 cards opened
  // (1 jitter each, li-1001/1003/2001/2002 — li-1002 was gated out before
  // ever reaching the jitter/JD-open step) = 6 total.
  assert.equal(jobs.length, 4);
  assert.equal(sleepCalls.length, 6);
  for (const ms of sleepCalls) {
    assert.equal(ms, 1_234 + Math.floor(0.5 * (4_321 - 1_234)));
  }
  // The spy never actually sleeps — a real 2-5s-per-call implementation
  // would take seconds here; this must stay well under that.
  assert.ok(elapsedMs < 500, `expected a fake-sleep run to be fast, took ${elapsedMs}ms`);
});

test('jitter: a zero-length range (jitterMinMs === jitterMaxMs === 0) is a no-op — the sleepFn is never called', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

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
    spySleepFn(sleepCalls),
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 0);
});

test('jitter: an already-aborted ctx.signal makes the (real, default) jitter reject immediately — the run fails fast rather than hanging for seconds', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  // No injected sleepFn here — deliberately exercising the REAL default
  // (core/async's abort-aware sleep) to prove an already-aborted signal
  // short-circuits without ever starting its 2-5s timer. A real (nonzero)
  // jitter range is passed explicitly since the class's own default is a
  // no-op (see DEFAULT_JITTER_MIN_MS's doc comment) — production's real
  // v0-parity default lives in cli/wire.ts's resolveJitterRange instead.
  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    2_000,
    5_000,
  );

  const controller = new AbortController();
  controller.abort(new Error('run cancelled'));
  const ctx = fakeCtx({ signal: controller.signal });

  const start = Date.now();
  // Every url's first jitter call rejects immediately (aborted signal) ->
  // every attempted url fails -> aggregate all-urls-failed throw. The
  // assertion that matters is the timing: this must not take anywhere
  // near the 2-5s-per-url the real jitter range would imply if it didn't
  // honor the abort.
  await assert.rejects(() => lane.source(ctx), /all 2 attempted url\(s\) failed/);
  assert.ok(
    Date.now() - start < 1_000,
    'an aborted signal must not sit in the jitter sleep',
  );
});
// ---------- inter-url pacing (throttle guard D2, 2026-07-28) ----------

test('inter-url pause: 3 attempted urls produce exactly 2 pauses, each the configured midpoint', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3001');
  seedTrivialUrl(script, URL_2, '3002');
  seedTrivialUrl(script, URL_3, '3003');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2, URL_3] }],
    fixtureFilterConfig(),
    storage,
    undefined, // maxCardsPerUrl: default
    0, // jitterMinMs — jitter OFF, so every recorded sleep is an inter-url pause
    0, // jitterMaxMs
    () => 0.5, // randomFn: deterministic midpoint
    spySleepFn(sleepCalls),
    20_000, // interUrlDelayMinMs
    45_000, // interUrlDelayMaxMs
  );

  await lane.source(fakeCtx());

  // Never before the first url, never after the last: N - 1 pauses.
  assert.equal(sleepCalls.length, 2);
  for (const ms of sleepCalls) {
    assert.equal(ms, 20_000 + Math.floor(0.5 * (45_000 - 20_000)));
    assert.ok(ms >= 20_000 && ms < 45_000);
  }
});

test('inter-url pause: a single url produces zero pauses', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3101');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

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
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 0);
});

test('inter-url pause: a zero-length range is a no-op — the sleepFn is never called', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3201');
  seedTrivialUrl(script, URL_2, '3202');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

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
    spySleepFn(sleepCalls),
    0, // interUrlDelayMinMs
    0, // interUrlDelayMaxMs
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 0);
});

test('inter-url pause: a url skipped as already-done costs no pause — only attempted urls are paced', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3301');
  seedTrivialUrl(script, URL_2, '3302');
  seedTrivialUrl(script, URL_3, '3303');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  // The MIDDLE url was already captured by an earlier fire today, so this
  // fire attempts URL_1 and URL_3 only — 2 attempts, 1 pause between them.
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_2]: 1 } });
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2, URL_3] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 1);
});

test('inter-url pause: pauses between urls that live in DIFFERENT page groups too', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3401');
  seedTrivialUrl(script, URL_2, '3402');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    // Two groups of one url each, both resolving to the same inventory.
    [
      { page: inv.page, urls: [URL_1] },
      { page: inv.page, urls: [URL_2] },
    ],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 1);
});
