import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilterConfig } from '../../core/filter/config.ts';
import { companyKey } from '../../core/jd/index.ts';
import type { ApiLane, ProbeResult, StateStore } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { CACHE_PATH } from './reconcile.ts';
import { API_SEEN_PATH, makeSourceStage } from './source.ts';

const POLICY = {
  reprobeNotFoundAfterDays: 30,
  maxProbeFailures: 3,
  staleAfterFetchFailures: 3,
};

function fakeStateStore(): StateStore & {
  store: Map<string, unknown>;
  writeCalls: string[];
} {
  const store = new Map<string, unknown>();
  const writeCalls: string[] = [];
  return {
    store,
    writeCalls,
    async readDoc<T>(key: string, schema: { parse(v: unknown): T }) {
      if (!store.has(key)) return undefined;
      return schema.parse(store.get(key));
    },
    async writeDoc(key: string, value: unknown) {
      writeCalls.push(key);
      store.set(key, value);
    },
    close() {},
  };
}

function fakeCtx(
  stateStore: ReturnType<typeof fakeStateStore>,
  overrides?: { signal?: AbortSignal; warn?: (msg: string, data?: unknown) => void },
): StageContext {
  return {
    profile: 'rajni',
    signal: overrides?.signal ?? AbortSignal.timeout(30_000),
    logger: {
      debug() {},
      info() {},
      warn: overrides?.warn ?? (() => {}),
      error() {},
    },
    beat() {},
    storage: {} as StageContext['storage'],
    stateStore,
  };
}

function fakeJob(id: string, lane: string, company: string) {
  return {
    identity: {
      id,
      lane,
      url: `https://example.com/jobs/${id}`,
      company,
      title: 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
  };
}

function emptyPayload(): StagePayload {
  return { jobs: [], dropped: [] };
}

/** ApiLane whose probe/fetch behavior is driven by simple maps keyed on company name / boardRef. */
function makeFakeLane(opts: {
  name: string;
  probeResults?: Record<string, ProbeResult | 'throw'>;
  boardJobs?: Record<string, ReturnType<typeof fakeJob>[] | 'throw'>;
  /** Per-boardRef DroppedRecords `fetchBoard` should return alongside its
   * jobs — models a lane like Greenhouse/Keka that drops a job failing its
   * final JDSchema build (see source.test.ts's dedicated funnel test). */
  boardDropped?: Record<string, unknown[]>;
  probeCalls?: string[];
  fetchCalls?: string[];
}): ApiLane {
  return {
    kind: 'api',
    name: opts.name,
    async probe(company: string) {
      opts.probeCalls?.push(company);
      const result = opts.probeResults?.[company];
      if (result === 'throw') throw new Error(`probe boom for ${company}`);
      return result ?? { status: 'not-found' };
    },
    async fetchBoard(boardRef: string) {
      opts.fetchCalls?.push(boardRef);
      const jobs = opts.boardJobs?.[boardRef];
      if (jobs === 'throw') throw new Error(`fetch boom for ${boardRef}`);
      return {
        jobs: (jobs ?? []) as never,
        dropped: (opts.boardDropped?.[boardRef] ?? []) as never,
      };
    },
  };
}

test('probe found -> boardsToFetch -> fetchBoard jobs appended; registry persisted with found state', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: { 'acme-corp': [fakeJob('gh-1', 'greenhouse', 'Acme Corp')] },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'gh-1');

  const reg = stateStore.store.get('registry/companies.json') as Array<{
    normalizedKey: string;
    probes: Record<string, { status: string; boardRef?: string }>;
  }>;
  const acme = reg.find((r) => r.normalizedKey === companyKey('Acme Corp'));
  assert.ok(acme);
  assert.equal(acme?.probes.greenhouse?.status, 'found');
  assert.equal(acme?.probes.greenhouse?.boardRef, 'acme-corp');
});

test('probe not-found and probe error paths recorded; error increments failCount', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', {
    linkedin: ['Notfound Inc', 'Errory LLC'],
  });

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: {
      'Notfound Inc': { status: 'not-found' },
      'Errory LLC': 'throw',
    },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 0);

  const reg = stateStore.store.get('registry/companies.json') as Array<{
    normalizedKey: string;
    probes: Record<string, { status: string; failCount: number }>;
  }>;
  const notfound = reg.find((r) => r.normalizedKey === companyKey('Notfound Inc'));
  const errory = reg.find((r) => r.normalizedKey === companyKey('Errory LLC'));
  assert.equal(notfound?.probes.greenhouse?.status, 'not-found');
  assert.equal(errory?.probes.greenhouse?.status, 'error');
  assert.equal(errory?.probes.greenhouse?.failCount, 1);
});

