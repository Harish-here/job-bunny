/**
 * reconcile.test.ts (P8) — TDD for `reconcileCommand`. Every dependency
 * (`wire`, `runPipeline`, `now`) is FAKE except a REAL `RunFolder` rooted
 * at a temp dir — mirrors run.test.ts's convention that the folder itself
 * is real (cheap, no adapter) while everything else is a stub.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { RunResult } from '../../ops/observability/result.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { Storage } from '../../ports/storage.ts';
import { reconcileCommand } from './reconcile.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-reconcile-cmd-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function passedResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    profile: 'rajni',
    date: '2026-07-25',
    outcome: 'passed',
    stages: [
      {
        name: 'reconcile',
        elapsedMs: 1,
        attempts: 1,
        jobsIn: 0,
        jobsOut: 0,
        dropsByRule: {},
      },
    ],
    ...overrides,
  };
}

function fakeStorage(store: Map<string, unknown>): Storage {
  return {
    async readJson<T>(relPath: string, schema: { parse(v: unknown): T }) {
      if (!store.has(relPath)) return undefined;
      return schema.parse(store.get(relPath));
    },
    async writeJson(relPath: string, value: unknown) {
      store.set(relPath, value);
    },
  };
}

function fakeCtx(store: Map<string, unknown>): PipelineCtx {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: fakeStorage(store),
    config: {} as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    async notify(_event: NotifyEvent) {},
  };
}

const reconcileStage: StageDef<StagePayload, StagePayload> = {
  name: 'reconcile',
  timeoutMs: 1000,
  retries: 0,
  async run(input) {
    return input;
  },
};

const otherStage: StageDef<StagePayload, StagePayload> = {
  name: 'compress',
  timeoutMs: 1000,
  retries: 0,
  async run(input) {
    return input;
  },
};

test('reconcileCommand: finds the reconcile stage by name, not by array index', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);
  let observedStages: Array<StageDef<StagePayload, StagePayload>> | undefined;

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({
        ctx,
        stages: [otherStage, reconcileStage],
        routines: [],
        checks: [],
      }),
      runPipeline: async (stages) => {
        observedStages = stages;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(observedStages?.length, 1);
  assert.equal(observedStages?.[0]?.name, 'reconcile');
});

test('reconcileCommand: prints the rebuilt cache entry count and returns 0 on success', async () => {
  const store = new Map<string, unknown>([
    [
      'cache/entries.json',
      [
        { id: 'li-1', company: 'Acme', title: 'Engineer', pageId: 'page-1' },
        { id: 'li-2', company: 'Acme', title: 'Designer', pageId: 'page-2' },
      ],
    ],
  ]);
  const ctx = fakeCtx(store);
  const lines: string[] = [];

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes('reconcile') && l.includes('2 entries')));
});

test('reconcileCommand: a failed outcome prints the failure and returns 1', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);
  const lines: string[] = [];

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
      runPipeline: async () =>
        passedResult({ outcome: 'failed', failedStage: 'reconcile', stages: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('failed')));
});

test('reconcileCommand: throws when wire() lacks a "reconcile" stage', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);

  await assert.rejects(
    () =>
      reconcileCommand(
        { profile: 'rajni' },
        {
          wire: async () => ({ ctx, stages: [otherStage], routines: [], checks: [] }),
          runPipeline: async () => passedResult(),
          now: () => new Date('2026-07-25T00:00:00Z'),
          root,
          write: () => {},
        },
      ),
    /"reconcile" stage/,
  );
});
