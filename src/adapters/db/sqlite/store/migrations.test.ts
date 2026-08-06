import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
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

test('a db stamped newer than LATEST_SCHEMA_VERSION throws loud', () => {
  const dbPath = tmpDbPath();
  const db = openJobsDb(dbPath);
  db.exec('PRAGMA user_version = 99');
  db.close();
  assert.throws(() => openJobsDb(dbPath), /v99.*newer.*v3/s);
});

test('fresh :memory: db lands at v3 with runs + run_events + checkpoints tables', () => {
  const db = openJobsDb(':memory:');
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  assert.equal(LATEST_SCHEMA_VERSION, 3);
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

test('a v2-stamped db upgrades to v3 preserving existing runs rows', () => {
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
  assert.equal(userVersion(upgraded), 3);
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
