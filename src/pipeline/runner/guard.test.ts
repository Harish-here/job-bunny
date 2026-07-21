import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Connector, Storage } from '../../ports/index.ts';
import type { PipelineCtx, WiredPorts } from './context.ts';
import { guardStage } from './guard.ts';
import type { StageContext, StageDef } from './stage.ts';

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

/** Builds a fake PipelineCtx with a controllable run-level AbortController
 * and a spy `beat()`. Tests can abort `controller` to simulate a
 * run-level cancellation. */
function fakeCtx(controller: AbortController = new AbortController()): {
  ctx: PipelineCtx;
  controller: AbortController;
  beats: number[];
} {
  const beats: number[] = [];
  const ctx: PipelineCtx = {
    profile: 'rajni',
    signal: controller.signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {
      beats.push(Date.now());
    },
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
  return { ctx, controller, beats };
}

function fakeStage<In, Out>(
  overrides: Partial<StageDef<In, Out>> & Pick<StageDef<In, Out>, 'run'>,
): StageDef<In, Out> {
  return {
    name: 'fake-stage',
    timeoutMs: 40,
    retries: 0,
    ...overrides,
  };
}

test('a stage that hangs past timeoutMs (ignoring its signal) is killed', async () => {
  const started = Date.now();
  const stage = fakeStage<undefined, string>({
    timeoutMs: 40,
    retries: 0,
    async run() {
      // deliberately ignores its own ctx.signal — must still be killed by
      // guardStage racing against AbortSignal.timeout.
      await delay(500);
      return 'never';
    },
  });
  const { ctx } = fakeCtx();

  await assert.rejects(() => guardStage(stage, undefined, ctx, { stallMs: 1_000 }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `expected kill near timeoutMs(40ms), took ${elapsed}ms`);
});

test('heartbeat stage beating faster than stallMs survives and completes', async () => {
  const stage = fakeStage<undefined, string>({
    timeoutMs: 1_000,
    retries: 0,
    heartbeat: true,
    async run(_input, ctx: StageContext) {
      for (let i = 0; i < 4; i += 1) {
        await delay(15);
        ctx.beat();
      }
      return 'ok';
    },
  });
  const { ctx, beats } = fakeCtx();

  const result = await guardStage(stage, undefined, ctx, { stallMs: 40 });
  assert.equal(result.output, 'ok');
  assert.equal(result.attempts, 1);
  assert.ok(beats.length >= 4);
});

test('heartbeat stage that stops beating is killed after stallMs', async () => {
  const started = Date.now();
  const stage = fakeStage<undefined, string>({
    timeoutMs: 1_000,
    retries: 0,
    heartbeat: true,
    async run(_input, ctx: StageContext) {
      ctx.beat(); // one beat, then goes silent
      await delay(500);
      return 'never';
    },
  });
  const { ctx } = fakeCtx();

  await assert.rejects(() => guardStage(stage, undefined, ctx, { stallMs: 40 }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `expected stall kill near stallMs(40ms), took ${elapsed}ms`);
});

test('a stage that throws on attempt 1 but succeeds on attempt 2 resolves with attempts=2', async () => {
  let calls = 0;
  const stage = fakeStage<undefined, string>({
    timeoutMs: 200,
    retries: 1,
    async run() {
      calls += 1;
      if (calls === 1) throw new Error('transient failure');
      return 'ok-on-retry';
    },
  });
  const { ctx } = fakeCtx();

  const result = await guardStage(stage, undefined, ctx, { stallMs: 1_000 });
  assert.equal(result.output, 'ok-on-retry');
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('run-level ctx.signal abort cancels immediately and does not retry', async () => {
  let calls = 0;
  const controller = new AbortController();
  const stage = fakeStage<undefined, string>({
    timeoutMs: 5_000,
    retries: 3,
    async run(_input, stageCtx: StageContext) {
      calls += 1;
      // simulate a well-behaved stage that reacts to abort, but slowly
      // enough that the guard's own abort-race must be what wins.
      await delay(500, undefined, { signal: stageCtx.signal }).catch(() => {});
      throw new Error('should not get here');
    },
  });
  const { ctx } = fakeCtx(controller);

  const started = Date.now();
  const pending = guardStage(stage, undefined, ctx, { stallMs: 1_000 });
  controller.abort(new Error('run cancelled'));

  await assert.rejects(pending, /run cancelled/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `expected prompt cancellation, took ${elapsed}ms`);
  assert.equal(calls, 1, 'stage.run must not be re-invoked after a run-level abort');
});

test('run-level ctx.signal already aborted before guardStage is called cancels without invoking run', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  const stage = fakeStage<undefined, string>({
    timeoutMs: 5_000,
    retries: 3,
    async run() {
      calls += 1;
      return 'never';
    },
  });
  const { ctx } = fakeCtx(controller);

  await assert.rejects(
    () => guardStage(stage, undefined, ctx, { stallMs: 1_000 }),
    /already cancelled/,
  );
  assert.equal(calls, 0);
});

test('non-heartbeat stage with no beats runs to completion without a spurious stall kill', async () => {
  const stage = fakeStage<undefined, string>({
    timeoutMs: 200,
    retries: 0,
    heartbeat: false,
    async run() {
      await delay(60); // longer than a would-be short stallMs, but no heartbeat armed
      return 'done';
    },
  });
  const { ctx } = fakeCtx();

  const result = await guardStage(stage, undefined, ctx, { stallMs: 5 });
  assert.equal(result.output, 'done');
  assert.equal(result.attempts, 1);
});
