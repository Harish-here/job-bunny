/**
 * board_secrets.test.ts — direct TDD for `listBoardSecrets`/
 * `writeBoardSecret` against a REAL temporary home, mirroring
 * `board_daemon.test.ts`'s posture. The regression scenarios (process.env
 * visibility, explicit chmod 0o600) already live in `board.test.ts`
 * against the public `BoardSource` interface and are left there
 * unmodified — this file covers the module's own direct contract.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { listBoardSecrets, writeBoardSecret } from './board_secrets.ts';

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-secrets-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('listBoardSecrets: no .env file at all reads as absent for every key', async () => {
  const presence = await listBoardSecrets(path.join(root, 'no-such-dir'));
  assert.deepEqual(presence, { NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' });
});

test('writeBoardSecret upserts the key, and listBoardSecrets then reports it present', async () => {
  const original = process.env.NOTION_TOKEN;
  try {
    const chmodCalls: Array<{ path: string; mode: number }> = [];
    await writeBoardSecret(root, 'NOTION_TOKEN', 'secret-tok', async (p, mode) => {
      chmodCalls.push({ path: p, mode });
    });
    const presence = await listBoardSecrets(root);
    assert.deepEqual(presence, { NOTION_TOKEN: 'present', TELEGRAM_BOT_TOKEN: 'absent' });
    assert.deepEqual(chmodCalls, [{ path: path.join(root, '.env'), mode: 0o600 }]);
  } finally {
    if (original === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = original;
  }
});
