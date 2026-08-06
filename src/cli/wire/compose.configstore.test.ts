import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { wire } from './compose.ts';

/**
 * compose.configstore.test.ts (config→db Phase 4 Task 4, mirrors
 * `compose.statestore.test.ts`'s structure) — `configStore` is NOT exposed
 * on `ctx` (unlike `stateStore`/`checkpointStore`/`runStore`; it's an
 * internal wiring detail of `wire()` itself, consumed only during config
 * loading and lane construction), so this file instead pins `wire()`'s
 * `configLiftMode`-gated create-vs-never-create behavior against REAL
 * legacy files on disk (not a `fakeConfigStore` — those never lift, so they
 * can't exercise this distinction at all). `canonicalDbPath`'s own pure
 * behavior and `assertSqlitePathRetired`'s exact message (as a direct unit
 * test) are pinned in `compose.sqlitepath.test.ts` instead, which already
 * owns both; this file adds only the one thing that test file's `/repo`
 * literal + `fakeReadFile`-free style can't cover — a full `wire()` call
 * surfacing the same throw for real.
 */

const dirs: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-wire-configstore-'));
  dirs.push(dir);
  return dir;
}

function writeLegacyProfile(root: string, name: string, contents: unknown): void {
  const profileDir = path.join(root, 'profiles', name);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify(contents));
}

after(() => {
  // Windows file-lock belt, same precedent as every other real-fs wire test
  // in this module.
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('wire: configLiftMode "readonly" + a legacy-only profile (real file, no db yet) lifts successfully but never creates jobbunny.db', async () => {
  const root = freshRoot();
  writeLegacyProfile(root, 'legacy', {
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: {},
  });
  const dbPath = path.join(root, 'profiles', 'legacy', 'data', 'jobbunny.db');

  const result = await wire('legacy', { root, configLiftMode: 'readonly' });

  assert.equal(result.ctx.config.connector, 'sqlite');
  assert.equal(existsSync(dbPath), false, 'readonly lift must never create the db file');
});

test('wire: default (readwrite) mode + the SAME legacy-only profile DOES create jobbunny.db (the lift cements a config_docs row) — sibling to the updated Phase-1 invariant, scoped here for symmetry', async () => {
  const root = freshRoot();
  writeLegacyProfile(root, 'legacy2', {
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: {},
  });
  const dbPath = path.join(root, 'profiles', 'legacy2', 'data', 'jobbunny.db');

  const result = await wire('legacy2', { root });

  assert.equal(result.ctx.config.connector, 'sqlite');
  assert.equal(
    existsSync(dbPath),
    true,
    'readwrite lift must create the db file (the INSERT requires openJobsDb to open it)',
  );
  result.ctx.runStore.close();
});

test("wire: settings.sqlite.path throws assertSqlitePathRetired's exact message, for real, through the full wire() call", async () => {
  const root = freshRoot();
  writeLegacyProfile(root, 'retired', {
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: { sqlite: { path: '/custom/mine.db' } },
  });

  await assert.rejects(
    () => wire('retired', { root }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(
        err.message,
        'settings.sqlite.path is no longer supported — the database always lives at ' +
          'profiles/retired/data/jobbunny.db; move the file there and delete the setting',
      );
      return true;
    },
  );
});
