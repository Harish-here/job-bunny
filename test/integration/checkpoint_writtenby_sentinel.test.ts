/**
 * test/integration/checkpoint_writtenby_sentinel.test.ts — lives OUTSIDE
 * `src/` (mirrors `test/integration/daemon_restart_owed.test.ts`'s own
 * placement) precisely so it can exercise the REAL cross-layer path:
 * `cli/commands/stage.ts` driven against a REAL `SqliteCheckpointStore`
 * (`adapters/db/sqlite/checkpoints`) over a real on-disk `jobbunny.db`,
 * with `PRAGMA foreign_keys = ON` enforced by the same migration every
 * profile runs under. `dependency-cruiser`'s `includeOnly: '^src'` never
 * cruises this file, so it is free to import both `cli/commands` and
 * `adapters` the way no file under `src/` may (`only-wire-imports-adapters`).
 *
 * Regression this pins: `RunStore.startRun` returns the documented
 * degraded-store sentinel `-1` (ports/run_store.ts) when the run-observability
 * store failed to open. `checkpoints.written_by` is a real FK against
 * `runs(id)` — no row with id -1 ever exists — so a CLI driver that
 * assigns the sentinel into `ctx.runId`/`writtenBy` unguarded makes every
 * checkpoint write throw `FOREIGN KEY constraint failed`, failing an
 * otherwise-healthy run. `RunStore`'s own contract is "observability must
 * never red a run" — this must hold even when the store is degraded.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SqliteCheckpointStore } from '../../src/adapters/db/sqlite/checkpoints/index.ts';
import { openJobsDb } from '../../src/adapters/db/sqlite/store/index.ts';
import { stageCommand } from '../../src/cli/commands/stage.ts';
import type { PipelineCtx } from '../../src/pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../src/pipeline/runner/stage.ts';
import type { RunEventRow, RunFailure, RunStore } from '../../src/ports/run_store.ts';

/** A `RunStore` degraded exactly the way `SqliteRunStore` degrades when its
 * underlying db failed to open: `startRun` returns the documented sentinel
 * `-1`; every other writer is a no-op (harmless per the port's own
 * contract — `heartbeat`/`finishRun`/`recordFailure` are no-ops on the real
 * degraded adapter too). */
function degradedRunStore(): RunStore {
  return {
    startRun: () => -1,
    appendEvents: () => {},
    heartbeat: () => {},
    recordFailure: (_runId: number, _failure: RunFailure) => {},
    recordSyncDryrun: () => {},
    finishRun: () => {},
    listRuns: () => [],
    getRun: () => null,
    listEvents: (): RunEventRow[] => [],
    findRunId: () => null,
    listRunTimeDirs: (): string[] => [],
    pruneRunsOlderThan: () => 0,
    close: () => {},
  };
}

function makeStage(
  name: string,
  run: (input: StagePayload) => Promise<StagePayload>,
): StageDef<StagePayload, StagePayload> {
  return { name, timeoutMs: 5_000, retries: 0, run };
}

test('stageCommand: a degraded run store returning startRun() === -1 never propagates the sentinel into checkpoints.written_by (a real FK against runs(id))', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-writtenby-sentinel-'));
  const dbPath = path.join(dir, 'jobbunny.db');
  const checkpointStore = new SqliteCheckpointStore(dbPath);
  const now = new Date('2026-08-06T00:00:00Z');
  const stages = [makeStage('compress', async () => ({ jobs: [{ id: 'a' }] as never, dropped: [] }))];

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
    config: { settings: {} } as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    runStore: degradedRunStore(),
    checkpointStore,
    async notify() {},
  };

  try {
    const code = await stageCommand(
      { profile: 'rajni', stage: 'compress' },
      {
        wire: async () => ({ ctx, stages, routines: [], checks: [] }),
        now: () => now,
        write: () => {},
      },
    );

    // Post-fix: the run passes and the sentinel never reaches the FK column.
    assert.equal(code, 0);
    const db = openJobsDb(dbPath);
    const row = db
      .prepare('SELECT written_by FROM checkpoints WHERE stage = ?')
      .get('compress') as { written_by: number | null } | undefined;
    db.close();
    assert.equal(row?.written_by, null);
  } finally {
    checkpointStore.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
