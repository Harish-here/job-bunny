import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { RunFolder } from './run_folder.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-run-folder-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('checkpointPath zero-pads the index into NN-<stage>.json', () => {
  const folder = new RunFolder(join(root, 'p1'), '2026-07-21');
  assert.equal(
    folder.checkpointPath(1, 'farm'),
    join(root, 'p1', 'runs', '2026-07-21', '01-farm.json'),
  );
  assert.equal(
    folder.checkpointPath(12, 'sync'),
    join(root, 'p1', 'runs', '2026-07-21', '12-sync.json'),
  );
});

test('writeCheckpoint writes atomically and leaves no .tmp file', async () => {
  const folder = new RunFolder(join(root, 'p2'), '2026-07-21');
  await folder.writeCheckpoint(1, 'farm', { jobs: [], dropped: [] });
  const raw = await readFile(folder.checkpointPath(1, 'farm'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: [], dropped: [] });
  await assert.rejects(() => readFile(`${folder.checkpointPath(1, 'farm')}.tmp`));
});

test('readLatestCheckpoint returns undefined when no checkpoints exist', async () => {
  const folder = new RunFolder(join(root, 'p3'), '2026-07-21');
  const latest = await folder.readLatestCheckpoint();
  assert.equal(latest, undefined);
});

test('readLatestCheckpoint picks the highest-index checkpoint', async () => {
  const folder = new RunFolder(join(root, 'p4'), '2026-07-21');
  await folder.writeCheckpoint(1, 'farm', { jobs: ['a'], dropped: [] });
  await folder.writeCheckpoint(2, 'compress', { jobs: ['b'], dropped: [] });
  await folder.writeCheckpoint(10, 'sync', { jobs: ['c'], dropped: [] });
  const latest = await folder.readLatestCheckpoint();
  assert.deepEqual(latest, {
    index: 10,
    stage: 'sync',
    payload: { jobs: ['c'], dropped: [] },
  });
});

test('writeHeartbeat writes {stage, at}', async () => {
  const folder = new RunFolder(join(root, 'p5'), '2026-07-21');
  await folder.writeHeartbeat('extract');
  const raw = await readFile(
    join(root, 'p5', 'runs', '2026-07-21', 'heartbeat.json'),
    'utf8',
  );
  const parsed = JSON.parse(raw);
  assert.equal(parsed.stage, 'extract');
  assert.equal(typeof parsed.at, 'string');
});

test('writeFailure writes the failure record', async () => {
  const folder = new RunFolder(join(root, 'p6'), '2026-07-21');
  await folder.writeFailure({ stage: 'extract', error: 'boom', elapsedMs: 42 });
  const raw = await readFile(
    join(root, 'p6', 'runs', '2026-07-21', 'failure.json'),
    'utf8',
  );
  assert.deepEqual(JSON.parse(raw), { stage: 'extract', error: 'boom', elapsedMs: 42 });
});

test('writeResult writes the run result', async () => {
  const folder = new RunFolder(join(root, 'p7'), '2026-07-21');
  const result = {
    profile: 'rajni',
    date: '2026-07-21',
    outcome: 'passed' as const,
    stages: [],
  };
  await folder.writeResult(result);
  const raw = await readFile(
    join(root, 'p7', 'runs', '2026-07-21', 'result.json'),
    'utf8',
  );
  assert.deepEqual(JSON.parse(raw), result);
});

test('logPath returns run.log under the run folder', () => {
  const folder = new RunFolder(join(root, 'p8'), '2026-07-21');
  assert.equal(folder.logPath(), join(root, 'p8', 'runs', '2026-07-21', 'run.log'));
});
