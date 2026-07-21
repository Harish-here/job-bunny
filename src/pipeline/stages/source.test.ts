import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companyKey } from '../../core/jd/index.ts';
import type { ApiLane, ProbeResult, Storage } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { makeSourceStage } from './source.ts';

const POLICY = {
  reprobeNotFoundAfterDays: 30,
  maxProbeFailures: 3,
  staleAfterFetchFailures: 3,
};

function fakeStorage(): Storage & { store: Map<string, unknown>; writeCalls: string[] } {
  const store = new Map<string, unknown>();
  const writeCalls: string[] = [];
  return {
    store,
    writeCalls,
    async readJson<T>(relPath: string, schema: { parse(v: unknown): T }) {
      if (!store.has(relPath)) return undefined;
      return schema.parse(store.get(relPath));
    },
    async writeJson(relPath: string, value: unknown) {
      writeCalls.push(relPath);
      store.set(relPath, value);
    },
  };
}

function fakeCtx(storage: ReturnType<typeof fakeStorage>): StageContext {
  return {
    profile: 'rajni',
    signal: AbortSignal.timeout(30_000),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    beat() {},
    storage,
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
      return (jobs ?? []) as never;
    },
  };
}

test('probe found -> boardsToFetch -> fetchBoard jobs appended; registry persisted with found state', async () => {
  const storage = fakeStorage();
  storage.store.set('registry/companies_seen.json', { linkedin: ['Acme Corp'] });

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Acme Corp': { status: 'found', boardRef: 'acme-corp' } },
    boardJobs: { 'acme-corp': [fakeJob('gh-1', 'greenhouse', 'Acme Corp')] },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(storage);
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'gh-1');

  const reg = storage.store.get('registry/companies.json') as Array<{
    normalizedKey: string;
    probes: Record<string, { status: string; boardRef?: string }>;
  }>;
  const acme = reg.find((r) => r.normalizedKey === companyKey('Acme Corp'));
  assert.ok(acme);
  assert.equal(acme?.probes.greenhouse?.status, 'found');
  assert.equal(acme?.probes.greenhouse?.boardRef, 'acme-corp');
});

test('probe not-found and probe error paths recorded; error increments failCount', async () => {
  const storage = fakeStorage();
  storage.store.set('registry/companies_seen.json', {
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
  const ctx = fakeCtx(storage);
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 0);

  const reg = storage.store.get('registry/companies.json') as Array<{
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
  const storage = fakeStorage();
  const names = ['C1', 'C2', 'C3', 'C4', 'C5'];
  storage.store.set('registry/companies_seen.json', { linkedin: names });

  const probeCalls: string[] = [];
  const lane = makeFakeLane({ name: 'greenhouse', probeCalls });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 2 });
  const ctx = fakeCtx(storage);
  await stage.run(emptyPayload(), ctx);

  assert.equal(probeCalls.length, 2);
});

test('a fetchBoard throwing is soft: recordFetchFailure applied, other boards still processed, run() does not throw', async () => {
  const storage = fakeStorage();
  storage.store.set('registry/companies_seen.json', {
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
  const ctx = fakeCtx(storage);
  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'gh-2');

  const reg = storage.store.get('registry/companies.json') as Array<{
    normalizedKey: string;
    probes: Record<string, { status: string; failCount: number }>;
  }>;
  const broken = reg.find((r) => r.normalizedKey === companyKey('Broken Board Co'));
  assert.equal(broken?.probes.greenhouse?.failCount, 1);
  // still 'found' — one failure is below staleAfterFetchFailures (3)
  assert.equal(broken?.probes.greenhouse?.status, 'found');
});

test('a whole lane whose probe always throws is soft: zero jobs from it, the other lane still yields jobs', async () => {
  const storage = fakeStorage();
  storage.store.set('registry/companies_seen.json', {
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
  const ctx = fakeCtx(storage);

  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(out.jobs.length, 2);
  assert.deepEqual(out.jobs.map((j) => j.identity.id).sort(), ['gh-3', 'gh-4']);

  const reg = storage.store.get('registry/companies.json') as Array<{
    normalizedKey: string;
    probes: Record<string, { status: string }>;
  }>;
  const flaky = reg.find((r) => r.normalizedKey === companyKey('Flaky Co'));
  assert.equal(flaky?.probes.keka?.status, 'error');
  assert.equal(flaky?.probes.greenhouse?.status, 'found');
});

test('registry written exactly once; dropped passed through unchanged; jobsIn preserved', async () => {
  const storage = fakeStorage();
  storage.store.set('registry/companies_seen.json', { linkedin: ['Solo Co'] });

  const lane = makeFakeLane({
    name: 'greenhouse',
    probeResults: { 'Solo Co': { status: 'found', boardRef: 'solo' } },
    boardJobs: { solo: [fakeJob('gh-5', 'greenhouse', 'Solo Co')] },
  });

  const stage = makeSourceStage([lane], POLICY, { maxProbesPerRun: 25 });
  const ctx = fakeCtx(storage);

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

  const registryWrites = storage.writeCalls.filter(
    (p) => p === 'registry/companies.json',
  );
  assert.equal(registryWrites.length, 1);

  assert.equal(out.dropped, input.dropped);
  assert.ok(out.jobs.some((j) => j.identity.id === 'pre-existing'));
  assert.ok(out.jobs.some((j) => j.identity.id === 'gh-5'));
  assert.equal(out.jobs.length, 2);
});
