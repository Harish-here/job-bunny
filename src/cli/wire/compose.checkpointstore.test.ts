import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wire } from './compose.ts';
import { dataPath, fakeReadFile, profilePath } from './testkit.ts';

/**
 * compose.checkpointstore.test.ts (checkpoints-to-db Phase 2 Task 4, split
 * alongside compose.test.ts/compose.runstore.test.ts to stay under the
 * 800-line test-file cap) — exercises `wire()`'s new `ctx.checkpointStore`
 * wiring: present on every profile regardless of connector, and never
 * itself the cause of a `jobbunny.db` file appearing on disk (mirrors
 * `compose.runstore.test.ts`'s lazy-open pin for `runStore`).
 */

const LIVE_PROFILE_JSON = JSON.stringify({
  lanes: ['greenhouse', 'keka'],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: ['cleanup'],
  settings: { notion: { dbId: 'db-1' }, telegram: { chatId: 7 } },
});

test('wire: ctx.checkpointStore duck-types as a CheckpointStore (has write/readLatest/latestTimeDir/latestCheckpointTimeDir/nextTimeDir/pruneOlderThan/close)', async () => {
  const result = await wire('rajni', {
    root: '/repo',
    readFile: fakeReadFile({ [profilePath('rajni')]: LIVE_PROFILE_JSON }),
  });

  assert.equal(typeof result.ctx.checkpointStore.write, 'function');
  assert.equal(typeof result.ctx.checkpointStore.readLatest, 'function');
  assert.equal(typeof result.ctx.checkpointStore.latestTimeDir, 'function');
  assert.equal(typeof result.ctx.checkpointStore.latestCheckpointTimeDir, 'function');
  assert.equal(typeof result.ctx.checkpointStore.nextTimeDir, 'function');
  assert.equal(typeof result.ctx.checkpointStore.pruneOlderThan, 'function');
  assert.equal(typeof result.ctx.checkpointStore.close, 'function');
});

test('wire: never creates jobbunny.db on disk as a side effect of constructing the checkpoint store (SqliteCheckpointStore lazy-open)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-checkpointstore-'));
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
