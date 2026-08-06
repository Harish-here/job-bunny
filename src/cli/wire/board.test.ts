import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { wireBoard } from './board.ts';

let root: string;

function profileDir(name: string): string {
  return path.join(root, 'profiles', name);
}

function writeProfile(name: string, contents: unknown): void {
  mkdirSync(profileDir(name), { recursive: true });
  writeFileSync(
    path.join(profileDir(name), 'profile.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-wire-'));

  // 'a' — a valid sqlite profile WITH a real db file. This test file may
  // not import `adapters/db/sqlite` (no test-file exemption from
  // `only-wire-imports-adapters` — only `board.ts` itself is carved out),
  // so the fixture db is a zero-byte file: sqlite treats that as a valid,
  // uninitialized database (`PRAGMA user_version` reads 0), and
  // `wireBoard`'s own `openStore` — which DOES import the real
  // `openJobsDb` — applies the real forward migrations on first open.
  writeProfile('a', { connector: 'sqlite' });
  const aDbPath = path.join(profileDir('a'), 'data', 'jobbunny.db');
  mkdirSync(path.dirname(aDbPath), { recursive: true });
  writeFileSync(aDbPath, '');

  // 'b' — connector: 'notion', no db file.
  writeProfile('b', { connector: 'notion' });

  // 'malformed' — unparsable JSON, no db file.
  writeProfile('malformed', '{ not json');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('wireBoard — listProfiles', () => {
  test('discovers directories, sorted, tolerant of malformed profile.json', async () => {
    const source = wireBoard({ root });
    const profiles = await source.listProfiles();
    assert.deepEqual(
      profiles.map((p) => p.name),
      ['a', 'b', 'malformed'],
    );
    const a = profiles.find((p) => p.name === 'a');
    assert.deepEqual(a, { name: 'a', connector: 'sqlite', hasDb: true });
    const b = profiles.find((p) => p.name === 'b');
    assert.deepEqual(b, { name: 'b', connector: 'notion', hasDb: false });
    const malformed = profiles.find((p) => p.name === 'malformed');
    assert.deepEqual(malformed, { name: 'malformed', connector: '', hasDb: false });
    source.close();
  });

  test("a profile whose jobbunny.db predates config_docs (schema v4) tolerates the missing table and lifts from its legacy profile.json (plumbing reaches SqliteConfigStore's own readonly tolerance)", async () => {
    writeProfile('legacy-db', { connector: 'sqlite' });
    const dbPath = path.join(profileDir('legacy-db'), 'data', 'jobbunny.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    // A zero-byte file opens fine as a valid, un-migrated (schema-v0,
    // definitely pre-config_docs) sqlite db — `SELECT ... FROM
    // config_docs` against it throws "no such table: config_docs", which
    // `SqliteConfigStore`'s readonly lift tolerates by falling back to
    // this profile's own legacy `profile.json` file.
    writeFileSync(dbPath, '');

    const source = wireBoard({ root });
    const profiles = await source.listProfiles();
    const legacy = profiles.find((p) => p.name === 'legacy-db');
    assert.deepEqual(legacy, { name: 'legacy-db', connector: 'sqlite', hasDb: true });
    source.close();
  });

  test('a corrupt jobbunny.db (readonly open throws for a reason OTHER than "no such table") still degrades connector to \'\' in listProfiles() output, rather than throwing out of listProfiles itself', async () => {
    writeProfile('corrupt', { connector: 'sqlite' });
    const dbDir = path.join(profileDir('corrupt'), 'data');
    mkdirSync(dbDir, { recursive: true });
    // A non-empty, non-sqlite file: `new DatabaseSync(path, { readOnly:
    // true })` throws "file is not a database" — a genuinely different
    // failure mode than the tolerated "no such table" case above, and one
    // `SqliteConfigStore`'s readonly mode does NOT tolerate (it propagates
    // loud, per that class's own doc comment). `readProfileInfo`'s
    // whole-probe try/catch is what keeps THIS module's discovery alive.
    writeFileSync(path.join(dbDir, 'jobbunny.db'), 'not a real sqlite file, just bytes');

    const source = wireBoard({ root });
    const profiles = await source.listProfiles();
    // Discovery for every OTHER profile must survive.
    assert.deepEqual(
      profiles.map((p) => p.name).sort(),
      ['a', 'b', 'corrupt', 'legacy-db', 'malformed'].sort(),
    );
    const corrupt = profiles.find((p) => p.name === 'corrupt');
    assert.equal(corrupt?.connector, '');
    assert.equal(corrupt?.hasDb, true); // the file exists, just unreadable.
    source.close();
  });
});

describe('wireBoard — openStore', () => {
  test('opens a real store for a valid sqlite profile with a db file', async () => {
    const source = wireBoard({ root });
    const store = await source.openStore('a');
    assert.ok(store);
    assert.equal(typeof store.listJobs, 'function');
    assert.equal(typeof store.getJob, 'function');
    assert.equal(typeof store.updateTracking, 'function');
    assert.equal(typeof store.close, 'function');
    source.close();
  });

  test('returns null for a discovered profile with no db (notion connector)', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.openStore('b'), null);
    source.close();
  });

  test('returns null for an unknown profile name', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.openStore('does-not-exist'), null);
    source.close();
  });

  test('traversal probe: "../a" is rejected by the membership gate', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.openStore('../a'), null);
    source.close();
  });

  test('traversal probe: "a/../a" is rejected by the membership gate', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.openStore('a/../a'), null);
    source.close();
  });

  test('memoizes: two openStore("a") calls return the same reference', async () => {
    const source = wireBoard({ root });
    const first = await source.openStore('a');
    const second = await source.openStore('a');
    assert.equal(first, second);
    source.close();
  });

  test('close() then openStore("a") returns a fresh, working instance', async () => {
    const source = wireBoard({ root });
    const first = await source.openStore('a');
    source.close();
    const second = await source.openStore('a');
    assert.ok(second);
    assert.notEqual(first, second);
    assert.deepEqual(second.listJobs({}), { rows: [], total: 0 });
    source.close();
  });

  test('openStore on a hasDb-false profile never creates the db file', async () => {
    const source = wireBoard({ root });
    const dbPath = path.join(profileDir('b'), 'data', 'jobbunny.db');
    assert.equal(existsSync(dbPath), false);
    assert.equal(await source.openStore('b'), null);
    assert.equal(existsSync(dbPath), false);
    source.close();
  });
});

