import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpReachableCheck } from './check.ts';
import type { OwnershipDeps } from './foreign/index.ts';
import { DEFAULT_USER_DATA_DIR } from './launcher.ts';
import type { ChromePidfileDeps } from './ownership/index.ts';

const WS = 'ws://127.0.0.1:9222/devtools/browser/abc';
const OWNED_VERSION = { Browser: 'Chrome', webSocketDebuggerUrl: WS };

function ownership(dir: string | undefined): OwnershipDeps {
  return {
    readUserDataDir: async () => dir,
    realpath: (path) => path,
    platform: 'darwin',
  };
}

function fakePidfileDeps(hasPidfile: boolean): ChromePidfileDeps {
  return {
    existsSync: () => hasPidfile,
    readFileSync: () =>
      JSON.stringify({ pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' }),
    writeFileSync: () => {},
    mkdirSync: () => {},
    unlinkSync: () => {},
    pidIsAlive: () => true,
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  };
}

test('cdpReachableCheck: ok when reachable resolves truthy and a live pid file exists', async () => {
  const check = cdpReachableCheck({
    reachable: async () => OWNED_VERSION,
    ownership: ownership(DEFAULT_USER_DATA_DIR),
    port: 9222,
    pidfileDeps: fakePidfileDeps(true),
  });
  const finding = await check.run();
  assert.equal(check.name, 'cdp-reachable');
  assert.equal(finding.status, 'ok');
  assert.match(finding.detail, /:9222/);
});

test('cdpReachableCheck: warn when reachable resolves null', async () => {
  const check = cdpReachableCheck({
    reachable: async () => null,
    port: 9222,
    pidfileDeps: fakePidfileDeps(true),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /will be launched on demand/);
});

test('cdpReachableCheck: warn when reachable throws', async () => {
  const check = cdpReachableCheck({
    reachable: async () => {
      throw new Error('boom');
    },
    pidfileDeps: fakePidfileDeps(true),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
});

test('cdpReachableCheck: defaults to DEFAULT_CDP_PORT when no port is injected', async () => {
  const check = cdpReachableCheck({
    reachable: async () => OWNED_VERSION,
    ownership: ownership(DEFAULT_USER_DATA_DIR),
    pidfileDeps: fakePidfileDeps(true),
  });
  const finding = await check.run();
  assert.match(finding.detail, /:9222/);
});

test('cdpReachableCheck: never throws even when reachable rejects', async () => {
  const check = cdpReachableCheck({
    reachable: async () => {
      throw new Error('boom');
    },
    pidfileDeps: fakePidfileDeps(true),
  });
  await assert.doesNotReject(() => check.run());
});

test('cdpReachableCheck: warn (not red) when reachable but no live pid file exists — names the accumulation risk', async () => {
  const check = cdpReachableCheck({
    reachable: async () => OWNED_VERSION,
    ownership: ownership(DEFAULT_USER_DATA_DIR),
    port: 9222,
    pidfileDeps: fakePidfileDeps(false),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /never recycle/);
  assert.match(finding.detail, /accumulate memory/);
});

test('cdpReachableCheck: foreign user-data-dir -> warn (not red) with the ForeignChromeError message', async () => {
  const check = cdpReachableCheck({
    reachable: async () => OWNED_VERSION,
    port: 9222,
    userDataDir: '/ours',
    pidfileDeps: fakePidfileDeps(true),
    ownership: ownership('/Users/me/Chrome'),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.equal(
    finding.detail,
    "Chrome on CDP port :9222 is not Job Bunny's — it runs --user-data-dir=/Users/me/Chrome (expected /ours). Job Bunny will not attach to or close it. Close that Chrome, then rerun.",
  );
});

test('cdpReachableCheck: an unprovable Chrome (dir unreadable) is foreign too, with an unknown dir', async () => {
  const check = cdpReachableCheck({
    reachable: async () => OWNED_VERSION,
    port: 9222,
    userDataDir: '/ours',
    pidfileDeps: fakePidfileDeps(true),
    ownership: ownership(undefined),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /an unknown user-data-dir \(expected \/ours\)/);
});
