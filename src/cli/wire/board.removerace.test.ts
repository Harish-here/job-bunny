/**
 * Regression pin for the intermittent CI failure
 * `ENOTEMPTY: directory not empty, rmdir '…/profiles/<name>/data'` from
 * `DELETE /api/profiles/:name` (e2e profile-lifecycle "…disappears from the
 * switcher").
 *
 * Cause: `removeProfile` ends in `await rm(profiles/<name>, { recursive })`,
 * a chain of async fs hops (readdir -> unlink children -> rmdir), and the
 * event loop serves other requests between hops. Every other request first
 * re-derives profile membership from disk (`listProfileInfos`), which still
 * lists the half-deleted directory, and `readProfileInfo` / `readConfigDoc`
 * open the db through a READONLY sqlite connection. A readonly connection
 * cannot checkpoint, so it (re)creates `jobbunny.db-shm` (and `-wal`) after
 * `rm` already unlinked them and never removes them on close. The next
 * `rmdir(data)` then fails ENOTEMPTY (500) and leaves the folder behind.
 * Nothing marks a profile as "being removed", so no request is refused
 * while the delete is in flight.
 *
 * Test 1 reproduces the ENOTEMPTY (probabilistic per delete, ~0.5%, so it
 * deletes many throwaway profiles; it fails with near-certainty on the
 * unfixed code and never on a fixed one). Test 2 pins the underlying gap
 * deterministically: a profile mid-removal must stop being served.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { BoardSource } from '../../ports/board.ts';
import { wireBoard } from './board.ts';

let root: string;
let board: BoardSource;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-rmrace-'));
  board = wireBoard({ root });
});

afterEach(() => {
  board.close();
  rmSync(root, { recursive: true, force: true });
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('removeProfile racing concurrent requests', () => {
  test('requests that probe the profile while rm is in flight must not break the delete', async () => {
    const ITERATIONS = 1000;
    const failures: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const name = `victim-${i}`;
      await board.createProfile(name);
      await board.openStore(name); // memoized, as after the SPA's earlier GETs
      let settled = false;
      const removal = board
        .removeProfile(name)
        .then(() => undefined)
        .catch((err: unknown) => String(err))
        .finally(() => {
          settled = true;
        });
      // What the SPA / the spec's own `expect.poll` do meanwhile:
      // GET /api/profiles and GET /api/profiles/:name/config/:doc.
      while (!settled) {
        await tick();
        if (settled) break;
        await board.listProfiles().catch(() => {});
        await board.readConfigDoc(name, 'profile.json').catch(() => {});
      }
      const error = await removal;
      const dir = path.join(root, 'profiles', name);
      if (error !== undefined || existsSync(dir)) {
        const left = existsSync(path.join(dir, 'data'))
          ? readdirSync(path.join(dir, 'data'))
          : [];
        failures.push(`${name}: ${error ?? 'removed'}; left in data/: ${left.join(',')}`);
      }
    }
    assert.deepEqual(
      failures,
      [],
      `removeProfile failed or left a folder behind in ${failures.length}/${ITERATIONS} deletes`,
    );
  });

  test('a profile whose removal is in flight is no longer served', async () => {
    const name = 'victim';
    await board.createProfile(name);
    await board.openStore(name);
    const dataDir = path.join(root, 'profiles', name, 'data');
    for (let i = 0; i < 3000; i++)
      writeFileSync(path.join(dataDir, `filler-${i}.txt`), 'x');

    const removal = board.removeProfile(name);
    await tick(); // the removal has passed its guards; the delete is mid-flight

    assert.equal(
      (await board.listProfiles()).some((p) => p.name === name),
      false,
      'listProfiles must not list a profile that is being removed',
    );
    assert.equal(
      await board.openIntents(name),
      null,
      'openIntents must refuse a profile that is being removed (it would reopen/create its db)',
    );
    assert.equal(
      await board.readConfigDoc(name, 'profile.json'),
      undefined,
      'readConfigDoc must treat a profile that is being removed as unknown',
    );
    assert.equal((await removal).outcome, 'removed');
    assert.equal(existsSync(path.join(root, 'profiles', name)), false);
    assert.deepEqual(readdirSync(root), ['profiles'], 'no tombstone left behind');
  });

  test('createProfile refuses a name whose removal is still in flight', async () => {
    const name = 'victim';
    await board.createProfile(name);
    await board.openStore(name);
    const dataDir = path.join(root, 'profiles', name, 'data');
    for (let i = 0; i < 3000; i++)
      writeFileSync(path.join(dataDir, `filler-${i}.txt`), 'x');

    let settled = false;
    const removal = board.removeProfile(name).finally(() => {
      settled = true;
    });
    await tick(); // guards passed, delete mid-flight
    assert.equal(settled, false, 'precondition: removal must still be in flight');

    await assert.rejects(
      board.createProfile(name),
      /^Error: profile already exists: victim/,
    );
    assert.equal((await removal).outcome, 'removed');
    assert.equal(existsSync(path.join(root, 'profiles', name)), false);

    // once the removal has settled the name is free again
    await board.createProfile(name);
    assert.equal(existsSync(path.join(root, 'profiles', name)), true);
  });
});
