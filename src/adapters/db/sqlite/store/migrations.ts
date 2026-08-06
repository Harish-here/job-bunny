/**
 * openJobsDb — the ONLY place the sqlite schema is defined or evolved.
 * Forward-only migrations keyed on PRAGMA user_version: MIGRATIONS[n]
 * upgrades a v(n) database to v(n+1). Never edit a shipped migration —
 * append a new one. A file stamped newer than LATEST_SCHEMA_VERSION
 * throws loud (downgrade protection; doctor reports the same as red).
 *
 * Two ownership zones (local-DB spec §3): `jobs` is written only by the
 * pipeline (via SqliteConnector); `tracking` is reserved for the app
 * server (PR 4) and PR 2's Notion import — created now so both have a home.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LATEST_SCHEMA_VERSION = 4;

const MIGRATIONS: readonly string[] = [
  // v0 -> v1
  `
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
  `,
  // v1 -> v2: runs observability (Phase 1 — see run_store port)
  `
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
  `,
  // v2 -> v3: checkpoints (Phase 2 — see checkpoint_store port)
  `
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
  `,
  // v3 -> v4: state_docs (Phase 3 — see state_store port)
  `
  CREATE TABLE state_docs (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

export function openJobsDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  let version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (version > LATEST_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `jobbunny.db schema v${version} is newer than this build supports (v${LATEST_SCHEMA_VERSION})`,
    );
  }
  while (version < LATEST_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`no migration defined from schema v${version}`);
    db.exec('BEGIN');
    try {
      db.exec(step);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version += 1;
  }
  return db;
}
