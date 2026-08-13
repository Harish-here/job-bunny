import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openJobsDb } from './migrations.ts';

// The committed profiles/rajni/ fixture PROFILE is tracked, but its sqlite
// DB file is not (profiles/*/data/* is gitignored — see .gitignore) — it
// only exists locally on a machine that has previously run a stage/verify
// against profiles/rajni. That makes the real-fixture test below
// opportunistic: it runs (and gives real production-shaped-schema evidence)
// wherever the file happens to be present, and skips cleanly everywhere else
// (a fresh checkout, CI), rather than depending on undeclared local state.
const RAJNI_FIXTURE_DB = path.join(
  import.meta.dirname,
  '../../../../../profiles/rajni/data/jobbunny.db',
);

function tmpDbPath(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), 'jb-sqlite-')),
    'nested',
    'jobbunny.db',
  );
}

function userVersion(db: ReturnType<typeof openJobsDb>): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
}

// Replays a prefix of the real MIGRATIONS array (exported by migrations.ts
// for exactly this purpose) to build a db at an arbitrary prior schema
// version, instead of hand-duplicating the full CREATE TABLE history for
// every version under test — the same tables the real migration path would
// produce, by construction.
function buildDbAtVersion(dbPath: string, version: number): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  for (let i = 0; i < version; i++) {
    db.exec(MIGRATIONS[i] as string);
  }
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

function tableNames(db: ReturnType<typeof openJobsDb>): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
}

test('fresh :memory: db migrates to LATEST_SCHEMA_VERSION with jobs + tracking tables', () => {
  const db = openJobsDb(':memory:');
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  const tables = tableNames(db);
  assert.ok(tables.includes('jobs'));
  assert.ok(tables.includes('tracking'));
  db.close();
});

test('file open creates parent directories and reopening is idempotent', () => {
  const dbPath = tmpDbPath();
  const first = openJobsDb(dbPath);
  first.close();
  const second = openJobsDb(dbPath);
  assert.equal(userVersion(second), LATEST_SCHEMA_VERSION);
  second.close();
});

test('a garbage (non-sqlite) file throws loud AND leaves no open handle behind', () => {
  const dbPath = tmpDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, 'not a real sqlite file at all');

  assert.throws(() => openJobsDb(dbPath), /file is not a database/);

  // Regression pin (fix round 3): a failed open used to leak the native
  // DatabaseSync handle it had already opened before the first failing
  // PRAGMA — harmless on POSIX (an unlinked-but-open file just lingers
  // until the process exits) but on Windows it makes the file
  // un-removable (EBUSY/EPERM) until this process ends. If the handle is
  // truly closed, removing it right away never throws.
  assert.doesNotThrow(() => rmSync(dbPath, { force: true }));
});

test('a db stamped newer than LATEST_SCHEMA_VERSION throws loud', () => {
  const dbPath = tmpDbPath();
  const db = openJobsDb(dbPath);
  db.exec('PRAGMA user_version = 99');
  db.close();
  assert.throws(
    () => openJobsDb(dbPath),
    new RegExp(`v99.*newer.*v${LATEST_SCHEMA_VERSION}`, 's'),
  );
});

test('fresh :memory: db lands at LATEST_SCHEMA_VERSION with runs + run_events + checkpoints + state_docs + config_docs + run_intents + run_progress + deferred_slots tables', () => {
  const db = openJobsDb(':memory:');
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  assert.equal(LATEST_SCHEMA_VERSION, 8);
  const tables = tableNames(db);
  assert.ok(tables.includes('jobs'));
  assert.ok(tables.includes('tracking'));
  assert.ok(tables.includes('runs'));
  assert.ok(tables.includes('run_events'));
  assert.ok(tables.includes('checkpoints'));
  assert.ok(tables.includes('state_docs'));
  assert.ok(tables.includes('config_docs'));
  assert.ok(tables.includes('run_intents'));
  assert.ok(tables.includes('run_progress'));
  assert.ok(tables.includes('deferred_slots'));
  db.close();
});

