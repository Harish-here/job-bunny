import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardProfile, BoardSource } from '../../../ports/board.ts';
import { makeProfilesRoutes } from './routes.ts';

const PROFILES: BoardProfile[] = [
  { name: 'rajni', connector: 'sqlite', hasDb: true },
  { name: 'harish', connector: 'notion', hasDb: false },
];

function fakeSource(): BoardSource {
  return {
    listProfiles: async () => PROFILES,
    openStore: async () => null,
    close() {},
  };
}

test('GET /api/profiles returns listProfiles() verbatim', async () => {
  const routes = makeProfilesRoutes(fakeSource());
  assert.equal(routes.length, 1);
  const route = routes[0];
  assert.ok(route);
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/api/profiles');
  const res = await route.handler({
    params: {},
    query: new URLSearchParams(),
    body: undefined,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { profiles: PROFILES });
});
