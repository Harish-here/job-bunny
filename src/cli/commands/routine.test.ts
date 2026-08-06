/**
 * routine.test.ts (P8) — TDD for `routineCommand`. `wire` is FAKE; one
 * test runs the REAL `cleanupRoutine` against a fake `Connector` to assert
 * (in the spirit of `routines/cleanup/cleanup.test.ts`'s own assertion)
 * that this command forwards no dryRun-ish argument of its own — dry-run
 * stays entirely the connector's call.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineCtx, WiredPorts } from '../../pipeline/runner/context.ts';
import type {
  ArchivePolicy,
  Connector,
  RunContext,
  RunStore,
} from '../../ports/index.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import { cleanupRoutine } from '../../routines/cleanup/index.ts';
import type { Routine } from '../../routines/types.ts';
import { routineCommand } from './routine.ts';

function fakeConnector(): Connector & { archiveCalls: ArchivePolicy[] } {
  const archiveCalls: ArchivePolicy[] = [];
  return {
    name: 'fake',
    archiveCalls,
    async rebuildCache() {
      return [];
    },
    async syncJobs(jobs) {
      return jobs.map((jd) => ({ ...jd, sync: { pageId: 'x', syncedAt: 'now' } }));
    },
    async archiveStale(policy: ArchivePolicy, _ctx: RunContext) {
      archiveCalls.push(policy);
      return { archived: 3, dropped: [] };
    },
  };
}

/** Stub `RunStore` — this file's real-`cleanupRoutine` test needs
 * `pruneRunsOlderThan` to exist (called unconditionally); no test here
 * asserts on its call args, so every other method is a no-op stub. */
function fakeRunStore(): RunStore {
  return {
    startRun() {
      return -1;
    },
    appendEvents() {},
    heartbeat() {},
    recordFailure() {},
    recordSyncDryrun() {},
    finishRun() {},
    listRuns() {
      return [];
    },
    getRun() {
      return null;
    },
    listEvents() {
      return [];
    },
    findRunId() {
      return null;
    },
    pruneRunsOlderThan() {
      return 0;
    },
    close() {},
  };
}

function fakeCtx(connector: Connector): PipelineCtx {
  const ports: WiredPorts = { lanes: [], connector, notifiers: [] };
  return {
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
    config: {
      lanes: [],
      connector: 'notion',
      notifiers: [],
      routines: ['cleanup'],
      settings: {},
    },
    ports,
    runStore: fakeRunStore(),
    checkpointStore: {} as PipelineCtx['checkpointStore'],
    async notify(_event: NotifyEvent) {},
  };
}

function fakeRoutine(name: string, calls: unknown[][]): Routine {
  return {
    name,
    when: 'standalone',
    async run(...args: unknown[]) {
      calls.push(args);
    },
  };
}

test('routineCommand: unknown routine name prints valid names and returns 1 (no throw)', async () => {
  const lines: string[] = [];
  const ctx = fakeCtx(fakeConnector());

  const code = await routineCommand(
    { profile: 'rajni', routine: 'nope' },
    {
      wire: async () => ({ ctx, stages: [], routines: [cleanupRoutine], checks: [] }),
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 1);
  assert.ok(lines[0]?.includes('nope'));
  assert.ok(lines[0]?.includes('cleanup'));
});

test('routineCommand: runs the named routine against ctx and returns 0', async () => {
  const calls: unknown[][] = [];
  const routine = fakeRoutine('cleanup', calls);
  const ctx = fakeCtx(fakeConnector());
  const lines: string[] = [];

  const code = await routineCommand(
    { profile: 'rajni', routine: 'cleanup' },
    {
      wire: async () => ({ ctx, stages: [], routines: [routine], checks: [] }),
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 1);
  assert.equal(calls[0]?.[0], ctx);
  assert.ok(lines.some((l) => l.includes('cleanup') && l.includes('done')));
});

test('routineCommand: running the REAL cleanupRoutine passes no dryRun-ish argument — dry-run stays connector-owned', async () => {
  const connector = fakeConnector();
  const ctx = fakeCtx(connector);

  const code = await routineCommand(
    { profile: 'rajni', routine: 'cleanup' },
    {
      wire: async () => ({ ctx, stages: [], routines: [cleanupRoutine], checks: [] }),
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(connector.archiveCalls.length, 1);
  assert.deepEqual(Object.keys(connector.archiveCalls[0] ?? {}).sort(), [
    'passedOlderThanDays',
    'untouchedOlderThanDays',
  ]);
});
