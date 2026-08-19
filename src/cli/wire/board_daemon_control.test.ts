/**
 * board_daemon_control.test.ts (settings-overhaul, task 11 `stopBoardDaemon`;
 * task 12 adds `startBoardDaemon`; task 13 adds `setBoardAutostart`) — TDD
 * against a REAL temporary home for the pidfile (written by hand, mirroring
 * `board_daemon.test.ts`'s own posture) but with
 * `pidIsAlive`/`killPid`/`sleep`/`spawn` fully stubbed — NEVER a real OS
 * process. SAFETY: per this brief's own constraint, no test here spawns,
 * signals, or waits on anything but these in-memory stubs; the
 * `startBoardDaemon` tests below additionally stub `listLaunchAgentFiles`
 * and `home` (a throwaway subdirectory of the same tmpdir) so no test ever
 * touches the real `~/Library/LaunchAgents` or `~/.jobbunny/logs`. The
 * `setBoardAutostart` tests below stub BOTH `platform` and
 * `listLaunchAgentFiles`/`writeFile`/`unlink`/`runLaunchctl` — per task 13's
 * own explicit safety constraint, none of them ever writes, loads, or
 * unloads a real LaunchAgent on this or any machine.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { SpawnFn, SpawnHandle } from '../commands/serve/index.ts';
import {
  setBoardAutostart,
  startBoardDaemon,
  stopBoardDaemon,
} from './board_daemon_control.ts';

let root: string;

function pidfilePath(): string {
  return path.join(root, '.jobbunny-daemon.pid');
}

function writePidfile(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    pidfilePath(),
    JSON.stringify({
      pid: 4242,
      startedAt: '2026-08-07T09:00:00.000Z',
      lastTickAt: '2026-08-07T09:59:30.000Z',
      attempts: [],
      degraded: [],
      schemaDriftNotifiedAt: null,
      schemaDriftNoNotifierWarnedAt: null,
      schemaDriftNotifyFailedAt: null,
      slotGateDeclines: [],
      deferredNotifyAttempts: [],
      ...overrides,
    }),
  );
}

/** A no-op stub — no test in this file ever actually waits. */
const noSleep = async () => {};

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-daemon-control-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('no pidfile at all: already_stopped, no kill attempted', async () => {
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const outcome = await stopBoardDaemon({
    root: path.join(root, 'no-such-dir-here'),
    pidIsAlive: () => false,
    killPid: (pid, signal) => killCalls.push({ pid, signal }),
    sleep: noSleep,
  });
  assert.deepEqual(outcome, { outcome: 'already_stopped' });
  assert.deepEqual(killCalls, []);
});

test('daemon dies on SIGTERM, no in-flight child: stopped, pidfile released', async () => {
  writePidfile();
  const alive = new Set([4242]);
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const outcome = await stopBoardDaemon({
    root,
    pidIsAlive: (pid) => alive.has(pid),
    killPid: (pid, signal) => {
      killCalls.push({ pid, signal });
      if (signal === 'SIGTERM') alive.delete(pid); // dies immediately on SIGTERM
    },
    sleep: noSleep,
  });
  assert.deepEqual(outcome, { outcome: 'stopped' });
  assert.deepEqual(killCalls, [{ pid: 4242, signal: 'SIGTERM' }]);
});

test('daemon survives SIGTERM but dies on SIGKILL, in-flight child dies too: stopped', async () => {
  writePidfile({
    inFlight: { pid: 5300, profile: 'rajni', startedAt: '2026-08-07T09:59:00.000Z' },
  });
  const alive = new Set([4242, 5300]);
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const outcome = await stopBoardDaemon({
    root,
    pidIsAlive: (pid) => alive.has(pid),
    killPid: (pid, signal) => {
      killCalls.push({ pid, signal });
      if (signal === 'SIGKILL') alive.delete(pid); // needs the hard kill
    },
    sleep: noSleep,
  });
  assert.deepEqual(outcome, { outcome: 'stopped' });
  // Daemon fully escalated (SIGTERM then SIGKILL) BEFORE the child was ever
  // touched — D10's daemon-before-child ordering, asserted by call order.
  assert.deepEqual(killCalls, [
    { pid: 4242, signal: 'SIGTERM' },
    { pid: 4242, signal: 'SIGKILL' },
    { pid: 5300, signal: 'SIGTERM' },
    { pid: 5300, signal: 'SIGKILL' },
  ]);
});

