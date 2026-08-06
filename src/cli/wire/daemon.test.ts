import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { wireDaemonRunHistory } from './daemon.ts';

// This test file may not import `src/adapters/**` directly (no test-file
// exemption from `only-wire-imports-adapters` — only `daemon.ts` itself is
// carved out, mirroring `board.test.ts`'s own posture). Seeding a real
// `runs` row therefore goes through `node:sqlite` directly (a node
// builtin, never `src/adapters`): `wireDaemonRunHistory`'s returned
// function is called once first with no rows present, which — via the
// REAL `SqliteRunStore.listRunTimeDirs`'s lazy `openJobsDb` — creates and
// migrates the db file for us; a raw `INSERT INTO runs` afterward then
// exercises the exact column shape `SqliteRunStore.startRun` itself writes.

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-wire-daemon-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedProfileDir(name: string): Promise<string> {
  const dbDir = join(root, 'profiles', name, 'data');
  await mkdir(dbDir, { recursive: true });
  return join(dbDir, 'jobbunny.db');
}

function insertRunRow(
  dbPath: string,
  row: { date: string; timeDir: string; startedAt: string },
): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
     VALUES (?, ?, 'run', 'running', ?)`,
  ).run(row.date, row.timeDir, row.startedAt);
  db.close();
}

test('wireDaemonRunHistory: a profile with no jobbunny.db yet yields no records', async () => {
  await seedProfileDir('nodb');
  const readRunHistory = wireDaemonRunHistory({ root });
  assert.deepEqual(readRunHistory(['nodb'], '2026-08-05'), []);
});

test("wireDaemonRunHistory: reads a real runs row from that profile's own jobbunny.db, converting time_dir -> startedAt", async () => {
  const dbPath = await seedProfileDir('harish');
  const readRunHistory = wireDaemonRunHistory({ root });
  // First call creates + migrates the (until now nonexistent) db file, via
  // the real SqliteRunStore's lazy open.
  assert.deepEqual(readRunHistory(['harish'], '2026-08-05'), []);

  insertRunRow(dbPath, {
    date: '2026-08-05',
    timeDir: '14-00',
    startedAt: '2026-08-05T14:00:00.000Z',
  });

  const history = readRunHistory(['harish'], '2026-08-05');
  assert.deepEqual(history, [
    { profile: 'harish', date: '2026-08-05', startedAt: '14:00' },
  ]);
});

test('wireDaemonRunHistory: batches multiple profiles, each read from its OWN db', async () => {
  const alphaDbPath = await seedProfileDir('alpha');
  const zetaDbPath = await seedProfileDir('zeta');
  const readRunHistory = wireDaemonRunHistory({ root });
  readRunHistory(['alpha', 'zeta'], '2026-08-05'); // create + migrate both.

  insertRunRow(alphaDbPath, {
    date: '2026-08-05',
    timeDir: '09-00',
    startedAt: '2026-08-05T09:00:00.000Z',
  });
  insertRunRow(zetaDbPath, {
    date: '2026-08-05',
    timeDir: '11-30',
    startedAt: '2026-08-05T11:30:00.000Z',
  });

  const history = readRunHistory(['alpha', 'zeta'], '2026-08-05');
  assert.deepEqual(
    history.sort((a, b) => a.profile.localeCompare(b.profile)),
    [
      { profile: 'alpha', date: '2026-08-05', startedAt: '09:00' },
      { profile: 'zeta', date: '2026-08-05', startedAt: '11:30' },
    ],
  );
});

test('wireDaemonRunHistory: honors settings.sqlite.path override in profile.json', async () => {
  await mkdir(join(root, 'profiles', 'custom'), { recursive: true });
  const customDbDir = join(root, 'elsewhere');
  await mkdir(customDbDir, { recursive: true });
  const customDbPath = join(customDbDir, 'custom.db');
  await writeFile(
    join(root, 'profiles', 'custom', 'profile.json'),
    JSON.stringify({ connector: 'sqlite', settings: { sqlite: { path: customDbPath } } }),
  );

  const readRunHistory = wireDaemonRunHistory({ root });
  readRunHistory(['custom'], '2026-08-05'); // create + migrate at the OVERRIDDEN path.

  insertRunRow(customDbPath, {
    date: '2026-08-05',
    timeDir: '10-00',
    startedAt: '2026-08-05T10:00:00.000Z',
  });

  const history = readRunHistory(['custom'], '2026-08-05');
  assert.deepEqual(history, [
    { profile: 'custom', date: '2026-08-05', startedAt: '10:00' },
  ]);
});

test('wireDaemonRunHistory: a malformed profile.json falls back to the default db path (tolerant, never throws)', async () => {
  await mkdir(join(root, 'profiles', 'broken'), { recursive: true });
  await writeFile(join(root, 'profiles', 'broken', 'profile.json'), 'not json{{{');
  const readRunHistory = wireDaemonRunHistory({ root });
  assert.doesNotThrow(() => readRunHistory(['broken'], '2026-08-05'));
  assert.deepEqual(readRunHistory(['broken'], '2026-08-05'), []);
});
