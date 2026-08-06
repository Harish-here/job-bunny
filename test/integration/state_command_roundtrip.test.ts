/**
 * test/integration/state_command_roundtrip.test.ts — lives OUTSIDE `src/`
 * (mirrors `test/integration/checkpoint_writtenby_sentinel.test.ts`'s own
 * placement) precisely so it can exercise the REAL cross-layer path:
 * `cli/commands/state.ts`'s `stateCommand` driven against a REAL
 * `SqliteStateStore` (`adapters/db/sqlite/state`) over a real on-disk
 * `jobbunny.db`. `dependency-cruiser`'s `includeOnly: '^src'` never cruises
 * this file, so it is free to import both `cli/commands` and `adapters` the
 * way no file under `src/` may (`only-wire-imports-adapters`).
 *
 * Pins the plan's own explicit requirement: `state write decisions` then
 * `state read decisions` must round-trip a multi-line markdown table
 * BYTE-FOR-BYTE through a real store — `assert.equal` (string identity),
 * not `deepEqual`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SqliteStateStore } from '../../src/adapters/db/sqlite/state/index.ts';
import { stateCommand } from '../../src/cli/commands/state.ts';
import type { PipelineCtx } from '../../src/pipeline/runner/context.ts';

test('state write decisions then state read decisions round-trips a multi-line markdown table byte-for-byte through a real SqliteStateStore', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-state-cmd-roundtrip-'));
  const dbPath = path.join(dir, 'jobbunny.db');
  const dataDir = path.join(dir, 'data');
  const stateStore = new SqliteStateStore(dbPath, dataDir);

  const original =
    '| id | verdict | reason |\n' +
    '| li-1 | pass | strong fit |\n' +
    '| li-2 | drop | wrong location |\n' +
    '\n';

  const ctx: PipelineCtx = {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {
      async readJson() {
        return undefined;
      },
      async writeJson() {},
      async listSubdirs() {
        return [];
      },
      async removeTree() {},
    },
    stateStore,
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
    async notify() {},
  };

  try {
    const writeCode = await stateCommand(
      { profile: 'rajni', action: 'write', key: 'decisions' },
      {
        wire: async () => ({ ctx, stages: [], routines: [], checks: [] }),
        readStdin: async () => original,
      },
    );
    assert.equal(writeCode, 0);

    let readBack: string | undefined;
    const readCode = await stateCommand(
      { profile: 'rajni', action: 'read', key: 'decisions' },
      {
        wire: async () => ({ ctx, stages: [], routines: [], checks: [] }),
        writeRaw: (text) => {
          readBack = text;
        },
      },
    );
    assert.equal(readCode, 0);
    assert.equal(readBack, original);
  } finally {
    // Windows enforces file locks that macOS/Linux don't: an open
    // `node:sqlite` `DatabaseSync` handle in a directory makes `rmSync`
    // fail EPERM instead of silently succeeding. Close the real store
    // before removing its temp dir — precedent:
    // `src/adapters/db/sqlite/state/store.test.ts`.
    stateStore.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
