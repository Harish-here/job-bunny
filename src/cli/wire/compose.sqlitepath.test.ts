/**
 * compose.sqlitepath.test.ts (fix-round, split alongside compose.test.ts /
 * compose.runstore.test.ts to stay under the 800-line test-file cap) —
 * `resolveSqlitePath` (builders.ts) is THE single authoritative
 * `jobbunny.db` path resolver: `wire()`'s run store, `wireMigrate`, and
 * `wireBoard` must all agree on the same path for a given profile,
 * regardless of `connector`. Real filesystem (a temp root), never the
 * `/repo`-literal fake `readFile` — `wireBoard` reads real files.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { wireBoard } from './board.ts';
import { resolveSqlitePath, wireMigrate } from './builders.ts';
import { wire } from './compose.ts';

test('resolveSqlitePath: no settings.sqlite -> defaultPath', () => {
  assert.equal(
    resolveSqlitePath(undefined, '/default/jobbunny.db'),
    '/default/jobbunny.db',
  );
  assert.equal(resolveSqlitePath({}, '/default/jobbunny.db'), '/default/jobbunny.db');
});

test('resolveSqlitePath: honors settings.sqlite.path unconditionally — no connector param at all', () => {
  assert.equal(
    resolveSqlitePath({ path: '/custom/mine.db' }, '/default/jobbunny.db'),
    '/custom/mine.db',
  );
});

test('resolveSqlitePath: a malformed slice degrades to defaultPath, never throws', () => {
  assert.equal(
    resolveSqlitePath({ path: 123 }, '/default/jobbunny.db'),
    '/default/jobbunny.db',
  );
  assert.equal(
    resolveSqlitePath('not an object', '/default/jobbunny.db'),
    '/default/jobbunny.db',
  );
});

let root: string;

function profileDir(name: string): string {
  return path.join(root, 'profiles', name);
}

function writeProfile(name: string, contents: unknown): void {
  mkdirSync(profileDir(name), { recursive: true });
  writeFileSync(path.join(profileDir(name), 'profile.json'), JSON.stringify(contents));
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jb-sqlitepath-'));
});

after(() => {
  // Windows enforces file locks that macOS/Linux don't: an open
  // `node:sqlite` `DatabaseSync` handle in this directory makes `rmSync`
  // fail EPERM instead of silently succeeding. Every handle opened by the
  // test below is closed before this hook runs (belt: `maxRetries`/
  // `retryDelay` also cover any lingering OS-level release delay).
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test('wire() run store, wireMigrate, and wireBoard all resolve the SAME db path for a notion profile with settings.sqlite.path set (finding: they used to disagree)', async () => {
  const customDbPath = path.join(root, 'custom', 'mine.db');
  writeProfile('nprof', {
    lanes: [],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-1' }, sqlite: { path: customDbPath } },
  });

  const { ctx } = await wire('nprof', { root });
  const runId = ctx.runStore.startRun({
    date: '2026-08-06',
    timeDir: '10-00',
    kind: 'run',
    startedAt: '2026-08-06T10:00:00.000Z',
  });
  assert.ok(runId > 0);

  // The run store wrote to the CUSTOM path, not the profile-derived default.
  assert.ok(existsSync(customDbPath));
  assert.ok(
    !existsSync(path.join(profileDir('nprof'), 'data', 'jobbunny.db')),
    'must not also create a second db at the default path',
  );

  const migrateWire = await wireMigrate('nprof', { root });
  assert.equal(migrateWire.dbPath, customDbPath);

  const board = wireBoard({ root });
  const profile = board.listProfiles().find((p) => p.name === 'nprof');
  assert.equal(profile?.hasDb, true);
  const store = board.openStore('nprof');
  assert.ok(store, 'wireBoard must open the SAME file the run store wrote to');
  assert.equal(store?.listRuns({}).total, 1);
  board.close();
  // `ctx.runStore` (the `SqliteRunStore` `wire()` built above) is a
  // SEPARATE handle on the same file — `board.close()` only closes the
  // board's own memoized stores. Must close before the `after` hook's
  // `rmSync`, or Windows' file lock turns cleanup into an EPERM.
  ctx.runStore.close();
});
