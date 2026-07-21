import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { JD, Verdict } from '../../core/jd/index.ts';
import { RunFolder } from '../../ops/observability/run_folder.ts';
import type { Connector, Storage } from '../../ports/index.ts';
import type { PipelineCtx, WiredPorts } from './context.ts';
import { runPipeline } from './run.ts';
import type { DroppedRecord, StageDef, StagePayload } from './stage.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-run-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeJD(id: string): JD {
  return {
    identity: {
      id,
      lane: 'fake-lane',
      url: `https://example.com/${id}`,
      company: 'Acme',
      title: `Job ${id}`,
      scrapedAt: new Date().toISOString(),
    },
  };
}

function makeVerdict(rule: string): Verdict {
  return { rule, severity: 'hard', pass: false };
}

function fakeStorage(): Storage {
  return {
    async readJson() {
      return undefined;
    },
    async writeJson() {},
  };
}

function fakeConnector(): Connector {
  return {
    name: 'fake-connector',
    async rebuildCache() {
      return [];
    },
    async syncJobs() {
      return [];
    },
    async archiveStale() {
      return 0;
    },
  };
}

function fakePorts(): WiredPorts {
  return { lanes: [], connector: fakeConnector(), notifiers: [] };
}

function fakeCtx(controller: AbortController = new AbortController()): {
  ctx: PipelineCtx;
  controller: AbortController;
} {
  const ctx: PipelineCtx = {
    profile: 'rajni',
    signal: controller.signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: fakeStorage(),
    config: {
      lanes: [],
      connector: 'fake-connector',
      notifiers: [],
      routines: [],
      settings: {},
    },
    ports: fakePorts(),
    async notify() {},
  };
  return { ctx, controller };
}

function fakeStage(
  overrides: Partial<StageDef<StagePayload, StagePayload>> &
    Pick<StageDef<StagePayload, StagePayload>, 'name' | 'run'>,
): StageDef<StagePayload, StagePayload> {
  return {
    timeoutMs: 1_000,
    retries: 0,
    ...overrides,
  };
}

test('happy path: 3 stages checkpoint, funnel populates, result passes', async () => {
  const dataDir = join(root, 'happy');
  const folder = new RunFolder(dataDir, '2026-07-21');
  const { ctx } = fakeCtx();

  const jobA = makeJD('a');
  const jobC = makeJD('c');
  const droppedB: DroppedRecord = { jd: makeJD('b'), reasons: [makeVerdict('stale')] };

  const farm: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'farm',
    async run(input) {
      return { jobs: [...input.jobs, jobA], dropped: input.dropped };
    },
  });
  const filter: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'filter',
    async run(input) {
      return { jobs: input.jobs, dropped: [...input.dropped, droppedB] };
    },
  });
  const assemble: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'assemble',
    async run(input) {
      return { jobs: [...input.jobs, jobC], dropped: input.dropped };
    },
  });

  const result = await runPipeline([farm, filter, assemble], ctx, folder, {
    runCapMs: 5_000,
    stallMs: 5_000,
    resume: false,
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.failedStage, undefined);
  assert.equal(result.profile, 'rajni');
  assert.equal(result.date, '2026-07-21');
  assert.equal(result.stages.length, 3);

  const [farmResult, filterResult, assembleResult] = result.stages;
  assert.equal(farmResult?.name, 'farm');
  assert.equal(farmResult?.jobsIn, 0);
  assert.equal(farmResult?.jobsOut, 1);
  assert.deepEqual(farmResult?.dropsByRule, {});
  assert.equal(farmResult?.attempts, 1);

  assert.equal(filterResult?.name, 'filter');
  assert.equal(filterResult?.jobsIn, 1);
  assert.equal(filterResult?.jobsOut, 1);
  assert.deepEqual(filterResult?.dropsByRule, { stale: 1 });

  assert.equal(assembleResult?.name, 'assemble');
  assert.equal(assembleResult?.jobsIn, 1);
  assert.equal(assembleResult?.jobsOut, 2);

  for (const stage of result.stages) {
    assert.ok(typeof stage.elapsedMs === 'number' && stage.elapsedMs >= 0);
  }

  // 3 checkpoints written.
  const cp0 = JSON.parse(await readFile(folder.checkpointPath(0, 'farm'), 'utf8'));
  assert.equal(cp0.jobs.length, 1);
  const cp1 = JSON.parse(await readFile(folder.checkpointPath(1, 'filter'), 'utf8'));
  assert.equal(cp1.dropped.length, 1);
  const cp2 = JSON.parse(await readFile(folder.checkpointPath(2, 'assemble'), 'utf8'));
  assert.equal(cp2.jobs.length, 2);

  const resultJson = JSON.parse(await readFile(join(folder.dir, 'result.json'), 'utf8'));
  assert.equal(resultJson.outcome, 'passed');
});

