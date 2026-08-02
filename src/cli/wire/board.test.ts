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

  // 'malformed' — unparsable JSON.
  writeProfile('malformed', '{ not json');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('wireBoard — listProfiles', () => {
  test('discovers directories, sorted, tolerant of malformed profile.json', () => {
    const source = wireBoard({ root });
    const profiles = source.listProfiles();
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
});

describe('wireBoard — openStore', () => {
  test('opens a real store for a valid sqlite profile with a db file', () => {
    const source = wireBoard({ root });
    const store = source.openStore('a');
    assert.ok(store);
    assert.equal(typeof store.listJobs, 'function');
    assert.equal(typeof store.getJob, 'function');
    assert.equal(typeof store.updateTracking, 'function');
    assert.equal(typeof store.close, 'function');
    source.close();
  });

  test('returns null for a discovered profile with no db (notion connector)', () => {
    const source = wireBoard({ root });
    assert.equal(source.openStore('b'), null);
    source.close();
  });

  test('returns null for an unknown profile name', () => {
    const source = wireBoard({ root });
    assert.equal(source.openStore('does-not-exist'), null);
    source.close();
  });

  test('traversal probe: "../a" is rejected by the membership gate', () => {
    const source = wireBoard({ root });
    assert.equal(source.openStore('../a'), null);
    source.close();
  });

  test('traversal probe: "a/../a" is rejected by the membership gate', () => {
    const source = wireBoard({ root });
    assert.equal(source.openStore('a/../a'), null);
    source.close();
  });

  test('memoizes: two openStore("a") calls return the same reference', () => {
    const source = wireBoard({ root });
    const first = source.openStore('a');
    const second = source.openStore('a');
    assert.equal(first, second);
    source.close();
  });

  test('close() then openStore("a") returns a fresh, working instance', () => {
    const source = wireBoard({ root });
    const first = source.openStore('a');
    source.close();
    const second = source.openStore('a');
    assert.ok(second);
    assert.notEqual(first, second);
    assert.deepEqual(second.listJobs({}), { rows: [], total: 0 });
    source.close();
  });

  test('openStore on a hasDb-false profile never creates the db file', () => {
    const source = wireBoard({ root });
    const dbPath = path.join(profileDir('b'), 'data', 'jobbunny.db');
    assert.equal(existsSync(dbPath), false);
    assert.equal(source.openStore('b'), null);
    assert.equal(existsSync(dbPath), false);
    source.close();
  });
});
