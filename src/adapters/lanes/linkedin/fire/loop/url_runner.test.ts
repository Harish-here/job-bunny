import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FilterConfigSchema } from '../../../../../core/filter/config.ts';
import type { LogData, RunContext } from '../../../../../ports/context.ts';
import { CaptureStore } from '../../capture_store.ts';
import { ResumeState } from '../../resume_state.ts';
import type { SearchUrlGroup } from '../../search_urls.ts';
import {
  FakeBrowserHandle,
  FakeStateStore,
  fakeCtx,
  newScript,
  type RawCardFixture,
  singlePageInventory,
  URL_1,
} from '../../testkit/index.ts';
import { runUrlGroups, type UrlRunnerDeps, type UrlRunnerState } from './url_runner.ts';

/** A `title.domain` match rule (hard severity, the schema default) is the
 * cheapest way to make the card gate actually drop something: with no
 * `title` config at all, `titleRule.evalCard` returns no verdicts for any
 * card — including an empty-title one — so it would sail through to
 * `pass` rather than ever reaching gateCards' identity-invalid path. */
function titleMatchFilterConfig() {
  return FilterConfigSchema.parse({ title: { domain: { match: ['Engineer'] } } });
}

/** Matches `titleMatchFilterConfig`'s `match: ['Engineer']` — sails
 * through the card gate untouched. */
function validRawCard(id: string): RawCardFixture {
  return {
    title: 'Frontend Engineer',
    company: 'Acme',
    location: 'Remote',
    href: `/jobs/view/${id}/`,
  };
}

/** Empty title AND company: fails the title-match rule (drop), then
 * `gateCards`' identity JD build throws (JDSchema requires both min 1),
 * which is exactly what increments `identityInvalidCount`. */
function invalidRawCard(id: string): RawCardFixture {
  return { title: '', company: '', location: '', href: `/jobs/view/${id}/` };
}

interface LogCall {
  level: 'info' | 'warn';
  msg: string;
  data: LogData | undefined;
}

function capturingCtx(): { ctx: RunContext; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const ctx = fakeCtx({
    logger: {
      debug() {},
      info(msg, data) {
        calls.push({ level: 'info', msg, data });
      },
      warn(msg, data) {
        calls.push({ level: 'warn', msg, data });
      },
      error() {},
    },
  });
  return { ctx, calls };
}

/** Builds a runUrlGroups call over a single url/single page, with every
 * "pass" card wired as a cache-hit (deps.cacheIds) so processCard
 * short-circuits before touching the page/JD-open machinery at all — this
 * suite is only about the harvest/gate telemetry, not JD capture. */
async function runOnePage(cards: RawCardFixture[], validIds: string[]) {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, cards);
  const { ctx, calls } = capturingCtx();

  const state: UrlRunnerState = {
    stats: [],
    dropped: [],
    companiesSeen: new Set(),
    captureStore: await CaptureStore.load(new FakeStateStore()),
    resumeState: await ResumeState.load(new FakeStateStore(), '2026-08-09'),
    throttle: undefined,
    processedIds: new Set(),
    attemptedAnyUrl: false,
    throttleTripped: false,
    shellJdFailures: 0,
  };
  const deps: UrlRunnerDeps = {
    browserHandle: new FakeBrowserHandle(script),
    inventories: [inv],
    filterCfg: titleMatchFilterConfig(),
    stateStore: new FakeStateStore(),
    maxCardsPerUrl: 40,
    jitter: async () => {},
    interUrlPause: async () => {},
    cacheIds: new Set(validIds),
    breaker: undefined,
    breakerState: undefined,
  };
  const urls: SearchUrlGroup[] = [{ page: inv.page, urls: [URL_1] }];

  await runUrlGroups(urls, state, deps, ctx);
  return { calls, stat: state.stats[0] };
}

test('identityInvalid rides the page-harvested event: a page whose cards all gate cleanly logs identityInvalid: 0', async () => {
  const ids = ['9001', '9002', '9003'];
  const { calls } = await runOnePage(
    ids.map(validRawCard),
    ids.map((id) => `li-${id}`),
  );

  const harvested = calls.find(
    (c) => c.level === 'info' && c.msg === 'linkedin lane: page harvested',
  );
  assert.ok(harvested, 'page harvested event must be logged');
  assert.deepEqual(harvested?.data, {
    url: URL_1,
    page: 1,
    harvested: 3,
    gated: 3,
    identityInvalid: 0,
  });
});

test('a page over the threshold (5/10 = 0.5 > 0.3) warns with the right fields', async () => {
  const validIds = ['1001', '1002', '1003', '1004', '1005'];
  const invalidIds = ['2001', '2002', '2003', '2004', '2005'];
  const cards = [...validIds.map(validRawCard), ...invalidIds.map(invalidRawCard)];
  const { calls } = await runOnePage(
    cards,
    validIds.map((id) => `li-${id}`),
  );

  const loss = calls.find(
    (c) => c.level === 'warn' && c.msg === 'linkedin lane: page identity loss',
  );
  assert.ok(loss, 'identity loss warn must be logged');
  assert.deepEqual(loss?.data, {
    url: URL_1,
    page: 1,
    harvested: 10,
    identityInvalid: 5,
    fraction: 0.5,
  });
});

test('a page under the threshold (2/10 = 0.2) does not warn', async () => {
  const validIds = ['3001', '3002', '3003', '3004', '3005', '3006', '3007', '3008'];
  const invalidIds = ['4001', '4002'];
  const cards = [...validIds.map(validRawCard), ...invalidIds.map(invalidRawCard)];
  const { calls } = await runOnePage(
    cards,
    validIds.map((id) => `li-${id}`),
  );

  const loss = calls.find((c) => c.msg === 'linkedin lane: page identity loss');
  assert.equal(loss, undefined);
});

test('the threshold does not fail the url: stat.failed stays false and pagination continued past the guard', async () => {
  const validIds = ['5001', '5002', '5003', '5004', '5005'];
  const invalidIds = ['6001', '6002', '6003', '6004', '6005'];
  const cards = [...validIds.map(validRawCard), ...invalidIds.map(invalidRawCard)];
  const { calls, stat } = await runOnePage(
    cards,
    validIds.map((id) => `li-${id}`),
  );

  assert.equal(stat?.failed, false);
  // "pagination continued" — the page-harvested info event (logged after
  // the total-outage guard's break) still fired for this page.
  const harvested = calls.find((c) => c.msg === 'linkedin lane: page harvested');
  assert.ok(
    harvested,
    'a survivable partial-loss page must still be processed past the guard',
  );
});

test('a 100%-invalid page still fails loudly and does NOT warn about identity loss', async () => {
  const invalidIds = [
    '7001',
    '7002',
    '7003',
    '7004',
    '7005',
    '7006',
    '7007',
    '7008',
    '7009',
    '7010',
  ];
  const cards = invalidIds.map(invalidRawCard);
  const { calls, stat } = await runOnePage(cards, []);

  const urlFailed = calls.find(
    (c) => c.level === 'warn' && c.msg === 'linkedin lane: url failed',
  );
  assert.ok(urlFailed, 'the total-outage guard must still fail the url loudly');
  assert.equal(stat?.failed, true);

  const loss = calls.find((c) => c.msg === 'linkedin lane: page identity loss');
  assert.equal(
    loss,
    undefined,
    'a 100%-invalid page must not also warn about partial loss',
  );
});