test('daemon survives even SIGKILL: daemon_unresponsive, child never touched, pidfile untouched', async () => {
  writePidfile({
    inFlight: { pid: 5300, profile: 'rajni', startedAt: '2026-08-07T09:59:00.000Z' },
  });
  const alive = new Set([4242, 5300]);
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const outcome = await stopBoardDaemon({
    root,
    pidIsAlive: (pid) => alive.has(pid), // never removed — survives everything
    killPid: (pid, signal) => killCalls.push({ pid, signal }),
    sleep: noSleep,
  });
  // The exact false-success this design exists to prevent: NEVER
  // already_stopped for a daemon that outlived SIGKILL.
  assert.deepEqual(outcome, { outcome: 'daemon_unresponsive' });
  assert.notDeepEqual(outcome, { outcome: 'already_stopped' });
  // SIGKILL was attempted (full escalation ran) before the unresponsive
  // outcome fired, and the child pid (5300) was never signaled at all.
  assert.deepEqual(killCalls, [
    { pid: 4242, signal: 'SIGTERM' },
    { pid: 4242, signal: 'SIGKILL' },
  ]);
});

test('daemon dies but its in-flight child survives SIGKILL: child_unresponsive with childPid', async () => {
  writePidfile({
    inFlight: { pid: 5300, profile: 'rajni', startedAt: '2026-08-07T09:59:00.000Z' },
  });
  const alive = new Set([4242, 5300]);
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const outcome = await stopBoardDaemon({
    root,
    pidIsAlive: (pid) => alive.has(pid),
    killPid: (pid, signal) => {
      killCalls.push({ pid, signal });
      if (pid === 4242 && signal === 'SIGTERM') alive.delete(4242); // daemon dies fast
      // child 5300 never removed — survives everything
    },
    sleep: noSleep,
  });
  assert.deepEqual(outcome, { outcome: 'child_unresponsive', childPid: 5300 });
  assert.notDeepEqual(outcome, { outcome: 'already_stopped' });
  // Full escalation (SIGTERM then SIGKILL) was attempted on the CHILD
  // before the unresponsive outcome fired, after the daemon was confirmed
  // dead first (daemon-before-child ordering).
  assert.deepEqual(killCalls, [
    { pid: 4242, signal: 'SIGTERM' },
    { pid: 5300, signal: 'SIGTERM' },
    { pid: 5300, signal: 'SIGKILL' },
  ]);
});

// --- startBoardDaemon (task 12) -------------------------------------------

function freshRoot(): string {
  return mkdtempSync(path.join(root, 'start-'));
}

function fakeSpawn(
  pid: number | undefined,
  throwsSync = false,
): {
  spawn: SpawnFn;
  killCalls: string[];
} {
  const killCalls: string[] = [];
  const spawn: SpawnFn = () => {
    if (throwsSync) throw new Error('boom: spawn failed synchronously');
    const handle: SpawnHandle = {
      pid,
      on: () => {},
      kill: (signal) => {
        killCalls.push(signal);
        return true;
      },
      unref: () => {},
    };
    return handle;
  };
  return { spawn, killCalls };
}

test('startBoardDaemon: no existing pidfile, child comes up alive: started', async () => {
  const testRoot = freshRoot();
  const { spawn } = fakeSpawn(9001);
  const outcome = await startBoardDaemon({
    root: testRoot,
    home: testRoot,
    spawn,
    pidIsAlive: () => true, // the post-spawn alive-confirm sees the child up
    sleep: noSleep,
    listLaunchAgentFiles: () => [],
  });
  assert.deepEqual(outcome, { outcome: 'started' });
});

test('startBoardDaemon: a fresh (not-stale) pidfile already exists: already_running, spawn never called', async () => {
  const testRoot = freshRoot();
  writeFileSync(
    path.join(testRoot, '.jobbunny-daemon.pid'),
    JSON.stringify({
      pid: 4242,
      startedAt: '2026-08-19T09:00:00.000Z',
      lastTickAt: new Date().toISOString(), // fresh heartbeat — never stale
      attempts: [],
      degraded: [],
      schemaDriftNotifiedAt: null,
      schemaDriftNoNotifierWarnedAt: null,
      schemaDriftNotifyFailedAt: null,
      slotGateDeclines: [],
      deferredNotifyAttempts: [],
    }),
  );
  let spawnCalled = false;
  const outcome = await startBoardDaemon({
    root: testRoot,
    home: testRoot,
    spawn: () => {
      spawnCalled = true;
      throw new Error('must never spawn when a daemon is already running');
    },
    pidIsAlive: () => true, // the incumbent (4242) is genuinely alive
    sleep: noSleep,
    listLaunchAgentFiles: () => [],
  });
  assert.deepEqual(outcome, { outcome: 'already_running' });
  assert.equal(spawnCalled, false);
});

test('startBoardDaemon: the child dies immediately (post-spawn alive-confirm fails): spawn_failed, never already_running', async () => {
  const testRoot = freshRoot();
  const { spawn } = fakeSpawn(9002);
  const outcome = await startBoardDaemon({
    root: testRoot,
    home: testRoot,
    spawn,
    pidIsAlive: () => false, // the child never comes up
    sleep: noSleep,
    listLaunchAgentFiles: () => [],
  });
  assert.deepEqual(outcome, { outcome: 'spawn_failed' });
  assert.notDeepEqual(outcome, { outcome: 'already_running' });
});

