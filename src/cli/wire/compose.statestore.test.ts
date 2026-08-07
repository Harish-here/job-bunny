import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wire } from './compose.ts';
import { dataPath, fakeConfigStore } from './testkit.ts';

/**
 * compose.statestore.test.ts (pipeline-state-to-db Phase 3 Task 4, split
 * alongside compose.test.ts/compose.runstore.test.ts/
 * compose.checkpointstore.test.ts to stay under the 800-line test-file cap)
 * — exercises `wire()`'s new `ctx.stateStore` wiring: present on every
 * profile regardless of connector, and never itself the cause of a
 * `jobbunny.db` file appearing on disk (mirrors
 * `compose.checkpointstore.test.ts`'s lazy-open pin for `checkpointStore`).
 */

const LIVE_PROFILE_JSON = JSON.stringify({
  lanes: ['greenhouse', 'keka'],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: ['cleanup'],
  settings: { notion: { dbId: 'db-1' }, telegram: { chatId: 7 } },
});

test('wire: ctx.stateStore duck-types as a StateStore (has readDoc/writeDoc/close)', async () => {
  const result = await wire('rajni', {
    root: '/repo',
    configStore: fakeConfigStore({ 'profile.json': LIVE_PROFILE_JSON }),
  });

  assert.equal(typeof result.ctx.stateStore.readDoc, 'function');
  assert.equal(typeof result.ctx.stateStore.writeDoc, 'function');
  assert.equal(typeof result.ctx.stateStore.close, 'function');
});

test('wire: never creates jobbunny.db on disk as a side effect of constructing the state store (SqliteStateStore lazy-open)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-statestore-'));
  try {
    await wire('rajni', {
      root,
      configStore: fakeConfigStore({ 'profile.json': LIVE_PROFILE_JSON }),
    });

    assert.ok(!existsSync(join(dataPath('rajni', root), 'jobbunny.db')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