test('maxProbesPerRun cap respected (cap 2 with 5 candidates -> only 2 probed)', async () => {
  const stateStore = fakeStateStore();
  const names = ['C1', 'C2', 'C3', 'C4', 'C5'];
  stateStore.store.set('registry/companies_seen.json', { linkedin: names });

  const probeCalls: string[] = [];
  const lane = makeFakeLane({ name: 'greenhouse', probeCalls });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 2 });
  const ctx = fakeCtx(stateStore);
  await stage.run(emptyPayload(), ctx);

  assert.equal(probeCalls.length, 2);
});

test('a fetchBoard throwing is soft: recordFetchFailure applied, other boards still processed, run() does not throw', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', {
    linkedin: ['Broken Board Co', 'Good Board Co'],
  });

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: {
      'Broken Board Co': { status: 'found', boardRef: 'broken' },
      'Good Board Co': { status: 'found', boardRef: 'good' },
    },
    boardJobs: {
      broken: 'throw',
      good: [fakeJob('gh-2', 'greenhouse', 'Good Board Co')],
    },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'gh-2');

  const reg = stateStore.store.get('registry/companies.json') as Array<{
    normalizedKey: string;
    probes: Record<string, { status: string; failCount: number }>;
  }>;
  const broken = reg.find((r) => r.normalizedKey === companyKey('Broken Board Co'));
  assert.equal(broken?.probes.greenhouse?.failCount, 1);
  // still 'found' — one failure is below staleAfterFetchFailures (3)
  assert.equal(broken?.probes.greenhouse?.status, 'found');
});

test('a whole lane whose probe always throws is soft: zero jobs from it, the other lane still yields jobs', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', {
    linkedin: ['Flaky Co', 'Reliable Co'],
  });

  const flakyLane = makeFakeLane({
    name: 'keka',
    probeResults: { 'Flaky Co': 'throw', 'Reliable Co': 'throw' },
  });
  const reliableLane = makeFakeLane({
    name: 'greenhouse',
    probeResults: {
      'Flaky Co': { status: 'found', boardRef: 'flaky-gh' },
      'Reliable Co': { status: 'found', boardRef: 'reliable-gh' },
    },
    boardJobs: {
      'flaky-gh': [fakeJob('gh-3', 'greenhouse', 'Flaky Co')],
      'reliable-gh': [fakeJob('gh-4', 'greenhouse', 'Reliable Co')],
    },
  });

  const stage = makeSourceStage([flakyLane, reliableLane], POLICY, {
    maxProbesPerRun: 25,
  });
  const ctx = fakeCtx(stateStore);

  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 2);
  assert.deepEqual(out.jobs.map((j) => j.identity.id).sort(), ['gh-3', 'gh-4']);

  const reg = stateStore.store.get('registry/companies.json') as Array<{
    normalizedKey: string;
    probes: Record<string, { status: string }>;
  }>;
  const flaky = reg.find((r) => r.normalizedKey === companyKey('Flaky Co'));
  assert.equal(flaky?.probes.keka?.status, 'error');
  assert.equal(flaky?.probes.greenhouse?.status, 'found');
});

test('registry written exactly once; dropped passed through unchanged; jobsIn preserved', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Solo Co'] });

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Solo Co': { status: 'found', boardRef: 'solo' } },
    boardJobs: { solo: [fakeJob('gh-5', 'greenhouse', 'Solo Co')] },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);

  const existingJob = fakeJob('pre-existing', 'linkedin', 'Somewhere');
  const droppedRecord = {
    jd: fakeJob('dropped-1', 'linkedin', 'Nowhere'),
    reasons: [{ rule: 'title.domain', severity: 'hard' as const, pass: false }],
  };
  const input: StagePayload = {
    jobs: [existingJob as never],
    dropped: [droppedRecord as never],
  };

  const out = await stage.run(input, ctx);

  const registryWrites = stateStore.writeCalls.filter(
    (p) => p === 'registry/companies.json',
  );
  assert.equal(registryWrites.length, 1);

  assert.deepEqual(out.dropped, input.dropped);
  assert.ok(out.jobs.some((j) => j.identity.id === 'pre-existing'));
  assert.ok(out.jobs.some((j) => j.identity.id === 'gh-5'));
  assert.equal(out.jobs.length, 2);
});

