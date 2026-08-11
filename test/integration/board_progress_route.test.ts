/**
 * test/integration/board_progress_route.test.ts — lives OUTSIDE `src/`
 * (mirrors `test/integration/daemon_restart_owed.test.ts`'s own placement)
 * precisely so it can exercise the REAL cross-layer read path end to end:
 * `app/features/runs/routes.ts`'s `makeRunsRoutes` route handler, wired to
 * a REAL `SqliteBoardStore` (`adapters/db/sqlite/board`) opened over a real
 * on-disk `jobbunny.db` that a REAL `SqliteRunStore`
 * (`adapters/db/sqlite/runs`) wrote `run_progress` rows into.
 * `dependency-cruiser`'s `includeOnly: '^src'` never cruises this file, so
 * it is free to import both `app` and `adapters` the way no file under
 * `src/` may (`only-wire-imports-adapters`/`app-only-ports-core`) — the
 * same carve-out documented for `daemon_restart_owed.test.ts`.
 *
 * Regression this pins (fix-round [critical] finding #5): `SqliteBoardStore`
 * — the ONLY store `wireBoard()`'s `openStore` ever constructs for the
 * board server's HTTP surface — used to hardcode `progress: null` on every
 * row with a comment reading "progress display is a later task", even
 * though the runner writes a live `run_progress` row every stage
 * transition. `GET /api/profiles/:name/runs` must surface that row, not
 * silently discard it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openJobsDb, SqliteBoardStore, SqliteRunStore } from '../../src/adapters/db/sqlite/index.ts';
import { makeRunsRoutes } from '../../src/app/features/runs/index.ts';
import type { BoardRequest } from '../../src/app/shared/index.ts';
import type { BoardSource, BoardStore } from '../../src/ports/board.ts';

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

/** A `BoardSource` whose `openStore` returns the ONE real store under
 * test — every other method throws, since `makeRunsRoutes`'s handlers
 * never call them. */
function sourceFor(store: BoardStore): BoardSource {
  const unused = () => {
    throw new Error('not used by runs routes');
  };
  return {
    listProfiles: unused,
    openStore: async (name) => (name === 'rajni' ? store : null),
    readConfigDoc: unused,
    writeConfigDoc: unused,
    createProfile: unused,
    runDoctor: unused,
    readDaemonStatus: unused,
    openIntents: unused,
    listSecrets: unused,
    writeSecret: unused,
    removeProfile: unused,
    close: () => {},
  } as unknown as BoardSource;
}

test('GET /api/profiles/:name/runs surfaces a real run_progress row through the real SqliteBoardStore-backed route handler', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-board-progress-route-'));
  const dbPath = path.join(dir, 'jobbunny.db');
  try {
    const runStore = new SqliteRunStore(dbPath);
    const runId = runStore.startRun({
      date: '2026-08-10',
      timeDir: '09-00',
      kind: 'run',
      startedAt: '2026-08-10T09:00:00.000Z',
    });
    runStore.recordProgress(runId, {
      stage: 'structure',
      stageIndex: 5,
      stageTotal: 10,
      stageStartedAt: '2026-08-10T09:03:00.000Z',
    });
    runStore.close();

    const board = new SqliteBoardStore(openJobsDb(dbPath));
    const routes = makeRunsRoutes(sourceFor(board));
    const listRoute = routes.find(
      (r) => r.method === 'GET' && r.path === '/api/profiles/:name/runs',
    );
    assert.ok(listRoute, 'no GET /api/profiles/:name/runs route registered');

    const res = await listRoute.handler(req({ params: { name: 'rajni' } }));
    assert.equal(res.status, 200);
    const body = res.body as {
      rows: Array<{
        id: number;
        progress: {
          stage: string;
          stageIndex: number;
          stageTotal: number;
          stageStartedAt: string;
          updatedAt: string;
          itemCurrent: number | null;
          itemTotal: number | null;
        } | null;
      }>;
    };
    assert.equal(body.rows.length, 1);
    const row = body.rows[0];
    assert.ok(row);
    assert.notEqual(row.progress, null);
    const progress = row.progress;
    assert.ok(progress);
    assert.deepEqual(progress, {
      stage: 'structure',
      stageIndex: 5,
      stageTotal: 10,
      stageStartedAt: '2026-08-10T09:03:00.000Z',
      updatedAt: progress.updatedAt,
      itemCurrent: null,
      itemTotal: null,
    });

    board.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
