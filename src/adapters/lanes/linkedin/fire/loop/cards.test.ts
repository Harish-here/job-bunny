import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageHandle } from '../../../../../ports/browser.ts';
import type { RunContext } from '../../../../../ports/context.ts';
import type { CaptureStore } from '../../capture_store.ts';
import type { UrlStat } from '../../evidence.ts';
import type { HarvestedCard } from '../../harvest.ts';
import type { Inventory } from '../../inventory.ts';
import type { ResumeState } from '../../resume_state.ts';
import { fakeCtx } from '../../testkit/fixtures.ts';
import { processCard } from './cards.ts';
import type { UrlRunnerDeps, UrlRunnerState } from './url_runner.ts';

/** Only the fields `processCard`'s early-return paths (cache-hit,
 * cross-url dedup, cap) actually touch are real; everything else is a
 * type-satisfying stub that a passing test must never invoke. */
function fakeDeps(overrides: Partial<UrlRunnerDeps> = {}): UrlRunnerDeps {
  return {
    browserHandle: {} as UrlRunnerDeps['browserHandle'],
    inventories: [],
    filterCfg: {} as UrlRunnerDeps['filterCfg'],
    storage: {} as UrlRunnerDeps['storage'],
    maxCardsPerUrl: 10,
    jitter: async () => {},
    interUrlPause: async () => {},
    cacheIds: new Set(),
    breaker: undefined,
    breakerState: undefined,
    ...overrides,
  };
}

function fakeState(overrides: Partial<UrlRunnerState> = {}): UrlRunnerState {
  return {
    stats: [],
    dropped: [],
    companiesSeen: new Set(),
    captureStore: {} as CaptureStore,
    resumeState: {} as ResumeState,
    throttle: undefined,
    processedIds: new Set(),
    attemptedAnyUrl: false,
    throttleTripped: false,
    shellJdFailures: 0,
    ...overrides,
  };
}

function fakeStat(): UrlStat {
  return {
    url: 'https://example.com/url',
    cardsAttempted: 0,
    captured: 0,
    anchorExtractions: 0,
    failed: false,
    failures: [],
  };
}

function fakeCard(id: string): HarvestedCard {
  return {
    id,
    url: `https://www.linkedin.com/jobs/view/${id}/`,
    title: 'Frontend Engineer',
    company: 'Acme',
    location: 'Remote',
  };
}

test('processCard ticks beat() for a cache-hit card before the cache check returns', async () => {
  const beats: string[] = [];
  const ctx: RunContext = fakeCtx({ beat: () => beats.push('beat') });
  const card = fakeCard('1001');
  const deps = fakeDeps({ cacheIds: new Set([card.id]) });
  const state = fakeState();

  await processCard(
    card,
    {} as PageHandle,
    {} as Inventory,
    'https://example.com/url',
    fakeStat(),
    { capLogged: false },
    state,
    deps,
    ctx,
  );

  assert.deepEqual(beats, ['beat'], 'a cache-hit card must still tick beat() once');
  assert.equal(
    state.processedIds.has(card.id),
    false,
    'cache hits never join processedIds',
  );
});

test('processCard ticks beat() for a cross-url-dedup card before the dedup check returns', async () => {
  const beats: string[] = [];
  const ctx: RunContext = fakeCtx({ beat: () => beats.push('beat') });
  const card = fakeCard('2002');
  const deps = fakeDeps();
  const state = fakeState({ processedIds: new Set([card.id]) });

  await processCard(
    card,
    {} as PageHandle,
    {} as Inventory,
    'https://example.com/url',
    fakeStat(),
    { capLogged: false },
    state,
    deps,
    ctx,
  );

  assert.deepEqual(beats, ['beat'], 'a duplicate card must still tick beat() once');
});

test('processCard ticks beat() exactly once for a cap-hit card', async () => {
  const beats: string[] = [];
  const ctx: RunContext = fakeCtx({ beat: () => beats.push('beat') });
  const card = fakeCard('3003');
  const deps = fakeDeps({ maxCardsPerUrl: 0 });
  const state = fakeState();
  const stat = fakeStat();
  stat.cardsAttempted = 0;

  await processCard(
    card,
    {} as PageHandle,
    {} as Inventory,
    'https://example.com/url',
    stat,
    { capLogged: false },
    state,
    deps,
    ctx,
  );

  assert.deepEqual(beats, ['beat'], 'a cap-hit card must still tick beat() exactly once');
  assert.equal(state.dropped.length, 1, 'a cap-hit card is recorded as dropped');
});

test('processCard ticks beat() exactly once for a fresh card that reaches the JD open (not twice)', async () => {
  const beats: string[] = [];
  const ctx: RunContext = fakeCtx({ beat: () => beats.push('beat') });
  const card = fakeCard('4004');
  const deps = fakeDeps({
    jitter: async () => {
      throw new Error('boom before jitter'); // stop right after the beat, before any real openJd/page use
    },
  });
  const state = fakeState();

  await processCard(
    card,
    {} as PageHandle,
    {} as Inventory,
    'https://example.com/url',
    fakeStat(),
    { capLogged: false },
    state,
    deps,
    ctx,
  );

  assert.deepEqual(
    beats,
    ['beat'],
    'beat() must fire exactly once per card, not once per checkpoint',
  );
});
