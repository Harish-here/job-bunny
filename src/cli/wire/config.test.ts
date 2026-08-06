import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFilterConfig, loadPipelineConfig } from './config.ts';
import { fakeConfigStore } from './testkit.ts';

/**
 * config.test.ts (P8, split from wire.test.ts; converted to `ConfigStore`
 * fixtures by config→db Phase 4 Task 4) — exercises the config loaders via
 * a fake in-memory `ConfigStore` only. No real adapter is imported here —
 * depcruise's `only-wire-imports-adapters` rule forbids it for every file
 * under `src/cli` except `cli/wire/compose.ts` (and `registry.ts`'s
 * type-only exception — see its doc comment; see `.dependency-cruiser.cjs`).
 */

// --- loadPipelineConfig ---

const VALID_PROFILE_JSON = JSON.stringify({
  lanes: ['linkedin'],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: [],
  settings: { notion: { dbId: 'db-1' }, telegram: { chatId: 7 } },
});

test('loadPipelineConfig: parses a valid v2-shaped profile.json', async () => {
  const config = await loadPipelineConfig('rajni', {
    configStore: fakeConfigStore({ 'profile.json': VALID_PROFILE_JSON }),
  });

  assert.equal(config.connector, 'notion');
  assert.deepEqual(config.lanes, ['linkedin']);
  assert.deepEqual(config.notifiers, ['telegram']);
});

test('loadPipelineConfig: throws loudly when profile.json is missing', async () => {
  await assert.rejects(() =>
    loadPipelineConfig('rajni', { configStore: fakeConfigStore({}) }),
  );
});

test('loadPipelineConfig: throws loudly when profile.json fails schema validation', async () => {
  await assert.rejects(() =>
    loadPipelineConfig('rajni', {
      configStore: fakeConfigStore({
        'profile.json': JSON.stringify({ lanes: ['linkedin'] }),
      }),
    }),
  );
});

test('loadPipelineConfig: throws loudly when profile.json is not valid JSON', async () => {
  await assert.rejects(() =>
    loadPipelineConfig('rajni', {
      configStore: fakeConfigStore({ 'profile.json': 'not json' }),
    }),
  );
});

// --- loadFilterConfig ---

const VALID_FILTER_JSON = JSON.stringify({
  locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
});

test('loadFilterConfig: parses a valid filter.json', async () => {
  const filterCfg = await loadFilterConfig('rajni', {
    configStore: fakeConfigStore({ 'filter.json': VALID_FILTER_JSON }),
  });

  assert.deepEqual(filterCfg?.locations, [
    { city: 'Chennai', country: 'India', workTypes: ['onsite'] },
  ]);
});

test('loadFilterConfig: returns undefined when filter.json is missing', async () => {
  const filterCfg = await loadFilterConfig('rajni', {
    configStore: fakeConfigStore({}),
  });

  assert.equal(filterCfg, undefined);
});

test('loadFilterConfig: throws loudly when filter.json fails schema validation', async () => {
  await assert.rejects(() =>
    loadFilterConfig('rajni', {
      configStore: fakeConfigStore({
        'filter.json': JSON.stringify({
          locations: [{ city: '' }],
        }),
      }),
    }),
  );
});
