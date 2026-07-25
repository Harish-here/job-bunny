/**
 * run.test.ts (P8) — TDD for `runCommand`. Every dependency (`wire`,
 * `runPipeline`, `now`) is FAKE — no real adapter, no real filesystem
 * write outside a fake `RunFolder`-shaped stub is exercised here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunResult } from '../../ops/observability/result.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { Routine } from '../../routines/types.ts';
import { runCommand } from './run.ts';

function passedResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    profile: 'rajni',
    date: '2026-07-25',
    outcome: 'passed',
    stages: [],
    ...overrides,
  };
}

function fakeCtx(notified: NotifyEvent[]): PipelineCtx {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {} as PipelineCtx['storage'],
    config: {} as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    async notify(event: NotifyEvent) {
      notified.push(event);
    },
  };
}

function fakeRoutine(name: string, when: Routine['when'], calls: string[]): Routine {
  return {
    name,
    when,
    async run() {
      calls.push(name);
    },
  };
}

const FAKE_STAGES: Array<StageDef<StagePayload, StagePayload>> = [];

test('runCommand: a passed run sends the digest once, runs pre-run and post-sync routines, and returns 0', async () => {
  const notified: NotifyEvent[] = [];
  const calls: string[] = [];
  const ctx = fakeCtx(notified);
  const routines: Routine[] = [
    fakeRoutine('preflight', 'pre-run', calls),
    fakeRoutine('cleanup', 'post-sync', calls),
  ];

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines, checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
    },
  );

  assert.equal(code, 0);
  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.kind, 'digest');
  assert.deepEqual(calls, ['preflight', 'cleanup']);
});

test('runCommand: a failed run still sends the digest, does NOT run post-sync routines, and returns 1', async () => {
  const notified: NotifyEvent[] = [];
  const calls: string[] = [];
  const ctx = fakeCtx(notified);
  const routines: Routine[] = [
    fakeRoutine('preflight', 'pre-run', calls),
    fakeRoutine('cleanup', 'post-sync', calls),
  ];

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines, checks: [] }),
      runPipeline: async () =>
        passedResult({ outcome: 'failed', failedStage: 'extract' }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
    },
  );

  assert.equal(code, 1);
  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.kind, 'digest');
  assert.deepEqual(calls, ['preflight']);
});

test('runCommand: pre-run routines always run before runPipeline is called', async () => {
  const notified: NotifyEvent[] = [];
  const calls: string[] = [];
  const ctx = fakeCtx(notified);
  const routines: Routine[] = [fakeRoutine('preflight', 'pre-run', calls)];

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines, checks: [] }),
      runPipeline: async () => {
        assert.deepEqual(calls, ['preflight']);
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
    },
  );

  assert.equal(code, 0);
});

test('runCommand: --dry-run threads a syncDryRunPath keyed to the run date into wire()', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let receivedOverrides: unknown;

  const code = await runCommand(
    { profile: 'rajni', dryRun: true },
    {
      wire: async (_profile, overrides) => {
        receivedOverrides = overrides;
        return { ctx, stages: FAKE_STAGES, routines: [], checks: [] };
      },
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(receivedOverrides, {
    syncDryRunPath: 'profiles/rajni/data/runs/2026-07-25/sync_dryrun.json',
  });
});

test('runCommand: without --dry-run, wire() gets no overrides', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let receivedOverrides: unknown = 'unset';

  await runCommand(
    { profile: 'rajni' },
    {
      wire: async (_profile, overrides) => {
        receivedOverrides = overrides;
        return { ctx, stages: FAKE_STAGES, routines: [], checks: [] };
      },
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
    },
  );

  assert.equal(receivedOverrides, undefined);
});

test('runCommand: --dry-run makes the digest text reflect the dry run', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);

  await runCommand(
    { profile: 'rajni', dryRun: true },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
    },
  );

  assert.equal(notified.length, 1);
  const text = (notified[0] as { text: string }).text;
  assert.match(text, /DRY RUN/);
});

test('runCommand: overrides ctx.logger with a JsonlLogger before running the pipeline', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let observedLoggerCtor: string | undefined;

  await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async (_stages, runCtx) => {
        observedLoggerCtor = runCtx.logger.constructor.name;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
    },
  );

  assert.equal(observedLoggerCtor, 'JsonlLogger');
});