test('the run_intents partial unique index exists and guards only pending rows', () => {
  const db = openJobsDb(':memory:');
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
    .get('idx_run_intents_one_pending') as { sql: string } | undefined;
  assert.ok(row);
  assert.match(row.sql, /WHERE status = 'pending'/);
  db.close();
});

test('a v1-stamped db upgrades to LATEST_SCHEMA_VERSION preserving existing jobs rows', () => {
  const dbPath = tmpDbPath();
  const v1 = buildDbAtVersion(dbPath, 1);
  v1.prepare(
    `INSERT INTO jobs (id, lane, title, company, url, date_found, jd_json, synced_at)
     VALUES ('job-1', 'linkedin', 'Engineer', 'Acme', 'https://x', '2026-08-01', '{}', '2026-08-01T00:00:00Z')`,
  ).run();
  v1.close();

  const upgraded = openJobsDb(dbPath);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);
  const row = upgraded
    .prepare('SELECT id, company FROM jobs WHERE id = ?')
    .get('job-1') as { id: string; company: string } | undefined;
  assert.equal(row?.company, 'Acme');
  const tables = tableNames(upgraded);
  assert.ok(tables.includes('runs'));
  assert.ok(tables.includes('run_events'));
  assert.ok(tables.includes('checkpoints'));
  upgraded.close();
});

test('a v2-stamped db upgrades to LATEST_SCHEMA_VERSION preserving existing runs rows', () => {
  const dbPath = tmpDbPath();
  const v2 = buildDbAtVersion(dbPath, 2);
  const { lastInsertRowid } = v2
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
       VALUES ('2026-08-06', '09-00', 'run', 'running', '2026-08-06T09:00:00Z')`,
    )
    .run();
  v2.close();

  const upgraded = openJobsDb(dbPath);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);
  const row = upgraded
    .prepare('SELECT run_date, kind, status FROM runs WHERE id = ?')
    .get(lastInsertRowid) as
    | { run_date: string; kind: string; status: string }
    | undefined;
  assert.equal(row?.run_date, '2026-08-06');
  assert.equal(row?.kind, 'run');
  assert.equal(row?.status, 'running');
  assert.ok(tableNames(upgraded).includes('checkpoints'));
  upgraded.close();
});

test('a v3-stamped db upgrades to LATEST_SCHEMA_VERSION preserving existing runs + checkpoints rows', () => {
  const dbPath = tmpDbPath();
  const v3 = buildDbAtVersion(dbPath, 3);
  const { lastInsertRowid } = v3
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
       VALUES ('2026-08-06', '09-00', 'run', 'running', '2026-08-06T09:00:00Z')`,
    )
    .run();
  v3.prepare(
    `INSERT INTO checkpoints (run_date, time_dir, position, stage, payload_json, written_by, created_at)
       VALUES ('2026-08-06', '09-00', 0, 'farm', '{}', ?, '2026-08-06T09:00:00Z')`,
  ).run(lastInsertRowid);
  v3.close();

  const upgraded = openJobsDb(dbPath);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);
  const runRow = upgraded
    .prepare('SELECT run_date, kind, status FROM runs WHERE id = ?')
    .get(lastInsertRowid) as
    | { run_date: string; kind: string; status: string }
    | undefined;
  assert.equal(runRow?.run_date, '2026-08-06');
  const checkpointRow = upgraded
    .prepare(
      'SELECT stage, written_by FROM checkpoints WHERE run_date = ? AND time_dir = ? AND position = ?',
    )
    .get('2026-08-06', '09-00', 0) as { stage: string; written_by: number } | undefined;
  assert.equal(checkpointRow?.stage, 'farm');
  assert.equal(checkpointRow?.written_by, lastInsertRowid);
  assert.ok(tableNames(upgraded).includes('state_docs'));
  upgraded.close();
});

