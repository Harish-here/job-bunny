import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { formatRunTime, latestTimeDir, nextTimeDir, RunFolder } from './run_folder.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-run-folder-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('checkpointPath zero-pads the index into NN-<stage>.json', () => {
  const folder = new RunFolder(join(root, 'p1'), '2026-07-21', '09-00');
  assert.equal(
    folder.checkpointPath(1, 'farm'),
    join(root, 'p1', 'runs', '2026-07-21', '09-00', '01-farm.json'),
  );
  assert.equal(
    folder.checkpointPath(12, 'sync'),
    join(root, 'p1', 'runs', '2026-07-21', '09-00', '12-sync.json'),
  );
});

test('writeCheckpoint writes atomically and leaves no .tmp file', async () => {
  const folder = new RunFolder(join(root, 'p2'), '2026-07-21', '09-00');
  await folder.writeCheckpoint(1, 'farm', { jobs: [], dropped: [] });
  const raw = await readFile(folder.checkpointPath(1, 'farm'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: [], dropped: [] });
  await assert.rejects(() => readFile(`${folder.checkpointPath(1, 'farm')}.tmp`));
});

test('readLatestCheckpoint returns undefined when no checkpoints exist', async () => {
  const folder = new RunFolder(join(root, 'p3'), '2026-07-21', '09-00');
  const latest = await folder.readLatestCheckpoint();
  assert.equal(latest, undefined);
});

test('readLatestCheckpoint picks the highest-index checkpoint', async () => {
  const folder = new RunFolder(join(root, 'p4'), '2026-07-21', '09-00');
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
  const folder = new RunFolder(join(root, 'p5'), '2026-07-21', '09-00');
  await folder.writeHeartbeat('extract');
  const raw = await readFile(
    join(root, 'p5', 'runs', '2026-07-21', '09-00', 'heartbeat.json'),
    'utf8',
  );
  const parsed = JSON.parse(raw);
  assert.equal(parsed.stage, 'extract');
  assert.equal(typeof parsed.at, 'string');
});

test('writeFailure writes the failure record', async () => {
  const folder = new RunFolder(join(root, 'p6'), '2026-07-21', '09-00');
  await folder.writeFailure({ stage: 'extract', error: 'boom', elapsedMs: 42 });
  const raw = await readFile(
    join(root, 'p6', 'runs', '2026-07-21', '09-00', 'failure.json'),
    'utf8',
  );
  assert.deepEqual(JSON.parse(raw), { stage: 'extract', error: 'boom', elapsedMs: 42 });
});

test('writeResult writes the run result', async () => {
  const folder = new RunFolder(join(root, 'p7'), '2026-07-21', '09-00');
  const result = {
    profile: 'rajni',
    date: '2026-07-21',
    time: '09-00',
    outcome: 'passed' as const,
    stages: [],
  };
  await folder.writeResult(result);
  const raw = await readFile(
    join(root, 'p7', 'runs', '2026-07-21', '09-00', 'result.json'),
    'utf8',
  );
  assert.deepEqual(JSON.parse(raw), result);
});

test('clearFailure removes an existing failure.json', async () => {
  const folder = new RunFolder(join(root, 'p9'), '2026-07-21', '09-00');
  await folder.writeFailure({ stage: 'extract', error: 'boom', elapsedMs: 42 });
  await folder.clearFailure();
  await assert.rejects(() =>
    readFile(join(root, 'p9', 'runs', '2026-07-21', '09-00', 'failure.json'), 'utf8'),
  );
});

test('clearFailure is a no-op when failure.json does not exist', async () => {
  const folder = new RunFolder(join(root, 'p10'), '2026-07-21', '09-00');
  await assert.doesNotReject(() => folder.clearFailure());
});

test('logPath returns run.log under the run folder', () => {
  const folder = new RunFolder(join(root, 'p8'), '2026-07-21', '09-00');
  assert.equal(
    folder.logPath(),
    join(root, 'p8', 'runs', '2026-07-21', '09-00', 'run.log'),
  );
});

test('formatRunTime: zero-pads HH-MM from the local clock', () => {
  assert.equal(formatRunTime(new Date(2026, 6, 21, 9, 5)), '09-05');
  assert.equal(formatRunTime(new Date(2026, 6, 21, 23, 59)), '23-59');
  assert.equal(formatRunTime(new Date(2026, 6, 21, 0, 0)), '00-00');
});

test('latestTimeDir: undefined when runs/<date>/ does not exist', async () => {
  const result = await latestTimeDir(join(root, 'p11'), '2026-07-21');
  assert.equal(result, undefined);
});

test('latestTimeDir: undefined when runs/<date>/ has no matching subdirs', async () => {
  const dataDir = join(root, 'p12');
  await mkdir(join(dataDir, 'runs', '2026-07-21', 'not-a-time-dir'), {
    recursive: true,
  });
  await mkdir(join(dataDir, 'runs', '2026-07-21', '.DS_Store'), {
    recursive: true,
  });
  const result = await latestTimeDir(dataDir, '2026-07-21');
  assert.equal(result, undefined);
});

test('latestTimeDir: picks the lexicographically greatest HH-MM subdir', async () => {
  const dataDir = join(root, 'p13');
  for (const time of ['09-05', '14-30', '08-00']) {
    await mkdir(join(dataDir, 'runs', '2026-07-21', time), { recursive: true });
  }
  const result = await latestTimeDir(dataDir, '2026-07-21');
  assert.equal(result, '14-30');
});

test('latestTimeDir: a collision suffix (HH-MM-N) sorts after its bare HH-MM', async () => {
  const dataDir = join(root, 'p14');
  for (const time of ['09-05', '09-05-2']) {
    await mkdir(join(dataDir, 'runs', '2026-07-21', time), { recursive: true });
  }
  const result = await latestTimeDir(dataDir, '2026-07-21');
  assert.equal(result, '09-05-2');
});

test('nextTimeDir: returns the bare time when it does not exist yet', async () => {
  const result = await nextTimeDir(join(root, 'p15'), '2026-07-21', '09-05');
  assert.equal(result, '09-05');
});

test('nextTimeDir: appends -2 when the bare time already exists', async () => {
  const dataDir = join(root, 'p16');
  await mkdir(join(dataDir, 'runs', '2026-07-21', '09-05'), { recursive: true });
  const result = await nextTimeDir(dataDir, '2026-07-21', '09-05');
  assert.equal(result, '09-05-2');
});

test('nextTimeDir: keeps incrementing the suffix past multiple collisions', async () => {
  const dataDir = join(root, 'p17');
  for (const time of ['09-05', '09-05-2', '09-05-3']) {
    await mkdir(join(dataDir, 'runs', '2026-07-21', time), { recursive: true });
  }
  const result = await nextTimeDir(dataDir, '2026-07-21', '09-05');
  assert.equal(result, '09-05-4');
});
