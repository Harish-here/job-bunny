/**
 * board_daemon_control.test.ts (settings-overhaul, task 11) — TDD for
 * `stopBoardDaemon`, against a REAL temporary home for the pidfile (written
 * by hand, mirroring `board_daemon.test.ts`'s own posture) but with
 * `pidIsAlive`/`killPid`/`sleep` fully stubbed — NEVER a real OS process.
 * SAFETY: per this brief's own constraint, no test here spawns, signals, or
 * waits on anything but these in-memory stubs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { stopBoardDaemon } from './board_daemon_control.ts';

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