describe('wireBoard — readConfigDoc/writeConfigDoc', () => {
  test('readConfigDoc lifts a legacy profile.json for a real profile', async () => {
    const source = wireBoard({ root });
    const text = await source.readConfigDoc('a', 'profile.json');
    assert.equal(text, JSON.stringify({ connector: 'sqlite' }));
    source.close();
  });

  test('readConfigDoc returns undefined for a doc never written/lifted', async () => {
    const source = wireBoard({ root });
    const text = await source.readConfigDoc('a', 'resume.json');
    assert.equal(text, undefined);
    source.close();
  });

  test('readConfigDoc returns undefined for an unknown profile name', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.readConfigDoc('does-not-exist', 'profile.json'), undefined);
    source.close();
  });

  test('readConfigDoc returns undefined for a traversal probe on name', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.readConfigDoc('../a', 'profile.json'), undefined);
    source.close();
  });

  test('writeConfigDoc round-trips through readConfigDoc for a real profile', async () => {
    const source = wireBoard({ root });
    const filterJson = JSON.stringify({ locations: [] });
    await source.writeConfigDoc('a', 'filter.json', filterJson);
    assert.equal(await source.readConfigDoc('a', 'filter.json'), filterJson);
    source.close();
  });

  test('writeConfigDoc surfaces the real validator message unmodified on an invalid doc', async () => {
    const source = wireBoard({ root });
    await assert.rejects(
      () => source.writeConfigDoc('a', 'filter.json', '{ not json'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^filter\.json is invalid:/);
        return true;
      },
    );
    source.close();
  });

  test('writeConfigDoc throws "unknown profile" for an unknown name', async () => {
    const source = wireBoard({ root });
    await assert.rejects(
      () => source.writeConfigDoc('does-not-exist', 'filter.json', '{}'),
      /unknown profile: does-not-exist/,
    );
    source.close();
  });
});

describe('wireBoard — createProfile', () => {
  test('happy path: all four docs readable afterward, db file exists', async () => {
    const source = wireBoard({ root });
    await source.createProfile('freshling');
    const profileJson = await source.readConfigDoc('freshling', 'profile.json');
    const filterJson = await source.readConfigDoc('freshling', 'filter.json');
    const searchUrls = await source.readConfigDoc('freshling', 'search_urls.md');
    assert.ok(profileJson);
    assert.ok(filterJson);
    assert.ok(searchUrls);
    // resume.json is deliberately never seeded (hand-maintained).
    assert.equal(await source.readConfigDoc('freshling', 'resume.json'), undefined);
    const dbPath = path.join(profileDir('freshling'), 'data', 'jobbunny.db');
    assert.equal(existsSync(dbPath), true);
    source.close();
  });

  test('duplicate name throws "profile already exists"', async () => {
    const source = wireBoard({ root });
    await assert.rejects(() => source.createProfile('a'), /profile already exists: a/);
    source.close();
  });

  test('bad name throws WITHOUT touching the filesystem', async () => {
    const source = wireBoard({ root });
    await assert.rejects(
      () => source.createProfile('Bad Name!'),
      /invalid profile name: Bad Name!/,
    );
    assert.equal(existsSync(profileDir('Bad Name!')), false);
    source.close();
  });
});
