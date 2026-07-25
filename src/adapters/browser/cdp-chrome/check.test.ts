import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpReachableCheck } from './check.ts';

test('cdpReachableCheck: ok when reachable resolves truthy', async () => {
  const check = cdpReachableCheck({
    reachable: async () => ({ Browser: 'Chrome' }),
    port: 9222,
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
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
});

test('cdpReachableCheck: defaults to DEFAULT_CDP_PORT when no port is injected', async () => {
  const check = cdpReachableCheck({ reachable: async () => ({ Browser: 'Chrome' }) });
  const finding = await check.run();
  assert.match(finding.detail, /:9222/);
});

test('cdpReachableCheck: never throws even when reachable rejects', async () => {
  const check = cdpReachableCheck({
    reachable: async () => {
      throw new Error('boom');
    },
  });
  await assert.doesNotReject(() => check.run());
});
