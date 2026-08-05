import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wire } from './compose.ts';
import { dataPath, fakeReadFile, profilePath } from './testkit.ts';

/**
 * compose.runstore.test.ts (P8 Task 4, split alongside compose.test.ts to
 * stay under the 800-line test-file cap) — exercises `wire()`'s new
 * `ctx.runStore` wiring: present on every profile regardless of connector,
 * and never itself the cause of a `jobbunny.db` file appearing on disk
 * (pins ledger L13's lazy-open decision).
 */

const LIVE_PROFILE_JSON = JSON.stringify({
  lanes: ['greenhouse', 'keka'],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: ['cleanup'],
  settings: { notion: { dbId: 'db-1' }, telegram: { chatId: 7 } },
});

test('wire: ctx.runStore duck-types as a RunStore (has startRun/finishRun)', async () => {
  const result = await wire('rajni', {
    root: '/repo',
    readFile: fakeReadFile({ [profilePath('rajni')]: LIVE_PROFILE_JSON }),
  });

  assert.equal(typeof result.ctx.runStore.startRun, 'function');
  assert.equal(typeof result.ctx.runStore.finishRun, 'function');
  assert.equal(typeof result.ctx.runStore.close, 'function');
});

test('wire: never creates jobbunny.db on disk as a side effect (SqliteRunStore lazy-open, ledger L13)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-runstore-'));
  try {
    await wire('rajni', {
      root,
      readFile: fakeReadFile({ [profilePath('rajni', root)]: LIVE_PROFILE_JSON }),
    });

    assert.ok(!existsSync(join(dataPath('rajni', root), 'jobbunny.db')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wire: a sqlite profile still gets exactly one sqlite-db-openable check (no duplicate from the run-store wiring)', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: { sqlite: {} },
  });

  const result = await wire('rajni', {
    root: '/repo',
    readFile: fakeReadFile({ [profilePath('rajni')]: profileJson }),
  });

  assert.equal(result.checks.filter((c) => c.name === 'sqlite-db-openable').length, 1);
});

test('wire: a non-sqlite profile also gets a sqlite-db-openable doctor check (unconditional run-store check)', async () => {
  const result = await wire('rajni', {
    root: '/repo',
    readFile: fakeReadFile({ [profilePath('rajni')]: LIVE_PROFILE_JSON }),
  });

  assert.equal(result.ctx.config.connector, 'notion');
  assert.ok(result.checks.some((c) => c.name === 'sqlite-db-openable'));
});