test('mid-failure: stage 2 throws, stage 3 never runs, result failed but does not throw', async () => {
  const dataDir = join(root, 'mid-failure');
  const folder = new RunFolder(dataDir, '2026-07-21');
  const { ctx } = fakeCtx();

  let stage3Called = false;

  const stage1: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage1',
    async run(input) {
      return { jobs: [...input.jobs, makeJD('a')], dropped: input.dropped };
    },
  });
  const stage2: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage2',
    async run() {
      throw new Error('boom');
    },
  });
  const stage3: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage3',
    async run(input) {
      stage3Called = true;
      return input;
    },
  });

  const result = await runPipeline([stage1, stage2, stage3], ctx, folder, {
    runCapMs: 5_000,
    stallMs: 5_000,
    resume: false,
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.failedStage, 'stage2');
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0]?.name, 'stage1');
  assert.equal(stage3Called, false);

  const failure = JSON.parse(await readFile(join(folder.dir, 'failure.json'), 'utf8'));
  assert.equal(failure.stage, 'stage2');
  assert.ok(typeof failure.error === 'string' && failure.error.length > 0);
  assert.ok(typeof failure.elapsedMs === 'number');

  const resultJson = JSON.parse(await readFile(join(folder.dir, 'result.json'), 'utf8'));
  assert.equal(resultJson.outcome, 'failed');
});

test('resume: fast-forwards past the latest checkpoint and reuses its payload', async () => {
  const dataDir = join(root, 'resume');
  const folder = new RunFolder(dataDir, '2026-07-21');
  const { ctx } = fakeCtx();

  let stage0Called = false;
  let stage1Input: StagePayload | undefined;

  const checkpointPayload: StagePayload = { jobs: [makeJD('seed')], dropped: [] };
  await folder.writeCheckpoint(0, 'stage0', checkpointPayload);

  const stage0: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage0',
    async run(input) {
      stage0Called = true;
      return input;
    },
  });
  const stage1: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage1',
    async run(input) {
      stage1Input = input;
      return { jobs: [...input.jobs, makeJD('b')], dropped: input.dropped };
    },
  });
  const stage2: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage2',
    async run(input) {
      return input;
    },
  });

  const result = await runPipeline([stage0, stage1, stage2], ctx, folder, {
    runCapMs: 5_000,
    stallMs: 5_000,
    resume: true,
  });

  assert.equal(stage0Called, false);
  assert.deepEqual(stage1Input, checkpointPayload);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0]?.name, 'stage1');
  assert.equal(result.stages[1]?.name, 'stage2');
});

test('run-cap: a hanging stage is killed at runCapMs and result is failed (no throw)', async () => {
  const dataDir = join(root, 'run-cap');
  const folder = new RunFolder(dataDir, '2026-07-21');
  const { ctx } = fakeCtx();

  const hanging: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'hanging',
    timeoutMs: 5_000, // per-stage timeout must not be what fires first
    async run() {
      // deliberately ignores its own signal — only the run cap should kill it.
      await delay(2_000);
      return { jobs: [], dropped: [] };
    },
  });

  const started = Date.now();
  const result = await runPipeline([hanging], ctx, folder, {
    runCapMs: 40,
    stallMs: 5_000,
    resume: false,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'failed');
  assert.equal(result.failedStage, 'hanging');
  assert.ok(elapsed < 500, `expected run-cap kill near 40ms, took ${elapsed}ms`);
});
