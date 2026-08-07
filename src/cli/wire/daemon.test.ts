import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import {
  wireDaemonIntents,
  wireDaemonRunHistory,
  wireDaemonScheduleConfig,
} from './daemon.ts';

// This test file may not import `src/adapters/**` directly (no test-file
// exemption from `only-wire-imports-adapters` — only `daemon.ts` itself is
// carved out, mirroring `board.test.ts`'s own posture). Seeding a real
// `runs` row therefore goes through `node:sqlite` directly (a node
// builtin, never `src/adapters`): each seeding test first writes an EMPTY
// placeholder file at the resolved db path (a zero-length file is a valid,
// unmigrated empty sqlite database) so `wireDaemonRunHistory`'s own
// existence check passes; `wireDaemonRunHistory`'s returned function is
// then called once, which — via the REAL `SqliteRunStore.listRunTimeDirs`'s
// lazy `openJobsDb` — migrates that already-existing file up to the latest
// schema; a raw `INSERT INTO runs` afterward then exercises the exact
// column shape `SqliteRunStore.startRun` itself writes. Nothing in this
// file relies on `wireDaemonRunHistory` itself creating a db file — it
// must never do that for a profile with no db yet (see the dedicated test
// below).

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

test('wireDaemonRunHistory: a profile with no jobbunny.db yet yields no records and creates no file', async () => {
  const dbPath = await seedProfileDir('nodb');
  const readRunHistory = wireDaemonRunHistory({ root });
  assert.deepEqual(readRunHistory(['nodb'], '2026-08-05'), []);
  assert.equal(existsSync(dbPath), false, 'a tick must never create the db file');
});

