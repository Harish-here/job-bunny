import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { LATEST_SCHEMA_VERSION, openJobsDb } from './migrations.ts';

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

test('fresh :memory: db migrates to LATEST_SCHEMA_VERSION with jobs + tracking tables', () => {
  const db = openJobsDb(':memory:');
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as {
      name: string;
    }[]
  ).map((t) => t.name);
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
  assert.throws(() => openJobsDb(dbPath), /v99.*newer.*v6/s);
});

test('fresh :memory: db lands at v6 with runs + run_events + checkpoints + state_docs + config_docs + run_intents tables', () => {
  const db = openJobsDb(':memory:');
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  assert.equal(LATEST_SCHEMA_VERSION, 6);
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  assert.ok(tables.includes('jobs'));
  assert.ok(tables.includes('tracking'));
  assert.ok(tables.includes('runs'));
  assert.ok(tables.includes('run_events'));
  assert.ok(tables.includes('checkpoints'));
  assert.ok(tables.includes('state_docs'));
  assert.ok(tables.includes('config_docs'));
  assert.ok(tables.includes('run_intents'));
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
  // Build a v1 db by hand: only MIGRATIONS[0], stamped user_version=1.
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const v1 = new DatabaseSync(dbPath);
  v1.exec(`
    CREATE TABLE jobs (
      id            TEXT PRIMARY KEY,
      lane          TEXT NOT NULL,
      title         TEXT NOT NULL,
      company       TEXT NOT NULL,
      url           TEXT NOT NULL,
      seniority     TEXT,
      location_city TEXT,
      work_type     TEXT,
      timezone      TEXT,
      skills        TEXT,
      excitement    TEXT,
      score         REAL,
      match_reasons TEXT,
      date_found    TEXT NOT NULL,
      jd_json       TEXT NOT NULL,
      synced_at     TEXT NOT NULL,
      archived      INTEGER NOT NULL DEFAULT 0,
      archived_at   TEXT
    );
    CREATE TABLE tracking (
      job_id           TEXT PRIMARY KEY REFERENCES jobs(id),
      status           TEXT,
      comp_range       TEXT,
      notes            TEXT,
      contact          TEXT,
      date_applied     TEXT,
      next_action      TEXT,
      next_action_date TEXT,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_jobs_archived_date_found ON jobs(archived, date_found);
  `);
  v1.exec('PRAGMA user_version = 1');
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
  const tables = (
    upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
  assert.ok(tables.includes('runs'));
  assert.ok(tables.includes('run_events'));
  assert.ok(tables.includes('checkpoints'));
  upgraded.close();
});

test('a v2-stamped db upgrades to LATEST_SCHEMA_VERSION preserving existing runs rows', () => {
  const dbPath = tmpDbPath();
  // Build a v2 db by hand: MIGRATIONS[0] + MIGRATIONS[1], stamped user_version=2.
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const v2 = new DatabaseSync(dbPath);
  v2.exec(`
    CREATE TABLE jobs (
      id            TEXT PRIMARY KEY,
      lane          TEXT NOT NULL,
      title         TEXT NOT NULL,
      company       TEXT NOT NULL,
      url           TEXT NOT NULL,
      seniority     TEXT,
      location_city TEXT,
      work_type     TEXT,
      timezone      TEXT,
      skills        TEXT,
      excitement    TEXT,
      score         REAL,
      match_reasons TEXT,
      date_found    TEXT NOT NULL,
      jd_json       TEXT NOT NULL,
      synced_at     TEXT NOT NULL,
      archived      INTEGER NOT NULL DEFAULT 0,
      archived_at   TEXT
    );
    CREATE TABLE tracking (
      job_id           TEXT PRIMARY KEY REFERENCES jobs(id),
      status           TEXT,
      comp_range       TEXT,
      notes            TEXT,
      contact          TEXT,
      date_applied     TEXT,
      next_action      TEXT,
      next_action_date TEXT,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_jobs_archived_date_found ON jobs(archived, date_found);
    CREATE TABLE runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date      TEXT NOT NULL,
      time_dir      TEXT,
      kind          TEXT NOT NULL,
      resumed_from  INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      status        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      result_json   TEXT,
      failure_json  TEXT,
      sync_dryrun_json TEXT
    );
    CREATE INDEX idx_runs_date ON runs(run_date);
    CREATE TABLE run_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL REFERENCES runs(id),
      ts        TEXT NOT NULL,
      level     TEXT NOT NULL,
      msg       TEXT NOT NULL,
      data_json TEXT
    );
    CREATE INDEX idx_run_events_run ON run_events(run_id);
  `);
  v2.exec('PRAGMA user_version = 2');
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
  const tables = (
    upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
  assert.ok(tables.includes('checkpoints'));
  upgraded.close();
});

test('a v3-stamped db upgrades to LATEST_SCHEMA_VERSION preserving existing runs + checkpoints rows', () => {
  const dbPath = tmpDbPath();
  // Build a v3 db by hand: MIGRATIONS[0] + MIGRATIONS[1] + MIGRATIONS[2], stamped user_version=3.
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const v3 = new DatabaseSync(dbPath);
  v3.exec(`
    CREATE TABLE jobs (
      id            TEXT PRIMARY KEY,
      lane          TEXT NOT NULL,
      title         TEXT NOT NULL,
      company       TEXT NOT NULL,
      url           TEXT NOT NULL,
      seniority     TEXT,
      location_city TEXT,
      work_type     TEXT,
      timezone      TEXT,
      skills        TEXT,
      excitement    TEXT,
      score         REAL,
      match_reasons TEXT,
      date_found    TEXT NOT NULL,
      jd_json       TEXT NOT NULL,
      synced_at     TEXT NOT NULL,
      archived      INTEGER NOT NULL DEFAULT 0,
      archived_at   TEXT
    );
    CREATE TABLE tracking (
      job_id           TEXT PRIMARY KEY REFERENCES jobs(id),
      status           TEXT,
      comp_range       TEXT,
      notes            TEXT,
      contact          TEXT,
      date_applied     TEXT,
      next_action      TEXT,
      next_action_date TEXT,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_jobs_archived_date_found ON jobs(archived, date_found);
    CREATE TABLE runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date      TEXT NOT NULL,
      time_dir      TEXT,
      kind          TEXT NOT NULL,
      resumed_from  INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      status        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      result_json   TEXT,
      failure_json  TEXT,
      sync_dryrun_json TEXT
    );
    CREATE INDEX idx_runs_date ON runs(run_date);
    CREATE TABLE run_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL REFERENCES runs(id),
      ts        TEXT NOT NULL,
      level     TEXT NOT NULL,
      msg       TEXT NOT NULL,
      data_json TEXT
    );
    CREATE INDEX idx_run_events_run ON run_events(run_id);
    CREATE TABLE checkpoints (
      run_date   TEXT    NOT NULL,
      time_dir   TEXT    NOT NULL,
      position   INTEGER NOT NULL,
      stage      TEXT    NOT NULL,
      payload_json TEXT  NOT NULL,
      written_by INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (run_date, time_dir, position)
    );
    CREATE INDEX idx_checkpoints_date ON checkpoints(run_date);
  `);
  v3.exec('PRAGMA user_version = 3');
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
  assert.equal(runRow?.kind, 'run');
  assert.equal(runRow?.status, 'running');
  const checkpointRow = upgraded
    .prepare(
      'SELECT stage, written_by FROM checkpoints WHERE run_date = ? AND time_dir = ? AND position = ?',
    )
    .get('2026-08-06', '09-00', 0) as { stage: string; written_by: number } | undefined;
  assert.equal(checkpointRow?.stage, 'farm');
  assert.equal(checkpointRow?.written_by, lastInsertRowid);
  const tables = (
    upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
  assert.ok(tables.includes('state_docs'));
  upgraded.close();
});

test('a v4-stamped db upgrades to LATEST_SCHEMA_VERSION preserving existing runs + state_docs rows', () => {
  const dbPath = tmpDbPath();
  // Build a v4 db by hand: MIGRATIONS[0..3], stamped user_version=4.
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const v4 = new DatabaseSync(dbPath);
  v4.exec(`
    CREATE TABLE jobs (
      id            TEXT PRIMARY KEY,
      lane          TEXT NOT NULL,
      title         TEXT NOT NULL,
      company       TEXT NOT NULL,
      url           TEXT NOT NULL,
      seniority     TEXT,
      location_city TEXT,
      work_type     TEXT,
      timezone      TEXT,
      skills        TEXT,
      excitement    TEXT,
      score         REAL,
      match_reasons TEXT,
      date_found    TEXT NOT NULL,
      jd_json       TEXT NOT NULL,
      synced_at     TEXT NOT NULL,
      archived      INTEGER NOT NULL DEFAULT 0,
      archived_at   TEXT
    );
    CREATE TABLE tracking (
      job_id           TEXT PRIMARY KEY REFERENCES jobs(id),
      status           TEXT,
      comp_range       TEXT,
      notes            TEXT,
      contact          TEXT,
      date_applied     TEXT,
      next_action      TEXT,
      next_action_date TEXT,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_jobs_archived_date_found ON jobs(archived, date_found);
    CREATE TABLE runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date      TEXT NOT NULL,
      time_dir      TEXT,
      kind          TEXT NOT NULL,
      resumed_from  INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      status        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      result_json   TEXT,
      failure_json  TEXT,
      sync_dryrun_json TEXT
    );
    CREATE INDEX idx_runs_date ON runs(run_date);
    CREATE TABLE run_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL REFERENCES runs(id),
      ts        TEXT NOT NULL,
      level     TEXT NOT NULL,
      msg       TEXT NOT NULL,
      data_json TEXT
    );
    CREATE INDEX idx_run_events_run ON run_events(run_id);
    CREATE TABLE checkpoints (
      run_date   TEXT    NOT NULL,
      time_dir   TEXT    NOT NULL,
      position   INTEGER NOT NULL,
      stage      TEXT    NOT NULL,
      payload_json TEXT  NOT NULL,
      written_by INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (run_date, time_dir, position)
    );
    CREATE INDEX idx_checkpoints_date ON checkpoints(run_date);
    CREATE TABLE state_docs (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  v4.exec('PRAGMA user_version = 4');
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
  assert.equal(runRow?.kind, 'run');
  assert.equal(runRow?.status, 'running');
  const stateDocRow = upgraded
    .prepare('SELECT value_json FROM state_docs WHERE key = ?')
    .get('farm_seen') as { value_json: string } | undefined;
  assert.equal(stateDocRow?.value_json, '{}');
  const tables = (
    upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
  assert.ok(tables.includes('config_docs'));
  upgraded.close();
});

test('a v5-stamped db upgrades to LATEST_SCHEMA_VERSION with a run_intents table', () => {
  const dbPath = tmpDbPath();
  // Build a v5 db by hand: MIGRATIONS[0..4] (through config_docs, no
  // run_intents yet), stamped user_version=5.
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const v5 = new DatabaseSync(dbPath);
  v5.exec(`
    CREATE TABLE jobs (
      id            TEXT PRIMARY KEY,
      lane          TEXT NOT NULL,
      title         TEXT NOT NULL,
      company       TEXT NOT NULL,
      url           TEXT NOT NULL,
      seniority     TEXT,
      location_city TEXT,
      work_type     TEXT,
      timezone      TEXT,
      skills        TEXT,
      excitement    TEXT,
      score         REAL,
      match_reasons TEXT,
      date_found    TEXT NOT NULL,
      jd_json       TEXT NOT NULL,
      synced_at     TEXT NOT NULL,
      archived      INTEGER NOT NULL DEFAULT 0,
      archived_at   TEXT
    );
    CREATE TABLE tracking (
      job_id           TEXT PRIMARY KEY REFERENCES jobs(id),
      status           TEXT,
      comp_range       TEXT,
      notes            TEXT,
      contact          TEXT,
      date_applied     TEXT,
      next_action      TEXT,
      next_action_date TEXT,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_jobs_archived_date_found ON jobs(archived, date_found);
    CREATE TABLE runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date      TEXT NOT NULL,
      time_dir      TEXT,
      kind          TEXT NOT NULL,
      resumed_from  INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      status        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      result_json   TEXT,
      failure_json  TEXT,
      sync_dryrun_json TEXT
    );
    CREATE INDEX idx_runs_date ON runs(run_date);
    CREATE TABLE run_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL REFERENCES runs(id),
      ts        TEXT NOT NULL,
      level     TEXT NOT NULL,
      msg       TEXT NOT NULL,
      data_json TEXT
    );
    CREATE INDEX idx_run_events_run ON run_events(run_id);
    CREATE TABLE checkpoints (
      run_date   TEXT    NOT NULL,
      time_dir   TEXT    NOT NULL,
      position   INTEGER NOT NULL,
      stage      TEXT    NOT NULL,
      payload_json TEXT  NOT NULL,
      written_by INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (run_date, time_dir, position)
    );
    CREATE INDEX idx_checkpoints_date ON checkpoints(run_date);
    CREATE TABLE state_docs (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE config_docs (
      key        TEXT PRIMARY KEY,
      value_text TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  v5.exec('PRAGMA user_version = 5');
  v5.prepare(
    `INSERT INTO config_docs (key, value_text, updated_at)
       VALUES ('profile.json', '{}', '2026-08-06T09:00:00Z')`,
  ).run();
  v5.close();

  const upgraded = openJobsDb(dbPath);
  assert.equal(userVersion(upgraded), LATEST_SCHEMA_VERSION);
  assert.equal(userVersion(upgraded), 6);
  const tables = (
    upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
  assert.ok(tables.includes('run_intents'));
  const configRow = upgraded
    .prepare('SELECT value_text FROM config_docs WHERE key = ?')
    .get('profile.json') as { value_text: string } | undefined;
  assert.equal(configRow?.value_text, '{}');
  upgraded.close();
});
