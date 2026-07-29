/**
 * stage.test.ts (P8) — TDD for `stageCommand`. `wire` is FAKE; the
 * `RunFolder` is REAL (rooted at a temp dir) so checkpoint read/write is
 * exercised for real, matching run.test.ts's / reconcile.test.ts's
 * convention.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { formatRunTime, RunFolder } from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import { stageCommand } from './stage.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-stage-cmd-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeCtx(): PipelineCtx {
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
    config: {} as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    async notify(_event: NotifyEvent) {},
  };
}

function makeStage(
  name: string,
  run: (input: StagePayload) => Promise<StagePayload>,
): StageDef<StagePayload, StagePayload> {
  return { name, timeoutMs: 5_000, retries: 0, run };
}

test('stageCommand: unknown stage name prints valid names and returns 1 (no throw)', async () => {
  const lines: string[] = [];
  const stages = [
    makeStage('compress', async (i) => i),
    makeStage('assemble', async (i) => i),
  ];

  const code = await stageCommand(
    { profile: 'rajni', stage: 'nope' },
    {
      wire: async () => ({ ctx: fakeCtx(), stages, routines: [], checks: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 1);
  assert.ok(lines[0]?.includes('nope'));
  assert.ok(lines[0]?.includes('compress'));
  assert.ok(lines[0]?.includes('assemble'));
});

test('stageCommand: runs from the empty seed payload when no checkpoint exists, creates a fresh time folder, checkpoints at the real index, prints the funnel line', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const lines: string[] = [];
  let observedInput: StagePayload | undefined;
  const stages = [
    makeStage('reconcile', async (i) => i),
    makeStage('compress', async (i) => {
      observedInput = i;
      return { jobs: [{ id: 'a' }] as never, dropped: [] };
    }),
  ];
  const now = new Date('2026-07-25T00:00:00Z');

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx: fakeCtx(), stages, routines: [], checks: [] }),
      now: () => now,
      root,
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(observedInput, { jobs: [], dropped: [] });

  // No folder existed today — a fresh one is created at the current local
  // HH-MM, per `formatRunTime`.
  const folder = new RunFolder(
    join(root, 'profiles', profile, 'data'),
    '2026-07-25',
    formatRunTime(now),
  );
  const raw = await readFile(folder.checkpointPath(1, 'compress'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: [{ id: 'a' }], dropped: [] });

  assert.ok(lines.some((l) => l.startsWith('compress: 0 -> 1')));
});

test('stageCommand: resumes from the latest checkpoint rather than the empty seed', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const folder = new RunFolder(
    join(root, 'profiles', profile, 'data'),
    '2026-07-25',
    '09-00',
  );
  await folder.writeCheckpoint(0, 'reconcile', {
    jobs: [{ id: 'seeded' }],
    dropped: [],
  });

  let observedInput: StagePayload | undefined;
  const stages = [
    makeStage('reconcile', async (i) => i),
    makeStage('compress', async (i) => {
      observedInput = i;
      return i;
    }),
  ];

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx: fakeCtx(), stages, routines: [], checks: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(observedInput, { jobs: [{ id: 'seeded' }], dropped: [] });
});

test("stageCommand: continues in TODAY's existing time folder (not the current formatted time) and writes its new checkpoint there", async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const dataDir = join(root, 'profiles', profile, 'data');
  // An earlier folder from today, at a time far from whatever
  // `formatRunTime(now)` would produce right now.
  const earlier = new RunFolder(dataDir, '2026-07-25', '03-17');
  await earlier.writeCheckpoint(0, 'reconcile', { jobs: [], dropped: [] });

  const stages = [
    makeStage('reconcile', async (i) => i),
    makeStage('compress', async (i) => ({
      jobs: [...i.jobs, { id: 'x' }] as never,
      dropped: i.dropped,
    })),
  ];

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx: fakeCtx(), stages, routines: [], checks: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  const raw = await readFile(earlier.checkpointPath(1, 'compress'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: [{ id: 'x' }], dropped: [] });
});
