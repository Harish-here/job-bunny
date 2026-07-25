import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbReachableCheck, type NotionApiLike } from './check.ts';

function statusError(
  status: number,
  message = `HTTP ${status}`,
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function fakeApi(impl: NotionApiLike['queryDatabase']): NotionApiLike {
  return { queryDatabase: impl };
}

test('dbReachableCheck: ok on a successful query', async () => {
  const check = dbReachableCheck({
    api: fakeApi(async () => []),
    dbId: 'db-123',
  });
  const finding = await check.run();
  assert.equal(check.name, 'notion-db-reachable');
  assert.equal(finding.status, 'ok');
});

test('dbReachableCheck: red on a 401 auth error', async () => {
  const check = dbReachableCheck({
    api: fakeApi(async () => {
      throw statusError(401);
    }),
    dbId: 'db-123',
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /401/);
});

test('dbReachableCheck: red on a 404 not-found error', async () => {
  const check = dbReachableCheck({
    api: fakeApi(async () => {
      throw statusError(404, 'object_not_found');
    }),
    dbId: 'db-123',
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('dbReachableCheck: warn on a 500 transient error', async () => {
  const check = dbReachableCheck({
    api: fakeApi(async () => {
      throw statusError(500);
    }),
    dbId: 'db-123',
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
});

test('dbReachableCheck: warn on a network error with no status', async () => {
  const check = dbReachableCheck({
    api: fakeApi(async () => {
      throw new Error('ECONNRESET');
    }),
    dbId: 'db-123',
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /could not reach Notion/);
});

test('dbReachableCheck: warn when dbId is empty', async () => {
  const check = dbReachableCheck({
    api: fakeApi(async () => []),
    dbId: '',
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /no Notion DB configured/);
});

test('dbReachableCheck: never throws even when the api rejects', async () => {
  const check = dbReachableCheck({
    api: fakeApi(async () => {
      throw new Error('boom');
    }),
    dbId: 'db-123',
  });
  await assert.doesNotReject(() => check.run());
});
