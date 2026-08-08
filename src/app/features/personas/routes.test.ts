import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONA_CATALOG } from '../../../core/personas/index.ts';
import { makePersonasRoutes } from './routes.ts';

test('makePersonasRoutes: registers exactly one GET route', () => {
  const routes = makePersonasRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.method, 'GET');
  assert.equal(routes[0]?.path, '/api/personas');
});

test('GET /api/personas returns the catalog verbatim', async () => {
  const routes = makePersonasRoutes();
  const handler = routes[0]?.handler;
  assert.ok(handler);
  const res = await handler({
    params: {},
    query: new URLSearchParams(),
    body: undefined,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, PERSONA_CATALOG);
});

test('the response body is the catalog object itself, not a copy', async () => {
  const routes = makePersonasRoutes();
  const handler = routes[0]?.handler;
  assert.ok(handler);
  const res = await handler({
    params: {},
    query: new URLSearchParams(),
    body: undefined,
  });
  assert.equal(res.body, PERSONA_CATALOG);
});