test('run-level abort mid-probe propagates loud, records nothing, and never writes the registry', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', {
    linkedin: ['C1', 'C2', 'C3'],
  });

  const controller = new AbortController();
  const probeCalls: string[] = [];

  // A well-behaved ApiLane (like GreenhouseLane/KekaLane post-fix): once its
  // ctx.signal is aborted, it rethrows rather than swallowing the abort into
  // a recordable probe result.
  const lane: ApiLane = {
    kind: 'api',
    name: 'greenhouse',
    async probe(company, ctx) {
      probeCalls.push(company);
      controller.abort(new Error('run cancelled'));
      if (ctx.signal.aborted) throw new Error('aborted mid-probe');
      return { status: 'not-found' };
    },
    async fetchBoard() {
      throw new Error('fetchBoard should not be reached after a run-level abort');
    },
  };

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore, { signal: controller.signal });

  await assert.rejects(() => stage.run(emptyPayload(), ctx));

  // Only the first candidate was attempted — the abort must stop the loop,
  // not just fail to record it.
  assert.equal(probeCalls.length, 1);

  // No registry write at all — an aborted run must not durably lock out a
  // healthy company via a stray failCount/staleness bump.
  assert.equal(
    stateStore.writeCalls.filter((p) => p === 'registry/companies.json').length,
    0,
  );
  assert.equal(stateStore.store.has('registry/companies.json'), false);
});

test('a lane exceeding its budget is a soft per-lane event: warn logged, other lane still returns jobs, run does not fail', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', {
    linkedin: ['Slow Co', 'Fast Co'],
  });

  const warnings: Array<{ msg: string; data?: unknown }> = [];

  // Simulates a blackholed ATS: never settles on its own, only when its
  // ctx.signal (composed with the lane budget) fires.
  const hangingLane: ApiLane = {
    kind: 'api',
    name: 'keka',
    async probe(_company, ctx) {
      await new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
      throw new Error('unreachable');
    },
    async fetchBoard() {
      throw new Error('fetchBoard should not be reached once the lane budget expires');
    },
  };

  const fastLane = makeFakeLane({
    name: 'greenhouse',
    probeResults: {
      'Slow Co': { status: 'found', boardRef: 'slow-gh' },
      'Fast Co': { status: 'found', boardRef: 'fast-gh' },
    },
    boardJobs: {
      'slow-gh': [fakeJob('gh-20', 'greenhouse', 'Slow Co')],
      'fast-gh': [fakeJob('gh-21', 'greenhouse', 'Fast Co')],
    },
  });

  const stage = makeSourceStage([hangingLane, fastLane], POLICY, {
    maxProbesPerRun: 25,
    laneBudgetMs: 20,
  });
  const ctx = fakeCtx(stateStore, {
    warn: (msg, data) => warnings.push({ msg, data }),
  });

  const out = await stage.run(emptyPayload(), ctx);

  // The other lane's jobs are still returned — the run itself succeeds.
  assert.deepEqual(out.jobs.map((j) => j.identity.id).sort(), ['gh-20', 'gh-21']);

  assert.ok(warnings.some((w) => w.msg === 'lane exceeded its budget'));

  // Nothing recorded for the budget-aborted keka probe.
  const reg = stateStore.store.get('registry/companies.json') as Array<{
    normalizedKey: string;
    probes: Record<string, unknown>;
  }>;
  const slow = reg.find((r) => r.normalizedKey === companyKey('Slow Co'));
  const fast = reg.find((r) => r.normalizedKey === companyKey('Fast Co'));
  assert.equal(slow?.probes.keka, undefined);
  assert.equal(fast?.probes.keka, undefined);
  // The other lane's probes were recorded normally.
  assert.equal(
    (slow?.probes.greenhouse as { status?: string } | undefined)?.status,
    'found',
  );
});

