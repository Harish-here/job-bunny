import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openJobsDb } from '../store/index.ts';
import { SqliteConfigStore, type SqliteConfigStoreDeps } from './store.ts';

const stores: SqliteConfigStore[] = [];
const dirs: string[] = [];

function freshPaths(): { dbPath: string; profileRoot: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-configstore-'));
  dirs.push(dir);
  return { dbPath: path.join(dir, 'jobbunny.db'), profileRoot: dir };
}

function makeStore(dbPath: string, profileRoot: string, deps?: SqliteConfigStoreDeps) {
  const store = new SqliteConfigStore(dbPath, profileRoot, deps);
  stores.push(store);
  return store;
}

after(() => {
  // Windows enforces file locks that macOS/Linux don't: an open
  // `node:sqlite` `DatabaseSync` handle in a directory makes `rmSync` fail
  // EPERM instead of silently succeeding. Close every store constructed by
  // any test in this file before removing any of the temp dirs those
  // stores live in — precedent: `state/store.test.ts`.
  for (const store of stores) store.close();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

const rajniProfileJson = readFileSync(
  fileURLToPath(new URL('../../../../../profiles/rajni/profile.json', import.meta.url)),
  'utf8',
);

test('raw fidelity round-trip, byte-exact, including a trailing newline', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const store = makeStore(dbPath, profileRoot);
  const raw = '# Search URLs\n\n## linkedin\n';
  await store.writeText('search_urls.md', raw);
  const value = await store.readText('search_urls.md');
  assert.equal(value, raw);
});

test('lift validates before insert: malformed legacy file throws naming it, no row cemented', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const filePath = path.join(profileRoot, 'filter.json');
  writeFileSync(filePath, '{not valid');

  const store = makeStore(dbPath, profileRoot);
  await assert.rejects(
    () => store.readText('filter.json'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      return true;
    },
  );

  const db = openJobsDb(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) as n FROM config_docs WHERE key = 'filter.json'")
    .get() as { n: number };
  db.close();
  assert.equal(row.n, 0);
});

test('v0-keys profile.json lifts fine (JSON-validity only, never the strict schema)', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const filePath = path.join(profileRoot, 'profile.json');
  writeFileSync(filePath, rajniProfileJson);

  const store = makeStore(dbPath, profileRoot);
  const value = await store.readText('profile.json');
  assert.equal(value, rajniProfileJson);
});

test('lift path never calls the strict validator: JSON that would fail PipelineConfigSchema.parse still lifts', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const filePath = path.join(profileRoot, 'profile.json');
  const raw = '{"connector": 123}';
  writeFileSync(filePath, raw);

  const store = makeStore(dbPath, profileRoot);
  const value = await store.readText('profile.json');
  assert.equal(value, raw);
});

test('DB-wins-after-lift canary: a second read never looks at a mutated legacy file again', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const filePath = path.join(profileRoot, 'profile.json');
  writeFileSync(filePath, rajniProfileJson);

  const store = makeStore(dbPath, profileRoot);
  const first = await store.readText('profile.json');
  assert.equal(first, rajniProfileJson);

  writeFileSync(filePath, '{"connector": "notion"}');

  const second = await store.readText('profile.json');
  assert.equal(
    second,
    rajniProfileJson,
    'must come from the DB row, not the mutated file',
  );
});

test('loud posture: a broken db path throws instead of degrading', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-configstore-'));
  dirs.push(dir);
  const blockerFile = path.join(dir, 'blocker');
  writeFileSync(blockerFile, 'not a directory');
  const dbPath = path.join(blockerFile, 'sub', 'jobbunny.db');
  const store = makeStore(dbPath, dir);
  await assert.rejects(() => store.writeText('search_urls.md', '# x\n'));
});

test('writeText rejects invalid profile.json (bad connector type), no row written', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const store = makeStore(dbPath, profileRoot);
  await assert.rejects(() => store.writeText('profile.json', '{"connector": 123}'));

  const db = openJobsDb(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) as n FROM config_docs WHERE key = 'profile.json'")
    .get() as { n: number };
  db.close();
  assert.equal(row.n, 0);
});

test('writeText rejects invalid filter.json (blank skill string), no row written', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const store = makeStore(dbPath, profileRoot);
  await assert.rejects(() => store.writeText('filter.json', '{"skills":{"core":[""]}}'));

  const db = openJobsDb(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) as n FROM config_docs WHERE key = 'filter.json'")
    .get() as { n: number };
  db.close();
  assert.equal(row.n, 0);
});

test('writeText rejects invalid resume.json (not JSON), no row written', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const store = makeStore(dbPath, profileRoot);
  await assert.rejects(() => store.writeText('resume.json', 'not json'));

  const db = openJobsDb(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) as n FROM config_docs WHERE key = 'resume.json'")
    .get() as { n: number };
  db.close();
  assert.equal(row.n, 0);
});