test('a v4-stamped db upgrades to LATEST_SCHEMA_VERSION preserving existing runs + state_docs rows', () => {
  const dbPath = tmpDbPath();
  const v4 = buildDbAtVersion(dbPath, 4);
  const { lastInsertRowid } = v4
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
       VALUES ('2026-08-06', '09-00', 'run', 'running', '2026-08-06T09:00:00Z')`,
    )
    .run();
  v4.prepare(
    `INSERT INTO state_docs (key, value_json, updated_at)
       VALUES ('farm_seen', '{}', '2026-08-06T09:00:00Z')`,
  ).run();
  v4.close();

  const upgraded = openJobsDb(dbPath);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);
  const runRow = upgraded
    .prepare('SELECT run_date, kind, status FROM runs WHERE id = ?')
    .get(lastInsertRowid) as
    | { run_date: string; kind: string; status: string }
    | undefined;
  assert.equal(runRow?.run_date, '2026-08-06');
  const stateDocRow = upgraded
    .prepare('SELECT value_json FROM state_docs WHERE key = ?')
    .get('farm_seen') as { value_json: string } | undefined;
  assert.equal(stateDocRow?.value_json, '{}');
  assert.ok(tableNames(upgraded).includes('config_docs'));
  upgraded.close();
});

test('a v5-stamped db upgrades to LATEST_SCHEMA_VERSION with a run_intents table', () => {
  const dbPath = tmpDbPath();
  const v5 = buildDbAtVersion(dbPath, 5);
  v5.prepare(
    `INSERT INTO config_docs (key, value_text, updated_at)
       VALUES ('profile.json', '{}', '2026-08-06T09:00:00Z')`,
  ).run();
  v5.close();

  const upgraded = openJobsDb(dbPath);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);
  assert.ok(tableNames(upgraded).includes('run_intents'));
  const configRow = upgraded
    .prepare('SELECT value_text FROM config_docs WHERE key = ?')
    .get('profile.json') as { value_text: string } | undefined;
  assert.equal(configRow?.value_text, '{}');
  upgraded.close();
});

test('a v6-stamped db upgrades to LATEST_SCHEMA_VERSION preserving existing runs rows, adding run_progress', () => {
  const dbPath = tmpDbPath();
  const v6 = buildDbAtVersion(dbPath, 6);
  const { lastInsertRowid } = v6
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
       VALUES ('2026-08-06', '09-00', 'run', 'running', '2026-08-06T09:00:00Z')`,
    )
    .run();
  v6.close();

  const upgraded = openJobsDb(dbPath);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);
  const runRow = upgraded
    .prepare('SELECT run_date, kind, status FROM runs WHERE id = ?')
    .get(lastInsertRowid) as
    | { run_date: string; kind: string; status: string }
    | undefined;
  assert.equal(runRow?.run_date, '2026-08-06');
  assert.ok(tableNames(upgraded).includes('run_progress'));
  upgraded.close();
});

test('a v7-stamped db upgrades to v8 adding deferred_slots + runs.catchup_slots_json, preserving existing runs rows', () => {
  const dbPath = tmpDbPath();
  const v7 = buildDbAtVersion(dbPath, 7);
  const { lastInsertRowid } = v7
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
       VALUES ('2026-08-06', '09-00', 'run', 'running', '2026-08-06T09:00:00Z')`,
    )
    .run();
  v7.close();

  const upgraded = openJobsDb(dbPath);
  assert.equal(userVersion(upgraded), 8);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);

  // The pre-existing run row survives, and its new nullable column reads
  // NULL — never a default value that would misrepresent a pre-migration
  // run as covering zero catch-up slots.
  const runRow = upgraded
    .prepare('SELECT run_date, kind, status, catchup_slots_json FROM runs WHERE id = ?')
    .get(lastInsertRowid) as
    | {
        run_date: string;
        kind: string;
        status: string;
        catchup_slots_json: string | null;
      }
    | undefined;
  assert.equal(runRow?.run_date, '2026-08-06');
  assert.equal(runRow?.kind, 'run');
  assert.equal(runRow?.status, 'running');
  assert.equal(runRow?.catchup_slots_json, null);

  assert.ok(tableNames(upgraded).includes('deferred_slots'));
  upgraded.close();
});

test('deferred_slots has exactly the 6 documented columns with the expected types/nullability', () => {
  const db = openJobsDb(':memory:');
  const columns = (
    db.prepare('PRAGMA table_info(deferred_slots)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[]
  ).map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));
  assert.deepEqual(columns, [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'run_date', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'slot', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'reason_code', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'reason', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'decided_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'notified_at', type: 'TEXT', notnull: 0, pk: 0 },
  ]);
  db.close();
});

test('idx_deferred_slots_one_per_slot is a UNIQUE index and the constraint actually fires', () => {
  const db = openJobsDb(':memory:');
  const indexRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
    .get('idx_deferred_slots_one_per_slot') as { sql: string } | undefined;
  assert.ok(indexRow);
  assert.match(indexRow.sql, /UNIQUE INDEX/);
  assert.match(indexRow.sql, /\(run_date, slot\)/);

  db.prepare(
    `INSERT INTO deferred_slots (run_date, slot, reason_code, reason, decided_at)
       VALUES ('2026-08-13', '09:00', 'host-asleep', 'laptop asleep', '2026-08-13T09:05:00Z')`,
  ).run();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO deferred_slots (run_date, slot, reason_code, reason, decided_at)
         VALUES ('2026-08-13', '09:00', 'network-unreachable', 'no network', '2026-08-13T09:06:00Z')`,
    ).run();
  }, /UNIQUE constraint failed/);
  db.close();
});

