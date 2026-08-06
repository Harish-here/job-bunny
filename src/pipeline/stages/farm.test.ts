import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FarmingLane, StateStore } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { makeFarmStage } from './farm.ts';

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
  overrides?: {
    signal?: AbortSignal;
    warn?: (msg: string, data?: unknown) => void;
    info?: (msg: string, data?: unknown) => void;
  },
): StageContext {
  return {
    profile: 'rajni',
    signal: overrides?.signal ?? AbortSignal.timeout(30_000),
    logger: {
      debug() {},
      info: overrides?.info ?? (() => {}),
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

function fakeDropped(id: string) {
  return {
    jd: fakeJob(id, 'linkedin', 'Nowhere'),
    reasons: [{ rule: 'title.domain', severity: 'hard' as const, pass: false }],
  };
}

function makeFakeLane(opts: {
  name: string;
  jobs?: ReturnType<typeof fakeJob>[];
  dropped?: ReturnType<typeof fakeDropped>[];
  companiesSeen?: string[];
  throwErr?: Error;
  skipped?: { reason: string };
}): FarmingLane {
  return {
    kind: 'farming',
    name: opts.name,
    async source() {
      if (opts.throwErr) throw opts.throwErr;
      return {
        jobs: (opts.jobs ?? []) as never,
        dropped: (opts.dropped ?? []) as never,
        companiesSeen: opts.companiesSeen ?? [],
        ...(opts.skipped ? { skipped: opts.skipped } : {}),
      };
    },
  };
}

test('two lanes: jobs and dropped merged into output, companiesSeen written per lane name', async () => {
  const stateStore = fakeStateStore();
  const laneA = makeFakeLane({
    name: 'linkedin',
    jobs: [fakeJob('li-1', 'linkedin', 'Acme Corp')],
    dropped: [fakeDropped('li-2')],
    companiesSeen: ['Acme Corp', 'Beta Inc'],
  });
  const laneB = makeFakeLane({
    name: 'linkedin-secondary',
    jobs: [fakeJob('li-3', 'linkedin-secondary', 'Gamma LLC')],
    companiesSeen: ['Gamma LLC'],
  });

  const stage = makeFarmStage([laneA, laneB]);
  const ctx = fakeCtx(stateStore);
  const out = await stage.run(emptyPayload(), ctx);

  assert.deepEqual(out.jobs.map((j) => j.identity.id).sort(), ['li-1', 'li-3']);
  assert.equal(out.dropped.length, 1);
  assert.equal(
    (out.dropped[0] as { jd: { identity: { id: string } } }).jd.identity.id,
    'li-2',
  );

  const seen = stateStore.store.get('registry/companies_seen.json') as Record<
    string,
    string[]
  >;
  assert.deepEqual(seen, {
    linkedin: ['Acme Corp', 'Beta Inc'],
    'linkedin-secondary': ['Gamma LLC'],
  });
  assert.equal(
    stateStore.writeCalls.filter((p) => p === 'registry/companies_seen.json').length,
    1,
  );
});

test('input jobs/dropped preserved and concatenated with farmed results', async () => {
  const stateStore = fakeStateStore();
  const lane = makeFakeLane({
    name: 'linkedin',
    jobs: [fakeJob('li-9', 'linkedin', 'Solo Co')],
    dropped: [fakeDropped('li-dropped')],
    companiesSeen: ['Solo Co'],
  });
  const stage = makeFarmStage([lane]);
  const ctx = fakeCtx(stateStore);

  const input: StagePayload = {
    jobs: [fakeJob('pre-existing', 'greenhouse', 'Somewhere') as never],
    dropped: [fakeDropped('pre-dropped') as never],
  };
  const out = await stage.run(input, ctx);

  assert.equal(out.jobs.length, 2);
  assert.ok(out.jobs.some((j) => j.identity.id === 'pre-existing'));
  assert.ok(out.jobs.some((j) => j.identity.id === 'li-9'));
  assert.equal(out.dropped.length, 2);
});

test('one lane throwing is soft: other lane still yields jobs, failure recorded, run does not throw', async () => {
  const stateStore = fakeStateStore();
  const warnings: Array<{ msg: string; data?: unknown }> = [];

  const brokenLane = makeFakeLane({
    name: 'linkedin',
    throwErr: new Error('all attempted URLs failed — logout shape'),
  });
  const healthyLane = makeFakeLane({
    name: 'linkedin-secondary',
    jobs: [fakeJob('li-4', 'linkedin-secondary', 'Reliable Co')],
    companiesSeen: ['Reliable Co'],
  });

  const stage = makeFarmStage([brokenLane, healthyLane]);
  const ctx = fakeCtx(stateStore, { warn: (msg, data) => warnings.push({ msg, data }) });

  const out = await stage.run(emptyPayload(), ctx);

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['li-4'],
  );
  assert.ok(warnings.some((w) => w.msg === 'farming lane failed entirely'));

  const seen = stateStore.store.get('registry/companies_seen.json') as Record<
    string,
    string[]
  >;
  assert.deepEqual(seen, { 'linkedin-secondary': ['Reliable Co'] });
});

test('all lanes throwing: stage throws loud, no companies_seen write', async () => {
  const stateStore = fakeStateStore();
  const warnings: Array<{ msg: string; data?: unknown }> = [];

  const laneA = makeFakeLane({
    name: 'linkedin',
    throwErr: new Error('all attempted URLs failed — logout shape'),
  });
  const laneB = makeFakeLane({
    name: 'linkedin-secondary',
    throwErr: new Error('total outage'),
  });

  const stage = makeFarmStage([laneA, laneB]);
  const ctx = fakeCtx(stateStore, { warn: (msg, data) => warnings.push({ msg, data }) });

  await assert.rejects(
    () => stage.run(emptyPayload(), ctx),
    /all 2 farming lane\(s\) failed/,
  );

  // Both individual failures are still warned (fail-soft per-lane logging
  // stays intact; only the aggregate result becomes a thrown error).
  assert.equal(
    warnings.filter((w) => w.msg === 'farming lane failed entirely').length,
    2,
  );
  assert.equal(stateStore.store.has('registry/companies_seen.json'), false);
});

test('empty lanes list: passthrough of input, empty companiesSeen written, no crash', async () => {
  const stateStore = fakeStateStore();
  const stage = makeFarmStage([]);
  const ctx = fakeCtx(stateStore);

  const input: StagePayload = {
    jobs: [fakeJob('only-one', 'greenhouse', 'Existing Co') as never],
    dropped: [],
  };
  const out = await stage.run(input, ctx);

  assert.deepEqual(out, input);
  const seen = stateStore.store.get('registry/companies_seen.json');
  assert.deepEqual(seen, {});
});

test('run-level abort mid-lane propagates loud and never writes companies_seen.json', async () => {
  const stateStore = fakeStateStore();
  const controller = new AbortController();

  const lane: FarmingLane = {
    kind: 'farming',
    name: 'linkedin',
    async source(ctx) {
      controller.abort(new Error('run cancelled'));
      if (ctx.signal.aborted) throw new Error('aborted mid-farm');
      return { jobs: [], dropped: [], companiesSeen: [] };
    },
  };

  const stage = makeFarmStage([lane]);
  const ctx = fakeCtx(stateStore, { signal: controller.signal });

  await assert.rejects(() => stage.run(emptyPayload(), ctx));

  assert.equal(
    stateStore.writeCalls.filter((p) => p === 'registry/companies_seen.json').length,
    0,
  );
  assert.equal(stateStore.store.has('registry/companies_seen.json'), false);
});

test('stage definition has heartbeat armed and correct timeout', () => {
  const stage = makeFarmStage([]);
  assert.equal(stage.heartbeat, true, 'heartbeat must be true');
  assert.equal(stage.timeoutMs, 5_400_000, 'timeoutMs must be 5_400_000 (90 min)');
});

// --- skipped lanes (throttle guard D10, 2026-07-28) ---

test('the only lane skipping does NOT trip the total-outage throw — the stage completes and companies_seen is still written', async () => {
  const stateStore = fakeStateStore();
  const infos: Array<{ msg: string; data?: unknown }> = [];
  const lane = makeFakeLane({
    name: 'linkedin',
    skipped: { reason: 'throttle cooldown until 2026-07-28T18:42:00.000Z' },
  });

  const stage = makeFarmStage([lane]);
  const ctx = fakeCtx(stateStore, {
    info: (msg, data) => {
      infos.push({ msg, data });
    },
  });

  const out = await stage.run(emptyPayload(), ctx);

  assert.deepEqual(out.jobs, []);
  assert.ok(infos.some((i) => i.msg === 'farming lane skipped'));
  assert.deepEqual(infos.find((i) => i.msg === 'farming lane skipped')?.data, {
    lane: 'linkedin',
    reason: 'throttle cooldown until 2026-07-28T18:42:00.000Z',
  });
  // Written, and the skipped lane contributes no entry to it.
  assert.deepEqual(stateStore.store.get('registry/companies_seen.json'), {});
});

test('one lane skipped + one lane failing IS a total outage — every lane that attempted work failed', async () => {
  const stateStore = fakeStateStore();
  const skippedLane = makeFakeLane({
    name: 'linkedin',
    skipped: { reason: 'throttle cooldown until 18:42' },
  });
  const brokenLane = makeFakeLane({
    name: 'linkedin-secondary',
    throwErr: new Error('all attempted URLs failed — logout shape'),
  });

  const stage = makeFarmStage([skippedLane, brokenLane]);

  await assert.rejects(
    () => stage.run(emptyPayload(), fakeCtx(stateStore)),
    /all 1 farming lane\(s\) failed/,
  );
  assert.equal(stateStore.store.has('registry/companies_seen.json'), false);
});

test('one lane skipped + one lane succeeding does not throw and keeps the healthy lane s results', async () => {
  const stateStore = fakeStateStore();
  const skippedLane = makeFakeLane({
    name: 'linkedin',
    skipped: { reason: 'throttle cooldown until 18:42' },
  });
  const healthyLane = makeFakeLane({
    name: 'linkedin-secondary',
    jobs: [fakeJob('li-7', 'linkedin-secondary', 'Reliable Co')],
    companiesSeen: ['Reliable Co'],
  });

  const stage = makeFarmStage([skippedLane, healthyLane]);
  const out = await stage.run(emptyPayload(), fakeCtx(stateStore));

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['li-7'],
  );
  assert.deepEqual(stateStore.store.get('registry/companies_seen.json'), {
    'linkedin-secondary': ['Reliable Co'],
  });
});

test('every lane skipping does not throw — nothing attempted means nothing failed', async () => {
  const stateStore = fakeStateStore();
  const stage = makeFarmStage([
    makeFakeLane({ name: 'linkedin', skipped: { reason: 'throttle cooldown' } }),
    makeFakeLane({
      name: 'linkedin-secondary',
      skipped: { reason: 'throttle cooldown' },
    }),
  ]);

  const out = await stage.run(emptyPayload(), fakeCtx(stateStore));

  assert.deepEqual(out.jobs, []);
  assert.deepEqual(stateStore.store.get('registry/companies_seen.json'), {});
});

test('a skipped lane s own jobs/dropped/companiesSeen are ignored — skipped means it contributed nothing', async () => {
  const stateStore = fakeStateStore();
  const lane = makeFakeLane({
    name: 'linkedin',
    jobs: [fakeJob('li-ghost', 'linkedin', 'Ghost Co')],
    dropped: [fakeDropped('li-ghost-dropped')],
    companiesSeen: ['Ghost Co'],
    skipped: { reason: 'throttle cooldown' },
  });

  const stage = makeFarmStage([lane]);
  const out = await stage.run(emptyPayload(), fakeCtx(stateStore));

  assert.deepEqual(out.jobs, []);
  assert.deepEqual(out.dropped, []);
  assert.deepEqual(stateStore.store.get('registry/companies_seen.json'), {});
});
