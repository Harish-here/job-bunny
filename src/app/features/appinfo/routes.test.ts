/**
 * routes.test.ts — TDD for `makeAppInfoRoutes`. Same fake request/response
 * shape as `board/routes.test.ts` (no `src/adapters/**` import anywhere in
 * this file).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardRequest } from '../../shared/index.ts';
import { makeAppInfoRoutes } from './routes.ts';

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

test('GET /api/app returns the injected version', async () => {
  const [route] = makeAppInfoRoutes('9.9.9');
  assert.ok(route);
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/api/app');
  const res = await route.handler(req());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { version: '9.9.9' });
});