test("wireDaemonRunHistory: reads a real runs row from that profile's own jobbunny.db, converting time_dir -> startedAt", async () => {
  const dbPath = await seedProfileDir('harish');
  await writeFile(dbPath, ''); // the profile has a db (empty/unmigrated) already.
  const readRunHistory = wireDaemonRunHistory({ root });
  // First call migrates the existing (empty) file via the real store's lazy open.
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
  await writeFile(alphaDbPath, '');
  await writeFile(zetaDbPath, '');
  const readRunHistory = wireDaemonRunHistory({ root });
  readRunHistory(['alpha', 'zeta'], '2026-08-05'); // migrate both.

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

test('wireDaemonRunHistory: settings.sqlite.path in profile.json is silently ignored — the daemon always resolves the CANONICAL path, unlike wire()/doctor which throw/red on the same setting (a deliberate tolerant-vs-loud asymmetry: a broken/stale profile must never take down a tick)', async () => {
  await mkdir(join(root, 'profiles', 'custom'), { recursive: true });
  const customDbDir = join(root, 'elsewhere');
  await mkdir(customDbDir, { recursive: true });
  const customDbPath = join(customDbDir, 'custom.db');
  await writeFile(
    join(root, 'profiles', 'custom', 'profile.json'),
    JSON.stringify({ connector: 'sqlite', settings: { sqlite: { path: customDbPath } } }),
  );
  // The dead knob's own (now-irrelevant) target is deliberately left
  // WITHOUT a db file — proving the daemon never even looks at it.
  const canonicalPath = join(root, 'profiles', 'custom', 'data', 'jobbunny.db');
  await mkdir(join(root, 'profiles', 'custom', 'data'), { recursive: true });
  await writeFile(canonicalPath, '');

  const readRunHistory = wireDaemonRunHistory({ root });
  readRunHistory(['custom'], '2026-08-05'); // migrate at the CANONICAL path.

  insertRunRow(canonicalPath, {
    date: '2026-08-05',
    timeDir: '10-00',
    startedAt: '2026-08-05T10:00:00.000Z',
  });

  const history = readRunHistory(['custom'], '2026-08-05');
  assert.deepEqual(history, [
    { profile: 'custom', date: '2026-08-05', startedAt: '10:00' },
  ]);
  assert.equal(
    existsSync(customDbPath),
    false,
    "the dead setting's target must never be touched",
  );
});

test('wireDaemonRunHistory: a malformed profile.json falls back to the default db path (tolerant, never throws)', async () => {
  await mkdir(join(root, 'profiles', 'broken'), { recursive: true });
  await writeFile(join(root, 'profiles', 'broken', 'profile.json'), 'not json{{{');
  const readRunHistory = wireDaemonRunHistory({ root });
  assert.doesNotThrow(() => readRunHistory(['broken'], '2026-08-05'));
  assert.deepEqual(readRunHistory(['broken'], '2026-08-05'), []);
});

test('wireDaemonRunHistory: a store that fails once does not permanently blind a subsequent call (fresh store per call, never memoized)', async () => {
  const dbPath = await seedProfileDir('flaky');
  await writeFile(dbPath, ''); // exists, so the missing-file short-circuit above never fires here.

  let calls = 0;
  let closes = 0;
  const readRunHistory = wireDaemonRunHistory({
    root,
    makeRunStore: () => {
      calls += 1;
      // Call 1 stands in for a store whose open() failed (the real
      // `SqliteRunStore`'s own permanent-degrade posture): it reports no
      // records. Call 2 stands in for the SAME profile's db opening fine
      // on the very next tick. If `wireDaemonRunHistory` ever memoized one
      // store per profile (the bug this pins), call 2 would reuse call 1's
      // degraded instance and also report no records.
      const rows = calls === 1 ? [] : ['09-00'];
      return {
        listRunTimeDirs: () => rows,
        close: () => {
          closes += 1;
        },
      };
    },
  });

  assert.deepEqual(readRunHistory(['flaky'], '2026-08-05'), []);
  assert.deepEqual(readRunHistory(['flaky'], '2026-08-05'), [
    { profile: 'flaky', date: '2026-08-05', startedAt: '09:00' },
  ]);
  assert.equal(calls, 2, 'expected a fresh store construction per call, never memoized');
  assert.equal(closes, 2, 'expected every constructed store to be closed after its read');
});

test('wireDaemonScheduleConfig: a profile with a malformed profile.json and NO jobbunny.db yet resolves undefined, never rejects (real SqliteConfigStore readonly-lift path — reproduces the daemon-tick-wide outage this guards against)', async () => {
  await mkdir(join(root, 'profiles', 'scancfg-broken'), { recursive: true });
  await writeFile(
    join(root, 'profiles', 'scancfg-broken', 'profile.json'),
    'not valid json {{{',
  );
  const readProfileJson = wireDaemonScheduleConfig({ root });
  await assert.doesNotReject(() =>
    readProfileJson(join(root, 'profiles'), 'scancfg-broken'),
  );
  assert.equal(
    await readProfileJson(join(root, 'profiles'), 'scancfg-broken'),
    undefined,
  );
});

test('wireDaemonScheduleConfig: a profile with a valid profile.json and no db still resolves its raw text (lift-without-insert, readonly mode)', async () => {
  await mkdir(join(root, 'profiles', 'scancfg-ok'), { recursive: true });
  const raw = JSON.stringify({ connector: 'sqlite' });
  await writeFile(join(root, 'profiles', 'scancfg-ok', 'profile.json'), raw);
  const readProfileJson = wireDaemonScheduleConfig({ root });
  assert.equal(await readProfileJson(join(root, 'profiles'), 'scancfg-ok'), raw);
});

// --- wireDaemonIntents ---
//
// `readIntents` scans the WHOLE `<root>/profiles` directory, so unlike
// `wireDaemonRunHistory` (which is always called with an explicit profile
// list) these tests each get their OWN freshly minted temp root — reusing
// the file-scope `root` above would let one test's leftover profile
// directory leak into a later test's full-directory scan.
async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'jb-wire-daemon-intents-'));
  try {
    return await fn(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function seedProfileDirIn(root: string, name: string): Promise<string> {
  const dbDir = join(root, 'profiles', name, 'data');
  await mkdir(dbDir, { recursive: true });
  return join(dbDir, 'jobbunny.db');
}

function insertIntentRow(
  dbPath: string,
  row: { requestedAt: string; status: string },
): number {
  const db = new DatabaseSync(dbPath);
  const result = db
    .prepare(
      'INSERT INTO run_intents (requested_at, status, claimed_run_id) VALUES (?, ?, NULL)',
    )
    .run(row.requestedAt, row.status);
  db.close();
  return Number(result.lastInsertRowid);
}

function readClaimedRunId(dbPath: string, intentId: number): number | null {
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare('SELECT claimed_run_id FROM run_intents WHERE id = ?')
    .get(intentId) as { claimed_run_id: number | null } | undefined;
  db.close();
  return row?.claimed_run_id ?? null;
}

function readRunIdByTimeDir(dbPath: string, timeDir: string): number {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT id FROM runs WHERE time_dir = ?').get(timeDir) as {
    id: number;
  };
  db.close();
  return row.id;
}

test('wireDaemonIntents.readIntents: a profile with no jobbunny.db yet contributes nothing and creates no file', async () => {
  await withTempRoot(async (tempRoot) => {
    const dbPath = await seedProfileDirIn(tempRoot, 'nodb');
    const { readIntents } = wireDaemonIntents({ root: tempRoot });
    assert.deepEqual(readIntents(new Date('2026-08-05T12:00:00.000Z')), []);
    assert.equal(existsSync(dbPath), false, 'a tick must never create the db file');
  });
});

test('wireDaemonIntents.readIntents: a pending intent is returned', async () => {
  await withTempRoot(async (tempRoot) => {
    const dbPath = await seedProfileDirIn(tempRoot, 'pending');
    await writeFile(dbPath, '');
    const { readIntents, claimIntent } = wireDaemonIntents({ root: tempRoot });
    claimIntent('pending', -1); // migrates the schema (no matching row — a no-op claim).
    const id = insertIntentRow(dbPath, {
      requestedAt: '2026-08-05T11:59:00.000Z',
      status: 'pending',
    });
    assert.deepEqual(readIntents(new Date('2026-08-05T12:00:00.000Z')), [
      { profile: 'pending', intentId: id, requestedAt: '2026-08-05T11:59:00.000Z' },
    ]);
  });
});

test('wireDaemonIntents.readIntents: an expired intent is not returned', async () => {
  await withTempRoot(async (tempRoot) => {
    const dbPath = await seedProfileDirIn(tempRoot, 'expired');
    await writeFile(dbPath, '');
    const { readIntents, claimIntent } = wireDaemonIntents({ root: tempRoot });
    claimIntent('expired', -1); // migrates the schema.
    insertIntentRow(dbPath, {
      requestedAt: '2026-08-05T11:00:00.000Z', // 60 minutes old — well past the 10-minute expiry.
      status: 'pending',
    });
    assert.deepEqual(readIntents(new Date('2026-08-05T12:00:00.000Z')), []);
  });
});

test('wireDaemonIntents.claimIntent: returns true once, then false on a second call for the same intent', async () => {
  await withTempRoot(async (tempRoot) => {
    const dbPath = await seedProfileDirIn(tempRoot, 'claimtwice');
    await writeFile(dbPath, '');
    const { claimIntent } = wireDaemonIntents({ root: tempRoot });
    claimIntent('claimtwice', -1); // migrates the schema.
    const id = insertIntentRow(dbPath, {
      requestedAt: '2026-08-05T12:00:00.000Z',
      status: 'pending',
    });
    assert.equal(claimIntent('claimtwice', id), true);
    assert.equal(claimIntent('claimtwice', id), false);
  });
});

test('wireDaemonIntents.attachIntentRun: sets claimed_run_id to a run started after since', async () => {
  await withTempRoot(async (tempRoot) => {
    const dbPath = await seedProfileDirIn(tempRoot, 'attach-after');
    await writeFile(dbPath, '');
    const { claimIntent, attachIntentRun } = wireDaemonIntents({ root: tempRoot });
    claimIntent('attach-after', -1); // migrates the schema.
    const intentId = insertIntentRow(dbPath, {
      requestedAt: '2026-08-05T12:00:00.000Z',
      status: 'claimed',
    });
    insertRunRow(dbPath, {
      date: '2026-08-05',
      timeDir: '12-05',
      startedAt: '2026-08-05T12:05:00.000Z', // after `since` below.
    });
    const runId = readRunIdByTimeDir(dbPath, '12-05');

    attachIntentRun('attach-after', intentId, '2026-08-05T12:00:00.000Z');

    assert.equal(readClaimedRunId(dbPath, intentId), runId);
  });
});

test('wireDaemonIntents.attachIntentRun: leaves claimed_run_id null when the only run started before since', async () => {
  await withTempRoot(async (tempRoot) => {
    const dbPath = await seedProfileDirIn(tempRoot, 'attach-before');
    await writeFile(dbPath, '');
    const { claimIntent, attachIntentRun } = wireDaemonIntents({ root: tempRoot });
    claimIntent('attach-before', -1); // migrates the schema.
    const intentId = insertIntentRow(dbPath, {
      requestedAt: '2026-08-05T12:00:00.000Z',
      status: 'claimed',
    });
    insertRunRow(dbPath, {
      date: '2026-08-05',
      timeDir: '11-55',
      startedAt: '2026-08-05T11:55:00.000Z', // before `since` below.
    });

    attachIntentRun('attach-before', intentId, '2026-08-05T12:00:00.000Z');

    assert.equal(readClaimedRunId(dbPath, intentId), null);
  });
});
