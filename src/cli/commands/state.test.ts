/**
 * state.test.ts (P3-Task7) — TDD for `stateCommand`. Every dependency
 * (`wire`, `readStdin`, `writeRaw`, `stderr`) is FAKE; the fake `WireResult`
 * wraps an in-memory `StateStore` fake, NOT a real DB.
 *
 * The plan's mandated REAL temp-dir DB round-trip test (a real
 * `SqliteStateStore` injected via `wire`) lives in
 * `test/integration/state_command_roundtrip.test.ts` instead of here:
 * `only-wire-imports-adapters` (`.dependency-cruiser.cjs`) forbids any file
 * under `src/cli` other than `cli/wire/compose.ts` (and its named siblings)
 * from importing `src/adapters/**` — dependency-cruiser's `includeOnly:
 * '^src'` never cruises `test/`, which is exactly why
 * `test/integration/checkpoint_writtenby_sentinel.test.ts` already lives
 * there for the identical reason (real `SqliteCheckpointStore` driven
 * through `stageCommand`). See that file's own header for the precedent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import {
  DECISIONS_PARTIAL_PATH,
  DECISIONS_PATH,
} from '../../pipeline/stages/structure.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { StateStore } from '../../ports/state_store.ts';
import type { Storage } from '../../ports/storage.ts';
import { stateCommand } from './state.ts';

function fakeStorage(): Storage {
  return {
    async readJson() {
      return undefined;
    },
    async writeJson() {},
    async listSubdirs() {
      return [];
    },
    async removeTree() {},
  };
}

function fakeStateStore(store: Map<string, unknown>): StateStore {
  return {
    async readDoc<T>(key: string, schema: { parse(v: unknown): T }) {
      if (!store.has(key)) return undefined;
      return schema.parse(store.get(key));
    },
    async writeDoc(key: string, value: unknown) {
      store.set(key, value);
    },
    close() {},
  };
}

function fakeCtx(store: Map<string, unknown>): PipelineCtx {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: fakeStorage(),
    stateStore: fakeStateStore(store),
    config: { settings: {} } as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    runStore: {
      startRun: () => 1,
      appendEvents: () => {},
      heartbeat: () => {},
      recordFailure: () => {},
      recordSyncDryrun: () => {},
      finishRun: () => {},
      listRuns: () => [],
      getRun: () => null,
      listEvents: () => [],
      findRunId: () => null,
      listRunTimeDirs: () => [],
      pruneRunsOlderThan: () => 0,
      close: () => {},
    },
    checkpointStore: {
      write() {},
      readLatest() {
        return undefined;
      },
      latestTimeDir() {
        return undefined;
      },
      latestCheckpointTimeDir() {
        return undefined;
      },
      nextTimeDir(_runDate, time) {
        return time;
      },
      pruneOlderThan() {
        return 0;
      },
      close() {},
    },
    async notify(_event: NotifyEvent) {},
  };
}

test('state read table: prints the stored doc raw, byte-for-byte, no injected newline', async () => {
  const store = new Map<string, unknown>([
    ['structure/table.json', '| a | b |\n| 1 | 2 |'],
  ]);
  const ctx = fakeCtx(store);
  const written: string[] = [];

  const code = await stateCommand(
    { profile: 'rajni', action: 'read', key: 'table' },
    {
      wire: async () => ({ ctx, stages: [], routines: [], checks: [] }),
      writeRaw: (text) => written.push(text),
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(written, ['| a | b |\n| 1 | 2 |']);
});

test('state read: unknown/absent doc exits 1 with a stderr message, writes nothing to writeRaw', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);
  const written: string[] = [];
  const errors: string[] = [];

  const code = await stateCommand(
    { profile: 'rajni', action: 'read', key: 'decisions' },
    {
      wire: async () => ({ ctx, stages: [], routines: [], checks: [] }),
      writeRaw: (text) => written.push(text),
      stderr: (line) => errors.push(line),
    },
  );

  assert.equal(code, 1);
  assert.deepEqual(written, []);
  assert.ok(errors.some((l) => l.includes(DECISIONS_PATH)));
});

test('state write decisions: reads stdin fully and writes it via stateStore.writeDoc at the DECISIONS_PATH key', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);

  const code = await stateCommand(
    { profile: 'rajni', action: 'write', key: 'decisions' },
    {
      wire: async () => ({ ctx, stages: [], routines: [], checks: [] }),
      readStdin: async () => '| verdict | reason |\n| pass | fit |\n',
    },
  );

  assert.equal(code, 0);
  assert.equal(store.get(DECISIONS_PATH), '| verdict | reason |\n| pass | fit |\n');
});

test('state write decisions-partial: writes at the DECISIONS_PARTIAL_PATH key', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);

  const code = await stateCommand(
    { profile: 'rajni', action: 'write', key: 'decisions-partial' },
    {
      wire: async () => ({ ctx, stages: [], routines: [], checks: [] }),
      readStdin: async () => '| verdict |\n',
    },
  );

  assert.equal(code, 0);
  assert.equal(store.get(DECISIONS_PARTIAL_PATH), '| verdict |\n');
});

test('state write table: rejected before wire() is ever called', async () => {
  let wireCalled = false;
  const errors: string[] = [];

  const code = await stateCommand(
    { profile: 'rajni', action: 'write', key: 'table' },
    {
      wire: async () => {
        wireCalled = true;
        throw new Error('wire() must never be called for a rejected write');
      },
      stderr: (line) => errors.push(line),
    },
  );

  assert.equal(code, 1);
  assert.equal(wireCalled, false);
  assert.ok(errors.some((l) => l.includes('read-only')));
});

test('stateCommand: bypassing buildOptions with an out-of-band { key: "table", action: "write" } still rejects, defense-in-depth', async () => {
  let wireCalled = false;

  const code = await stateCommand(
    { profile: 'x', action: 'write', key: 'table' },
    {
      wire: async () => {
        wireCalled = true;
        throw new Error('unreachable');
      },
    },
  );

  assert.equal(code, 1);
  assert.equal(wireCalled, false);
});
