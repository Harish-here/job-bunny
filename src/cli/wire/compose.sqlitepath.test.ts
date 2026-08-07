/**
 * compose.sqlitepath.test.ts (config→db Phase 4 Task 4 — rewritten; was
 * `resolveSqlitePath`'s own test file, now retired) — `canonicalDbPath`
 * (`builders.ts`) is THE single authoritative `jobbunny.db` path resolver:
 * `wire()`'s run store, `wireMigrate`, and `wireBoard` must all agree on the
 * same path for a given profile. Unlike the retired `resolveSqlitePath`, it
 * takes no settings input at all — there is nothing left to disagree about,
 * but the cross-component-agreement pin stays, now trivially true.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { wireBoard } from './board.ts';
import { assertSqlitePathRetired, canonicalDbPath } from './builders.ts';
import { wire } from './compose.ts';
import { wireMigrate } from './migrate.ts';

test('canonicalDbPath: always profiles/<name>/data/jobbunny.db, no settings input at all', () => {
  assert.equal(
    canonicalDbPath('/repo', 'rajni'),
    path.join('/repo', 'profiles', 'rajni', 'data', 'jobbunny.db'),
  );
  assert.equal(
    canonicalDbPath('/elsewhere', 'other-profile'),
    path.join('/elsewhere', 'profiles', 'other-profile', 'data', 'jobbunny.db'),
  );
});

test('assertSqlitePathRetired: throws the byte-exact message, naming the real profile, when settings.sqlite.path is present', () => {
  assert.throws(
    () =>
      assertSqlitePathRetired(
        {
          lanes: [],
          connector: 'sqlite',
          notifiers: [],
          routines: [],
          settings: { sqlite: { path: '/custom/mine.db' } },
        },
        'rajni',
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(
        err.message,
        'settings.sqlite.path is no longer supported — the database always lives at ' +
          'profiles/rajni/data/jobbunny.db; move the file there and delete the setting',
      );
      return true;
    },
  );
});

test('assertSqlitePathRetired: checks KEY presence, not validity — a malformed path value is still a violation', () => {
  assert.throws(() =>
    assertSqlitePathRetired(
      {
        lanes: [],
        connector: 'sqlite',
        notifiers: [],
        routines: [],
        settings: { sqlite: { path: 123 } },
      },
      'rajni',
    ),
  );
});

test('assertSqlitePathRetired: no settings.sqlite, or a settings.sqlite with no path key, never throws', () => {
  assert.doesNotThrow(() =>
    assertSqlitePathRetired(
      { lanes: [], connector: 'sqlite', notifiers: [], routines: [], settings: {} },
      'rajni',
    ),
  );
  assert.doesNotThrow(() =>
    assertSqlitePathRetired(
      {
        lanes: [],
        connector: 'sqlite',
        notifiers: [],
        routines: [],
        settings: { sqlite: { dryRun: false } },
      },
      'rajni',
    ),
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

test('wire() run store, wireMigrate, and wireBoard all resolve the SAME db path for a notion profile (finding: they used to disagree when settings.sqlite.path existed)', async () => {
  writeProfile('nprof', {
    lanes: [],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-1' } },
  });
  const expectedDbPath = canonicalDbPath(root, 'nprof');

  const { ctx, configStore } = await wire('nprof', { root });
  const runId = ctx.runStore.startRun({
    date: '2026-08-06',
    timeDir: '10-00',
    kind: 'run',
    startedAt: '2026-08-06T10:00:00.000Z',
  });
  assert.ok(runId > 0);
  assert.ok(existsSync(expectedDbPath));

  const migrateWire = await wireMigrate('nprof', { root });
  assert.equal(migrateWire.dbPath, expectedDbPath);

  const board = wireBoard({ root });
  const profiles = await board.listProfiles();
  const profile = profiles.find((p) => p.name === 'nprof');
  assert.equal(profile?.hasDb, true);
  const store = await board.openStore('nprof');
  assert.ok(store, 'wireBoard must open the SAME file the run store wrote to');
  assert.equal(store?.listRuns({}).total, 1);
  board.close();
  // `ctx.runStore` (the `SqliteRunStore` `wire()` built above) is a
  // SEPARATE handle on the same file — `board.close()` only closes the
  // board's own memoized stores. Must close before the `after` hook's
  // `rmSync`, or Windows' file lock turns cleanup into an EPERM.
  ctx.runStore.close();
  // `wire()`'s internal `SqliteConfigStore` (config→db Phase 4) is a THIRD
  // separate handle on the same file, never closed by `wire()` itself
  // (checks may still need it) — same Windows-EPERM reasoning as
  // `ctx.runStore` above.
  assert.ok(configStore, 'wire() without a configStore override always sets one');
  configStore.close();
});