test('startBoardDaemon: a synchronous spawn throw is caught: spawn_failed, never an unhandled exception', async () => {
  const testRoot = freshRoot();
  const { spawn } = fakeSpawn(undefined, true);
  const outcome = await startBoardDaemon({
    root: testRoot,
    home: testRoot,
    spawn,
    pidIsAlive: () => true,
    sleep: noSleep,
    listLaunchAgentFiles: () => [],
  });
  assert.deepEqual(outcome, { outcome: 'spawn_failed' });
});

// --- setBoardAutostart (task 13) ------------------------------------------

function fakeAutostartOverrides(overrides: {
  platform: NodeJS.Platform;
  writeFileCalls?: Array<{ path: string; data: string }>;
  unlinkCalls?: string[];
  launchctlCalls?: string[][];
  listLaunchAgentFilesCalled?: { value: boolean };
}) {
  const writeFileCalls = overrides.writeFileCalls ?? [];
  const unlinkCalls = overrides.unlinkCalls ?? [];
  const launchctlCalls = overrides.launchctlCalls ?? [];
  const listCalled = overrides.listLaunchAgentFilesCalled ?? { value: false };
  return {
    root: freshRoot(),
    platform: overrides.platform,
    home: freshRoot(),
    uid: 501,
    envPath: '/usr/bin:/bin',
    nodeBin: 'node',
    cliEntry: '/repo/src/cli/main.ts',
    listLaunchAgentFiles: () => {
      listCalled.value = true;
      return [];
    },
    writeFile: async (p: string, data: string) => {
      writeFileCalls.push({ path: p, data });
    },
    unlink: async (p: string) => {
      unlinkCalls.push(p);
    },
    runLaunchctl: async (args: string[]) => {
      launchctlCalls.push(args);
      return { exitCode: 0, stdout: '' };
    },
  };
}

test('setBoardAutostart: enable on a stubbed darwin platform writes the plist and bootstraps it: ok', async () => {
  const writeFileCalls: Array<{ path: string; data: string }> = [];
  const launchctlCalls: string[][] = [];
  const outcome = await setBoardAutostart(
    true,
    fakeAutostartOverrides({ platform: 'darwin', writeFileCalls, launchctlCalls }),
  );
  assert.deepEqual(outcome, { outcome: 'ok' });
  assert.equal(writeFileCalls.length, 1);
  assert.ok(writeFileCalls[0]?.path.endsWith('com.jobbunny.autostart.plist'));
  assert.deepEqual(launchctlCalls[0]?.[0], 'bootstrap');
});

test('setBoardAutostart: disable on a stubbed darwin platform bootouts and unlinks the plist: ok', async () => {
  const unlinkCalls: string[] = [];
  const launchctlCalls: string[][] = [];
  const outcome = await setBoardAutostart(
    false,
    fakeAutostartOverrides({ platform: 'darwin', unlinkCalls, launchctlCalls }),
  );
  assert.deepEqual(outcome, { outcome: 'ok' });
  assert.equal(launchctlCalls[0]?.[0], 'bootout');
  assert.equal(unlinkCalls.length, 1);
  assert.ok(unlinkCalls[0]?.endsWith('com.jobbunny.autostart.plist'));
});

test('setBoardAutostart: enable on a stubbed non-darwin platform: unsupported_platform, no side effect attempted', async () => {
  const writeFileCalls: Array<{ path: string; data: string }> = [];
  const launchctlCalls: string[][] = [];
  const listCalled = { value: false };
  const outcome = await setBoardAutostart(
    true,
    fakeAutostartOverrides({
      platform: 'win32',
      writeFileCalls,
      launchctlCalls,
      listLaunchAgentFilesCalled: listCalled,
    }),
  );
  assert.deepEqual(outcome, { outcome: 'unsupported_platform' });
  assert.equal(writeFileCalls.length, 0);
  assert.equal(launchctlCalls.length, 0);
  assert.equal(listCalled.value, false);
});

test('setBoardAutostart: disable on a stubbed non-darwin platform: unsupported_platform, no side effect attempted', async () => {
  const unlinkCalls: string[] = [];
  const launchctlCalls: string[][] = [];
  const listCalled = { value: false };
  const outcome = await setBoardAutostart(
    false,
    fakeAutostartOverrides({
      platform: 'linux',
      unlinkCalls,
      launchctlCalls,
      listLaunchAgentFilesCalled: listCalled,
    }),
  );
  assert.deepEqual(outcome, { outcome: 'unsupported_platform' });
  assert.equal(unlinkCalls.length, 0);
  assert.equal(launchctlCalls.length, 0);
  assert.equal(listCalled.value, false);
});