test('a lane-level JDSchema drop (e.g. greenhouse.jdSchema) surfaces in the stage dropped output — the funnel actually receives it, not just a warn log', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });

  const droppedFromLane = {
    jd: fakeJob('gh-bad', 'greenhouse', 'Acme Corp'),
    reasons: [
      {
        rule: 'greenhouse.jdSchema',
        severity: 'hard' as const,
        pass: false,
        detail: 'content.rawText too short',
      },
    ],
  };

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: { 'acme-corp': [fakeJob('gh-1', 'greenhouse', 'Acme Corp')] },
    boardDropped: { 'acme-corp': [droppedFromLane] },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);

  const out = await stage.run(emptyPayload(), ctx);

  // The surviving job still reaches out.jobs...
  assert.ok(out.jobs.some((j) => j.identity.id === 'gh-1'));
  // ...and the JDSchema-dropped job reaches out.dropped instead of vanishing.
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]?.jd.identity.id, 'gh-bad');
  assert.equal(out.dropped[0]?.reasons[0]?.rule, 'greenhouse.jdSchema');
});

test('all api lanes failing entirely: stage throws loud, no registry write', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', {
    linkedin: ['Flaky Co', 'Broken Co'],
  });

  const warnings: Array<{ msg: string; data?: unknown }> = [];

  // A lane whose whole per-lane block throws (not a narrow per-candidate/
  // per-board SoftError caught internally) — simulates a lane-level bug or
  // outage that escapes the inner try/catches, e.g. a malformed registry
  // read for that lane's own bookkeeping. `name` is accessed (not called)
  // by probeCandidates/boardsToFetch/logging inside the per-lane try block,
  // so a throwing getter is the narrowest way to force that escape in a test.
  function makeBrokenLane(laneName: string): ApiLane {
    let nameAccesses = 0;
    return {
      kind: 'api',
      get name(): string {
        nameAccesses += 1;
        // Throws only on the FIRST access (probeCandidates' lookup) so the
        // outer catch's own logging/aggregation — which also reads
        // apiLane.name — succeeds normally, same as a real thrown Error
        // would once past the point of failure.
        if (nameAccesses === 1) throw new Error(`${laneName} lane bookkeeping broken`);
        return laneName;
      },
      async probe() {
        throw new Error('unreachable');
      },
      async fetchBoard() {
        throw new Error('unreachable');
      },
    };
  }

  const laneA = makeBrokenLane('keka');
  const laneB = makeBrokenLane('greenhouse');

  const stage = makeSourceStage([laneA, laneB], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore, { warn: (msg, data) => warnings.push({ msg, data }) });

  await assert.rejects(
    () => stage.run(emptyPayload(), ctx),
    /all 2 api lane\(s\) failed/,
  );

  assert.equal(warnings.filter((w) => w.msg === 'api lane failed entirely').length, 2);
  assert.equal(stateStore.store.has('registry/companies.json'), false);
});

function fakeCacheEntry(id: string) {
  return { id, company: 'Acme Corp', title: 'Frontend Engineer', pageId: `page-${id}` };
}

test('cache gate: a job whose id is in the cache is skipped entirely — not in out.jobs, out.dropped unchanged', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });
  stateStore.store.set(CACHE_PATH, [fakeCacheEntry('gh-1')]);

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: { 'acme-corp': [fakeJob('gh-1', 'greenhouse', 'Acme Corp')] },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);
  const input = emptyPayload();
  const out = await stage.run(input, ctx);

  assert.equal(out.jobs.length, 0);
  assert.deepEqual(out.dropped, input.dropped);
});

test('cache gate: a job whose id is NOT in the cache passes through', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });
  stateStore.store.set(CACHE_PATH, [fakeCacheEntry('gh-999')]);

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: { 'acme-corp': [fakeJob('gh-1', 'greenhouse', 'Acme Corp')] },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'gh-1');
});

test('cache gate: mixed board of 3 jobs with 2 cached -> exactly 1 emitted, the right one', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });
  stateStore.store.set(CACHE_PATH, [fakeCacheEntry('gh-1'), fakeCacheEntry('gh-2')]);

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: {
      'acme-corp': [
        fakeJob('gh-1', 'greenhouse', 'Acme Corp'),
        fakeJob('gh-2', 'greenhouse', 'Acme Corp'),
        fakeJob('gh-3', 'greenhouse', 'Acme Corp'),
      ],
    },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'gh-3');
});

