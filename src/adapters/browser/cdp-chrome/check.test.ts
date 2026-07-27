import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpReachableCheck } from './check.ts';
import type { ChromePidfileDeps } from './ownership/index.ts';

function fakePidfileDeps(hasPidfile: boolean): ChromePidfileDeps {
  return {
    existsSync: () => hasPidfile,
    readFileSync: () =>
      JSON.stringify({ pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' }),
    writeFileSync: () => {},
    unlinkSync: () => {},
    pidIsAlive: () => true,
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  };
}

test('cdpReachableCheck: ok when reachable resolves truthy and a live pid file exists', async () => {
  const check = cdpReachableCheck({
    reachable: async () => ({ Browser: 'Chrome' }),
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
    reachable: async () => ({ Browser: 'Chrome' }),
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
    reachable: async () => ({ Browser: 'Chrome' }),
    port: 9222,
    pidfileDeps: fakePidfileDeps(false),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /never recycle/);
  assert.match(finding.detail, /accumulate memory/);
});
