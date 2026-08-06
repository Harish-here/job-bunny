import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openJobsDb } from '../store/index.ts';
import { SqliteConfigStore } from './store.ts';

const stores: SqliteConfigStore[] = [];
const dirs: string[] = [];

function freshPaths(): { dbPath: string; profileRoot: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-configstore-'));
  dirs.push(dir);
  return { dbPath: path.join(dir, 'jobbunny.db'), profileRoot: dir };
}

function makeStore(dbPath: string, profileRoot: string, deps?: { now?: () => Date }) {
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
