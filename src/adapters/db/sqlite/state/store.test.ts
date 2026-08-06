import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { z } from 'zod';
import { openJobsDb } from '../store/index.ts';
import { SqliteStateStore } from './store.ts';

const stores: SqliteStateStore[] = [];
const dirs: string[] = [];

function freshPaths(): { dbPath: string; dataDir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-statestore-'));
  dirs.push(dir);
  return { dbPath: path.join(dir, 'jobbunny.db'), dataDir: path.join(dir, 'data') };
}

function makeStore(dbPath: string, dataDir: string, deps?: { now?: () => Date }) {
  const store = new SqliteStateStore(dbPath, dataDir, deps);
  stores.push(store);
  return store;
}

after(() => {
  // Windows enforces file locks that macOS/Linux don't: an open
  // `node:sqlite` `DatabaseSync` handle in a directory makes `rmSync` fail
  // EPERM instead of silently succeeding. Close every store constructed by
  // any test in this file before removing any of the temp dirs those
  // stores live in — precedent: `src/cli/wire/compose.sqlitepath.test.ts`.
  for (const store of stores) store.close();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

const CompaniesSchema = z.array(z.string());

test('CRUD round-trip: writeDoc then readDoc with a matching schema returns a deep-equal value', async () => {
  const { dbPath, dataDir } = freshPaths();
  const store = makeStore(dbPath, dataDir);
  await store.writeDoc('registry/companies.json', ['acme', 'globex']);
  const value = await store.readDoc('registry/companies.json', CompaniesSchema);
  assert.deepEqual(value, ['acme', 'globex']);
});

test('overwrite: writeDoc the same key twice with different values; readDoc sees the second', async () => {
  const { dbPath, dataDir } = freshPaths();
  const store = makeStore(dbPath, dataDir);
  await store.writeDoc('registry/companies.json', ['acme']);
  await store.writeDoc('registry/companies.json', ['acme', 'initech']);
  const value = await store.readDoc('registry/companies.json', CompaniesSchema);
  assert.deepEqual(value, ['acme', 'initech']);
});

test('miss, no file: readDoc on a key with no DB row and no legacy file returns undefined', async () => {
  const { dbPath, dataDir } = freshPaths();
  const store = makeStore(dbPath, dataDir);
  const value = await store.readDoc('registry/api_seen.json', CompaniesSchema);
  assert.equal(value, undefined);
});

test('miss, with file: lifts the legacy file into the DB, and the file survives unchanged', async () => {
  const { dbPath, dataDir } = freshPaths();
  const key = 'registry/companies.json';
  const filePath = path.join(dataDir, key);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const originalContent = JSON.stringify(['legacy-co']);
  writeFileSync(filePath, originalContent);

  const store = makeStore(dbPath, dataDir);
  const value = await store.readDoc(key, CompaniesSchema);
  assert.deepEqual(value, ['legacy-co']);

  // (b) file still exists with its original content afterward.
  assert.equal(readFileSync(filePath, 'utf8'), originalContent);

  // (c) a raw SELECT against state_docs now has a row for that key.
  const db = openJobsDb(dbPath);
  const row = db.prepare('SELECT value_json FROM state_docs WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  db.close();
  assert.ok(row);
  assert.deepEqual(JSON.parse(row.value_json), ['legacy-co']);
});

test('canary: after the first lift, the DB wins — a second read never looks at a mutated legacy file again', async () => {
  const { dbPath, dataDir } = freshPaths();
  const key = 'registry/companies.json';
  const filePath = path.join(dataDir, key);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(['legacy-co']));

  const store = makeStore(dbPath, dataDir);
  const first = await store.readDoc(key, CompaniesSchema);
  assert.deepEqual(first, ['legacy-co']);

  // Mutate the legacy file on disk with DIFFERENT content.
  writeFileSync(filePath, JSON.stringify(['mutated-co']));

  const second = await store.readDoc(key, CompaniesSchema);
  assert.deepEqual(
    second,
    ['legacy-co'],
    'must come from the DB row, not the mutated file',
  );
});

test('malformed legacy file throws loud, naming the file path', async () => {
  const { dbPath, dataDir } = freshPaths();
  const key = 'registry/broken.json';
  const filePath = path.join(dataDir, key);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '{not valid json');

  const store = makeStore(dbPath, dataDir);
  await assert.rejects(
    () => store.readDoc(key, CompaniesSchema),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      return true;
    },
  );
});

test('schema mismatch on a real DB row throws', async () => {
  const { dbPath, dataDir } = freshPaths();
  const key = 'registry/companies.json';
  const store = makeStore(dbPath, dataDir);
  await store.writeDoc(key, ['acme']);
  const IncompatibleSchema = z.object({ notAnArray: z.string() });
  await assert.rejects(() => store.readDoc(key, IncompatibleSchema));
});

test('loud posture: a broken db path throws instead of degrading', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-statestore-'));
  const blockerFile = path.join(dir, 'blocker');
  writeFileSync(blockerFile, 'not a directory');
  const dbPath = path.join(blockerFile, 'sub', 'jobbunny.db');
  const dataDir = path.join(dir, 'data');
  const store = makeStore(dbPath, dataDir);
  await assert.rejects(() => store.writeDoc('registry/companies.json', ['acme']));
});

test('updated_at is set to the injected now() timestamp', async () => {
  const { dbPath, dataDir } = freshPaths();
  const fixed = new Date('2026-08-06T12:34:56.000Z');
  const store = makeStore(dbPath, dataDir, { now: () => fixed });
  await store.writeDoc('registry/companies.json', ['acme']);

  const db = openJobsDb(dbPath);
  const row = db
    .prepare('SELECT updated_at FROM state_docs WHERE key = ?')
    .get('registry/companies.json') as { updated_at: string } | undefined;
  db.close();
  assert.equal(row?.updated_at, fixed.toISOString());
});

test('close() releases the handle: rmSync with no retry options does not throw', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-statestore-close-'));
  const dbPath = path.join(dir, 'jobbunny.db');
  const dataDir = path.join(dir, 'data');
  const store = new SqliteStateStore(dbPath, dataDir);
  await store.writeDoc('registry/companies.json', ['acme']);
  store.close();
  assert.doesNotThrow(() => rmSync(dir, { recursive: true, force: true }));
});

test('lazy open: constructing the store performs no file I/O', () => {
  const { dbPath, dataDir } = freshPaths();
  makeStore(dbPath, dataDir);
  assert.equal(existsSync(dbPath), false);
});
