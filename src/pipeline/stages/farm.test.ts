import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FarmingLane, Storage } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { makeFarmStage } from './farm.ts';

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

function fakeCtx(
  storage: ReturnType<typeof fakeStorage>,
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
      };
    },
  };
}

test('two lanes: jobs and dropped merged into output, companiesSeen written per lane name', async () => {
  const storage = fakeStorage();
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
  const ctx = fakeCtx(storage);
  const out = await stage.run(emptyPayload(), ctx);

  assert.deepEqual(out.jobs.map((j) => j.identity.id).sort(), ['li-1', 'li-3']);
  assert.equal(out.dropped.length, 1);
  assert.equal(
    (out.dropped[0] as { jd: { identity: { id: string } } }).jd.identity.id,
    'li-2',
  );

  const seen = storage.store.get('registry/companies_seen.json') as Record<
    string,
    string[]
  >;
  assert.deepEqual(seen, {
    linkedin: ['Acme Corp', 'Beta Inc'],
    'linkedin-secondary': ['Gamma LLC'],
  });
  assert.equal(
    storage.writeCalls.filter((p) => p === 'registry/companies_seen.json').length,
    1,
  );
});

test('input jobs/dropped preserved and concatenated with farmed results', async () => {
  const storage = fakeStorage();
  const lane = makeFakeLane({
    name: 'linkedin',
    jobs: [fakeJob('li-9', 'linkedin', 'Solo Co')],
    dropped: [fakeDropped('li-dropped')],
    companiesSeen: ['Solo Co'],
  });
  const stage = makeFarmStage([lane]);
  const ctx = fakeCtx(storage);

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
  const storage = fakeStorage();
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
  const ctx = fakeCtx(storage, { warn: (msg, data) => warnings.push({ msg, data }) });

  const out = await stage.run(emptyPayload(), ctx);

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['li-4'],
  );
  assert.ok(warnings.some((w) => w.msg === 'farming lane failed entirely'));

  const seen = storage.store.get('registry/companies_seen.json') as Record<
    string,
    string[]
  >;
  assert.deepEqual(seen, { 'linkedin-secondary': ['Reliable Co'] });
});

test('empty lanes list: passthrough of input, empty companiesSeen written, no crash', async () => {
  const storage = fakeStorage();
  const stage = makeFarmStage([]);
  const ctx = fakeCtx(storage);

  const input: StagePayload = {
    jobs: [fakeJob('only-one', 'greenhouse', 'Existing Co') as never],
    dropped: [],
  };
  const out = await stage.run(input, ctx);

  assert.deepEqual(out, input);
  const seen = storage.store.get('registry/companies_seen.json');
  assert.deepEqual(seen, {});
});

test('run-level abort mid-lane propagates loud and never writes companies_seen.json', async () => {
  const storage = fakeStorage();
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
  const ctx = fakeCtx(storage, { signal: controller.signal });

  await assert.rejects(() => stage.run(emptyPayload(), ctx));

  assert.equal(
    storage.writeCalls.filter((p) => p === 'registry/companies_seen.json').length,
    0,
  );
  assert.equal(storage.store.has('registry/companies_seen.json'), false);
});

test('stage definition has heartbeat armed and correct timeout', () => {
  const stage = makeFarmStage([]);
  assert.equal(stage.heartbeat, true, 'heartbeat must be true');
  assert.equal(stage.timeoutMs, 1_800_000, 'timeoutMs must be 1_800_000 (30 min)');
});
