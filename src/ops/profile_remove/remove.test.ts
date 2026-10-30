import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { removeProfileDir, tombstonePath } from './remove.ts';

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-profile-remove-'));
  dir = path.join(root, 'profiles', 'victim');
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'jobbunny.db'), 'x');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('removeProfileDir', () => {
  test('removes the tree and leaves no tombstone behind', async () => {
    assert.deepEqual(await removeProfileDir(dir), { ok: true });
    assert.equal(existsSync(dir), false);
    assert.deepEqual(readdirSync(root), ['profiles']);
  });

  test('tombstone lives outside <root>/profiles and cannot match a profile name', () => {
    const tomb = tombstonePath(dir, 123);
    assert.equal(path.dirname(tomb), root);
    assert.match(path.basename(tomb), /^\.profile-removing-victim-123$/);
    assert.doesNotMatch(path.basename(tomb), /^[a-z0-9_-]+$/);
  });

  test('the profile path is gone BEFORE the slow delete runs', async () => {
    let existedDuringRm: boolean | undefined;
    const result = await removeProfileDir(dir, {
      rm: async () => {
        existedDuringRm = existsSync(dir);
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(existedDuringRm, false);
  });

  test('a missing directory counts as removed', async () => {
    rmSync(dir, { recursive: true });
    assert.deepEqual(await removeProfileDir(dir), { ok: true });
  });

  test('EPERM then success: retried with backoff, then removed', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await removeProfileDir(dir, {
      rename: async (from, to) => {
        calls++;
        if (calls <= 2) throw errno('EPERM');
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [50, 100]);
    assert.equal(existsSync(dir), false);
  });

  test('exhausted retries: clear error, profile untouched and still in place', async () => {
    let calls = 0;
    const result = await removeProfileDir(dir, {
      rename: async () => {
        calls++;
        throw errno('EBUSY');
      },
      sleep: async () => {},
    });
    assert.equal(calls, 6);
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /still in use/);
    assert.equal(existsSync(path.join(dir, 'data', 'jobbunny.db')), true);
  });

  test('a non-transient rename error fails immediately without retrying', async () => {
    let calls = 0;
    const result = await removeProfileDir(dir, {
      rename: async () => {
        calls++;
        throw errno('EXDEV');
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
  });

  test('rm failure after the rename reports the leftover tombstone', async () => {
    const result = await removeProfileDir(dir, {
      rm: async () => {
        throw errno('EBUSY');
      },
    });
    assert.equal(result.ok, false);
    const leftover = (result as { leftover?: string }).leftover;
    assert.ok(leftover && existsSync(leftover));
    assert.equal(existsSync(dir), false);
  });
});
