/**
 * board_daemon.test.ts (UI phase 1, Task 7) — TDD for
 * `readBoardDaemonStatus` against a REAL temporary home: the pidfile is
 * written by hand (never through `acquireDaemonPidfile`/`daemon.ts`'s own
 * tick), and pid liveness is injected (`BoardDaemonOverrides.pidIsAlive`)
 * rather than relying on a real OS process — mirrors `board.test.ts`'s own
 * "no `src/adapters/**` import" posture (this file imports none either).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { readBoardDaemonStatus } from './board_daemon.ts';

let root: string;

function pidfilePath(): string {
  return path.join(root, '.jobbunny-daemon.pid');
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-daemon-wire-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('no pidfile at all is stopped, with null fields and an empty profile list', async () => {
  const status = await readBoardDaemonStatus({ root, pidIsAlive: () => true });
  assert.deepEqual(status, {
    state: 'stopped',
    pid: null,
    startedAt: null,
    lastTickAt: null,
    inFlight: null,
    profiles: [],
  });
});

test('a pidfile whose pid is not alive is stopped, with null fields', async () => {
  writeFileSync(
    pidfilePath(),
    JSON.stringify({
      pid: 4242,
      startedAt: '2026-08-07T09:00:00.000Z',
      lastTickAt: new Date().toISOString(), // fresh — irrelevant, pid is dead.
      attempts: [],
    }),
  );

  const status = await readBoardDaemonStatus({ root, pidIsAlive: () => false });
  assert.deepEqual(status, {
    state: 'stopped',
    pid: null,
    startedAt: null,
    lastTickAt: null,
    inFlight: null,
    profiles: [],
  });
});

test('a live pid with a fresh lastTickAt is running', async () => {
  const startedAt = '2026-08-07T09:00:00.000Z';
  const lastTickAt = new Date().toISOString();
  writeFileSync(
    pidfilePath(),
    JSON.stringify({
      pid: 4242,
      startedAt,
      lastTickAt,
      inFlight: {
        pid: 4300,
        profile: 'rajni',
        startedAt: '2026-08-07T09:59:00.000Z',
      },
      attempts: [],
    }),
  );

  const status = await readBoardDaemonStatus({ root, pidIsAlive: () => true });
  assert.deepEqual(status, {
    state: 'running',
    pid: 4242,
    startedAt,
    lastTickAt,
    inFlight: { pid: 4300, profile: 'rajni', startedAt: '2026-08-07T09:59:00.000Z' },
    profiles: [],
  });
});

test('a live pid with a lastTickAt older than 5 minutes is stale', async () => {
  const startedAt = '2026-08-07T09:00:00.000Z';
  const lastTickAt = new Date(Date.now() - 6 * 60_000).toISOString(); // 6 min ago.
  writeFileSync(
    pidfilePath(),
    JSON.stringify({
      pid: 4242,
      startedAt,
      lastTickAt,
      attempts: [],
    }),
  );

  const status = await readBoardDaemonStatus({ root, pidIsAlive: () => true });
  assert.deepEqual(status, {
    state: 'stale',
    pid: 4242,
    startedAt,
    lastTickAt,
    inFlight: null,
    profiles: [],
  });
});