test('idx_deferred_slots_date exists', () => {
  const db = openJobsDb(':memory:');
  const indexRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
    .get('idx_deferred_slots_date') as { sql: string } | undefined;
  assert.ok(indexRow);
  assert.match(indexRow.sql, /\(run_date\)/);
  db.close();
});

test('a real profiles/rajni fixture db (copied to a temp path) upgrades v6 -> LATEST_SCHEMA_VERSION without data loss', {
  skip: existsSync(RAJNI_FIXTURE_DB)
    ? false
    : 'no local profiles/rajni/data/jobbunny.db present (gitignored — not present on a fresh checkout/CI)',
}, () => {
  // Verifies the migration against the real, production-shaped rajni
  // fixture DB (not just the hand-stamped fixtures above) — WITHOUT ever
  // touching the live file: everything happens on a copy in a fresh
  // mkdtemp'd temp directory.
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'jb-sqlite-rajni-'));
  const copyPath = path.join(tmpDir, 'jobbunny.db');
  for (const ext of ['', '-wal', '-shm']) {
    const src = `${RAJNI_FIXTURE_DB}${ext}`;
    if (existsSync(src)) copyFileSync(src, `${copyPath}${ext}`);
  }

  const before = new DatabaseSync(copyPath);
  let versionBefore = userVersion(before);
  if (versionBefore >= 7) {
    // The local rajni fixture has already migrated past v6 on this machine
    // (it's gitignored — never present on a fresh checkout/CI, so this
    // branch never runs there). The v6->v7 and v7->v8 steps are pure ADDs
    // (new tables/column only — see migrations.ts), so reverting THIS
    // DISPOSABLE COPY to v6 shape (drop the tables/column added after v6,
    // stamp the version back down) exercises the real upgrade path this
    // test is named for, on real production-shaped data, without ever
    // touching the live fixture file.
    before.exec('DROP TABLE IF EXISTS deferred_slots');
    before.exec('DROP TABLE IF EXISTS run_progress');
    const runsCols = (
      before.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
    ).map((c) => c.name);
    if (runsCols.includes('catchup_slots_json')) {
      before.exec('ALTER TABLE runs DROP COLUMN catchup_slots_json');
    }
    before.exec('PRAGMA user_version = 6');
    versionBefore = userVersion(before);
  }
  assert.equal(versionBefore, 6, `fixture copy is at v${versionBefore} — expected v6`);
  const jobsBefore = (
    before.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }
  ).c;
  assert.ok(jobsBefore > 0, 'fixture has no jobs rows to verify preservation against');
  before.close();

  const upgraded = openJobsDb(copyPath);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);
  const jobsAfter = (
    upgraded.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }
  ).c;
  assert.equal(jobsAfter, jobsBefore);
  const tables = tableNames(upgraded);
  assert.ok(tables.includes('run_progress'));
  assert.ok(tables.includes('deferred_slots'));
  upgraded.close();

  rmSync(tmpDir, { recursive: true, force: true });
});