test('cache gate: cache key entirely absent from stateStore -> gate disabled, all jobs pass, and a warn is logged', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });
  // CACHE_PATH deliberately not set in stateStore.

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: { 'acme-corp': [fakeJob('gh-1', 'greenhouse', 'Acme Corp')] },
  });

  const warnings: Array<{ msg: string; data?: unknown }> = [];
  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore, { warn: (msg, data) => warnings.push({ msg, data }) });
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'gh-1');
  assert.ok(warnings.some((w) => w.msg.toLowerCase().includes('cache')));
});

test('cache gate: cache present but empty array -> all jobs pass, no cache-absent warn emitted', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });
  stateStore.store.set(CACHE_PATH, []);

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: { 'acme-corp': [fakeJob('gh-1', 'greenhouse', 'Acme Corp')] },
  });

  const warnings: Array<{ msg: string; data?: unknown }> = [];
  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore, { warn: (msg, data) => warnings.push({ msg, data }) });
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'gh-1');
  assert.ok(!warnings.some((w) => w.msg.toLowerCase().includes('cache')));
});

// ---------- card gate (title/avoid), seen ledger, maxNewPerLane cap ----------

const TITLE_GATE_CFG: FilterConfig = {
  title: { domain: { match: [], reject: ['sales'], severity: 'hard' } },
};

test('card gate: a job whose title fails the title rule is dropped before it ever reaches out.jobs — and never counts against the cap or gets marked seen', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: {
      'acme-corp': [
        {
          ...fakeJob('gh-1', 'greenhouse', 'Acme Corp'),
          identity: {
            ...fakeJob('gh-1', 'greenhouse', 'Acme Corp').identity,
            title: 'Sales Rep',
          },
        },
        fakeJob('gh-2', 'greenhouse', 'Acme Corp'),
      ],
    },
  });

  const stage = makeSourceStage([lane], POLICY, {
    maxProbesPerRun: 25,
    filterCfg: TITLE_GATE_CFG,
  });
  const ctx = fakeCtx(stateStore);
  const out = await stage.run(emptyPayload(), ctx);

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['gh-2'],
  );
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]?.jd.identity.id, 'gh-1');
  assert.equal(out.dropped[0]?.reasons[0]?.rule, 'title.domain');

  // The gate-dropped job must never be recorded in the seen ledger — it
  // was never "emitted", so a later run must still be free to re-judge it
  // if the title config changes.
  const seen = stateStore.store.get(API_SEEN_PATH) as Record<string, string>;
  assert.equal(Object.hasOwn(seen, 'gh-1'), false);
  assert.ok(Object.hasOwn(seen, 'gh-2'));
});

test('seen ledger: a job already recorded as seen in a prior run is skipped this run even though not in the Notion cache', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });
  stateStore.store.set(API_SEEN_PATH, { 'gh-1': '2026-07-20T00:00:00.000Z' });

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: {
      'acme-corp': [
        fakeJob('gh-1', 'greenhouse', 'Acme Corp'),
        fakeJob('gh-2', 'greenhouse', 'Acme Corp'),
      ],
    },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(stateStore);
  const out = await stage.run(emptyPayload(), ctx);

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['gh-2'],
  );
  // Silent skip, same posture as the cache gate — no DroppedRecord.
  assert.equal(out.dropped.length, 0);
});

test('maxNewPerLane cap: a lane with more surviving jobs than the cap emits only the cap, logs loudly once, and emits a DroppedRecord for every truncated job', async () => {
  const stateStore = fakeStateStore();
  stateStore.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });

  const jobs = Array.from({ length: 5 }, (_, i) =>
    fakeJob(`gh-${i}`, 'greenhouse', 'Acme Corp'),
  );

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: { 'acme-corp': jobs },
  });

  const warnings: Array<{ msg: string; data?: unknown }> = [];
  const stage = makeSourceStage([lane], POLICY, {
    maxProbesPerRun: 25,
    maxNewPerLane: 2,
  });
  const ctx = fakeCtx(stateStore, { warn: (msg, data) => warnings.push({ msg, data }) });
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 2);
  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['gh-0', 'gh-1'],
  );

  const capDrops = out.dropped.filter((d) => d.reasons[0]?.rule === 'source.maxNewCap');
  assert.equal(capDrops.length, 3);
  assert.deepEqual(capDrops.map((d) => d.jd.identity.id).sort(), [
    'gh-2',
    'gh-3',
    'gh-4',
  ]);

  const capWarnings = warnings.filter((w) => w.msg.includes('maxNewPerLane cap hit'));
  assert.equal(capWarnings.length, 1);
});
