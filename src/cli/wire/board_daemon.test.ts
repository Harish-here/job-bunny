/**
 * board_daemon.test.ts (UI phase 1, Task 7) — TDD for
 * `readBoardDaemonStatus` against a REAL temporary home: the pidfile is
 * written by hand (never through `acquireDaemonPidfile`/`daemon.ts`'s own
 * tick), and pid liveness is injected (`BoardDaemonOverrides.pidIsAlive`)
 * rather than relying on a real OS process — mirrors `board.test.ts`'s own
 * "no `src/adapters/**` import" posture (this file imports none either).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('a scheduled profile flagged as degraded in the pidfile surfaces degraded=true with a non-null reason; every other scheduled profile stays degraded=false/null', async () => {
  mkdirSync(path.join(root, 'profiles', 'harish'), { recursive: true });
  writeFileSync(
    path.join(root, 'profiles', 'harish', 'profile.json'),
    JSON.stringify({ connector: 'sqlite', schedule: { times: ['09:00'] } }),
  );
  mkdirSync(path.join(root, 'profiles', 'rajni'), { recursive: true });
  writeFileSync(
    path.join(root, 'profiles', 'rajni', 'profile.json'),
    JSON.stringify({ connector: 'sqlite', schedule: { times: ['09:00'] } }),
  );
  writeFileSync(
    pidfilePath(),
    JSON.stringify({
      pid: 4242,
      startedAt: '2026-08-07T09:00:00.000Z',
      lastTickAt: new Date().toISOString(),
      attempts: [],
      degraded: [
        {
          profile: 'harish',
          schemaVersion: 8,
          buildVersion: 7,
          detectedAt: '2026-08-13T10:00:00.000Z',
        },
      ],
      schemaDriftNotifiedAt: null,
    }),
  );

  const status = await readBoardDaemonStatus({ root, pidIsAlive: () => true });
  const harish = status.profiles.find((p) => p.profile === 'harish');
  const rajni = status.profiles.find((p) => p.profile === 'rajni');
  assert.equal(harish?.degraded, true);
  assert.match(harish?.degradedReason ?? '', /v8/);
  assert.match(harish?.degradedReason ?? '', /v7/);
  assert.equal(harish?.schemaVersion, 8);
  assert.equal(harish?.buildVersion, 7);
  assert.equal(rajni?.degraded, false);
  assert.equal(rajni?.degradedReason, null);
  assert.equal(rajni?.schemaVersion, null);
  assert.equal(rajni?.buildVersion, null);
});
