/**
 * board_autostart_control.test.ts (settings-overhaul task 13
 * `setBoardAutostart`; moved here, out of `board_daemon_control.test.ts`,
 * when the fix round's F13 split `setBoardAutostart` into its own sibling
 * module). SAFETY: per task 13's own explicit constraint, every test here
 * stubs BOTH `platform` and `listLaunchAgentFiles`/`writeFile`/`unlink`/
 * `runLaunchctl` — none of them ever writes, loads, or unloads a real
 * LaunchAgent on this or any machine.
 *
 * The last test below is F13's own regression test — RED against the
 * pre-fix `setBoardAutostart` (which discarded `runEnable`'s exit code
 * entirely and returned `{outcome:'ok'}` even when a legacy pre-v2 plist
 * blocked the write), GREEN once `setBoardAutostart` throws
 * `HttpError(409, 'autostart_conflict', ...)` for that case instead. It
 * drives a REAL `LEGACY_PLIST_REGEX`-matching filename through the REAL
 * `runEnable` (`cli/commands/autostart.ts`) that `setBoardAutostart`
 * itself calls — not a synthetic stand-in for the outcome mapping.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HttpError } from '../../app/shared/index.ts';
import { setBoardAutostart } from './board_autostart_control.ts';

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-autostart-control-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  return mkdtempSync(path.join(root, 'run-'));
}

function fakeAutostartOverrides(overrides: {
  platform: NodeJS.Platform;
  writeFileCalls?: Array<{ path: string; data: string }>;
  unlinkCalls?: string[];
  launchctlCalls?: string[][];
  listLaunchAgentFiles?: () => string[];
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
      return overrides.listLaunchAgentFiles?.() ?? [];
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

// --- F13 regression: darwin legacy-plist conflict must not read as 'ok' ---

test('setBoardAutostart: enable on darwin with a legacy pre-v2 plist present throws HttpError(409), no plist written, launchctl never called', async () => {
  const writeFileCalls: Array<{ path: string; data: string }> = [];
  const launchctlCalls: string[][] = [];
  const overrides = fakeAutostartOverrides({
    platform: 'darwin',
    writeFileCalls,
    launchctlCalls,
    // Matches `LEGACY_PLIST_REGEX` in `cli/commands/serve/index.ts` — the
    // real gate `runEnable` checks, exercised through the real function,
    // not a synthetic stand-in for its outcome.
    listLaunchAgentFiles: () => ['com.jobbunny.2023.plist'],
  });

  await assert.rejects(
    () => setBoardAutostart(true, overrides),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'autostart_conflict');
      return true;
    },
  );
  assert.equal(writeFileCalls.length, 0);
  assert.equal(launchctlCalls.length, 0);
});

test('setBoardAutostart: disable on darwin with a legacy pre-v2 plist present still succeeds (the gate is enable-only)', async () => {
  const unlinkCalls: string[] = [];
  const launchctlCalls: string[][] = [];
  const outcome = await setBoardAutostart(
    false,
    fakeAutostartOverrides({
      platform: 'darwin',
      unlinkCalls,
      launchctlCalls,
      listLaunchAgentFiles: () => ['com.jobbunny.2023.plist'],
    }),
  );
  assert.deepEqual(outcome, { outcome: 'ok' });
});
