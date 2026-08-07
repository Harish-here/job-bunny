import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardRequest, RouteDef } from './router.ts';
import { matchRoute, param } from './router.ts';

const noop = () => ({ status: 200, body: null });

const routes: RouteDef[] = [
  { method: 'GET', path: '/api/profiles', handler: noop },
  {
    method: 'GET',
    path: '/api/profiles/:name/jobs/:id',
    handler: noop,
  },
  { method: 'PATCH', path: '/api/profiles/:name/jobs/:id', handler: noop },
];

test('matchRoute matches a literal path', () => {
  const result = matchRoute(routes, 'GET', '/api/profiles');
  assert.ok(result);
  assert.equal(result.route.path, '/api/profiles');
  assert.deepEqual(result.params, {});
});

test('matchRoute extracts multiple params', () => {
  const result = matchRoute(routes, 'GET', '/api/profiles/rajni/jobs/li-1');
  assert.ok(result);
  assert.deepEqual(result.params, { name: 'rajni', id: 'li-1' });
});

test('matchRoute returns null on method mismatch', () => {
  const result = matchRoute(routes, 'DELETE', '/api/profiles/rajni/jobs/li-1');
  assert.equal(result, null);
});

test('matchRoute matches a DELETE route and binds both params', () => {
  const deleteRoutes: RouteDef[] = [
    {
      method: 'DELETE',
      path: '/api/profiles/:name/run-intents/:id',
      handler: noop,
    },
  ];
  const result = matchRoute(deleteRoutes, 'DELETE', '/api/profiles/rajni/run-intents/7');
  assert.ok(result);
  assert.deepEqual(result.params, { name: 'rajni', id: '7' });
});

test('matchRoute returns null on a trailing slash', () => {
  const result = matchRoute(routes, 'GET', '/api/profiles/');
  assert.equal(result, null);
});

test('matchRoute returns null on extra segments', () => {
  const result = matchRoute(routes, 'GET', '/api/profiles/rajni/jobs/li-1/extra');
  assert.equal(result, null);
});

test('matchRoute decodes percent-encoded param values', () => {
  const result = matchRoute(routes, 'GET', '/api/profiles/ra%20jni/jobs/li-1');
  assert.ok(result);
  assert.equal(result.params.name, 'ra jni');
});

test('matchRoute keeps the raw segment on an invalid escape sequence', () => {
  const result = matchRoute(routes, 'GET', '/api/profiles/rajni/jobs/li-%');
  assert.ok(result);
  assert.equal(result.params.id, 'li-%');
});

test('param returns the value when present', () => {
  const req: BoardRequest = {
    params: { name: 'rajni' },
    query: new URLSearchParams(),
    body: undefined,
  };
  assert.equal(param(req, 'name'), 'rajni');
});

test('param throws HttpError(400, bad_request) when absent', async () => {
  const { HttpError } = await import('./http.ts');
  const req: BoardRequest = {
    params: {},
    query: new URLSearchParams(),
    body: undefined,
  };
  assert.throws(
    () => param(req, 'name'),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'bad_request');
      assert.equal(err.message, 'missing path param: name');
      return true;
    },
  );
});