test('writeText accepts valid, overwrites: readText sees the second write', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const store = makeStore(dbPath, profileRoot);
  await store.writeText('resume.json', '{"name":"a"}');
  await store.writeText('resume.json', '{"name":"b"}');
  const value = await store.readText('resume.json');
  assert.equal(value, '{"name":"b"}');
});

test('updated_at is set to the injected now() timestamp', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const fixed = new Date('2026-08-06T12:34:56.000Z');
  const store = makeStore(dbPath, profileRoot, { now: () => fixed });
  await store.writeText('resume.json', '{"name":"a"}');

  const db = openJobsDb(dbPath);
  const row = db
    .prepare('SELECT updated_at FROM config_docs WHERE key = ?')
    .get('resume.json') as { updated_at: string } | undefined;
  db.close();
  assert.equal(row?.updated_at, fixed.toISOString());
});

test('miss, no file: readText on a key with no DB row and no legacy file returns undefined', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const store = makeStore(dbPath, profileRoot);
  const value = await store.readText('search_urls.md');
  assert.equal(value, undefined);
});

test('close() releases the handle: rmSync with no retry options does not throw', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-configstore-close-'));
  const dbPath = path.join(dir, 'jobbunny.db');
  const store = new SqliteConfigStore(dbPath, dir);
  await store.writeText('resume.json', '{"name":"a"}');
  store.close();
  assert.doesNotThrow(() => rmSync(dir, { recursive: true, force: true }));
});

test('lazy open: constructing the store performs no file I/O', () => {
  const { dbPath, profileRoot } = freshPaths();
  makeStore(dbPath, profileRoot);
  assert.equal(existsSync(dbPath), false);
});

// --- liftMode: 'readonly' (Task 4 Part A) ---

test('readonly + no db file + legacy file present: lifts (returns the value) but creates no db and inserts no row', async () => {
  const { dbPath, profileRoot } = freshPaths();
  writeFileSync(path.join(profileRoot, 'resume.json'), '{"name":"a"}');

  const store = makeStore(dbPath, profileRoot, { liftMode: 'readonly' });
  const value = await store.readText('resume.json');
  assert.equal(value, '{"name":"a"}');
  assert.equal(existsSync(dbPath), false, 'readonly lift must never create the db file');

  // A fresh readwrite store on the same path finds no row for the key —
  // proves the readonly lift never inserted.
  const rwStore = makeStore(dbPath, profileRoot);
  const db = openJobsDb(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) as n FROM config_docs WHERE key = 'resume.json'")
    .get() as { n: number };
  db.close();
  assert.equal(row.n, 0);
  void rwStore;
});

test('readonly + db file exists on schema v5 with a real row: reads it normally', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const seedStore = makeStore(dbPath, profileRoot);
  await seedStore.writeText('resume.json', '{"name":"seeded"}');

  const readonlyStore = makeStore(dbPath, profileRoot, { liftMode: 'readonly' });
  const value = await readonlyStore.readText('resume.json');
  assert.equal(value, '{"name":"seeded"}');
});

test('readonly + db file exists but predates config_docs (v4): tolerates the missing table, falls back to the legacy file, never inserts', async () => {
  const { dbPath, profileRoot } = freshPaths();
  // Hand-build a v4 db: MIGRATIONS[0..3] (jobs/tracking/runs/run_events/
  // checkpoints/state_docs), stamped user_version=4 — same DDL literal as
  // migrations.test.ts's own "v4-stamped" test, minus config_docs (which
  // arrives only in v5).
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
  v4.close();

  writeFileSync(path.join(profileRoot, 'resume.json'), '{"name":"legacy-v4"}');

  const store = makeStore(dbPath, profileRoot, { liftMode: 'readonly' });
  const value = await store.readText('resume.json');
  assert.equal(value, '{"name":"legacy-v4"}');
});

test('readonly: writeText throws immediately naming the key, and never creates a db file', async () => {
  const { dbPath, profileRoot } = freshPaths();
  const store = makeStore(dbPath, profileRoot, { liftMode: 'readonly' });

  await assert.rejects(
    () => store.writeText('resume.json', '{"name":"a"}'),
    /SqliteConfigStore: writeText is unsupported in readonly lift mode \(key: resume\.json\)/,
  );
  assert.equal(existsSync(dbPath), false);
});

test('readonly: a genuinely corrupt db file still throws loud (not tolerated, unlike the missing-table case)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-configstore-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'jobbunny.db');
  // A blocker file where a real sqlite file is expected — DatabaseSync's
  // readOnly open of a non-sqlite file throws (corrupt-file stand-in).
  writeFileSync(dbPath, 'not a sqlite database');

  const store = makeStore(dbPath, dir, { liftMode: 'readonly' });
  await assert.rejects(() => store.readText('resume.json'));
});
