import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFilterConfig, loadPipelineConfig } from './config.ts';
import { fakeReadFile, filterPath, profilePath } from './testkit.ts';

/**
 * config.test.ts (P8, split from wire.test.ts) — exercises the config
 * loaders via a fake `readFile` only. No real adapter is imported here —
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
    root: '/repo',
    readFile: fakeReadFile({ [profilePath('rajni')]: VALID_PROFILE_JSON }),
  });

  assert.equal(config.connector, 'notion');
  assert.deepEqual(config.lanes, ['linkedin']);
  assert.deepEqual(config.notifiers, ['telegram']);
});

test('loadPipelineConfig: throws loudly when profile.json is missing', async () => {
  await assert.rejects(() =>
    loadPipelineConfig('rajni', { root: '/repo', readFile: fakeReadFile({}) }),
  );
});

test('loadPipelineConfig: throws loudly when profile.json fails schema validation', async () => {
  await assert.rejects(() =>
    loadPipelineConfig('rajni', {
      root: '/repo',
      readFile: fakeReadFile({
        [profilePath('rajni')]: JSON.stringify({ lanes: ['linkedin'] }),
      }),
    }),
  );
});

test('loadPipelineConfig: throws loudly when profile.json is not valid JSON', async () => {
  await assert.rejects(() =>
    loadPipelineConfig('rajni', {
      root: '/repo',
      readFile: fakeReadFile({ [profilePath('rajni')]: 'not json' }),
    }),
  );
});

// --- loadFilterConfig ---

const VALID_FILTER_JSON = JSON.stringify({
  locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
});

test('loadFilterConfig: parses a valid filter.json', async () => {
  const filterCfg = await loadFilterConfig('rajni', {
    root: '/repo',
    readFile: fakeReadFile({
      [filterPath('rajni')]: VALID_FILTER_JSON,
    }),
  });

  assert.deepEqual(filterCfg?.locations, [
    { city: 'Chennai', country: 'India', workTypes: ['onsite'] },
  ]);
});

test('loadFilterConfig: returns undefined when filter.json is missing', async () => {
  const filterCfg = await loadFilterConfig('rajni', {
    root: '/repo',
    readFile: fakeReadFile({}),
  });

  assert.equal(filterCfg, undefined);
});

test('loadFilterConfig: throws loudly when filter.json fails schema validation', async () => {
  await assert.rejects(() =>
    loadFilterConfig('rajni', {
      root: '/repo',
      readFile: fakeReadFile({
        [filterPath('rajni')]: JSON.stringify({
          locations: [{ city: '' }],
        }),
      }),
    }),
  );
});
