import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineConfig } from '../core/config/schema.ts';
import type { DoctorCheck, DoctorFinding } from '../ports/doctor.ts';
import {
  type AdapterRegistry,
  assembleAdapterChecks,
  type CheckFactory,
  loadFilterConfig,
  loadPipelineConfig,
  type RuntimeDeps,
  wire,
} from './wire.ts';

/**
 * wire.test.ts (P8) — exercises the PURE registry-assembly logic
 * (`assembleAdapterChecks`) and the config loaders via a FAKE registry and
 * fake `readFile` only. No real adapter is imported here — depcruise's
 * `only-wire-imports-adapters` rule forbids it for every file under
 * `src/cli` except `wire.ts` itself (see `.dependency-cruiser.cjs`).
 */

function baseConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    lanes: [],
    connector: 'fake-connector',
    notifiers: [],
    routines: [],
    settings: {},
    ...overrides,
  };
}

function fakeFinding(name: string): DoctorFinding {
  return { check: name, status: 'ok', detail: `${name} ok` };
}

function fakeCheck(name: string): DoctorCheck {
  return { name, run: async () => fakeFinding(name) };
}

function fakeDeps(): RuntimeDeps {
  // A throwaway fake — nothing in assembleAdapterChecks touches this, only
  // real factories (not under test here) would.
  return {} as RuntimeDeps;
}

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(
    `ENOENT: no such file or directory, open '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function fakeReadFile(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    if (Object.hasOwn(files, path)) return files[path] as string;
    throw enoent(path);
  };
}

// --- assembleAdapterChecks ---

test('assembleAdapterChecks: resolves lanes/connector/notifiers via the registry, in order', () => {
  const seen: string[] = [];
  const factory = (name: string): CheckFactory => {
    return () => {
      seen.push(name);
      return [fakeCheck(name)];
    };
  };
  const registry: AdapterRegistry = {
    lanes: { 'lane-a': factory('lane-a'), 'lane-b': factory('lane-b') },
    connectors: { 'fake-connector': factory('fake-connector') },
    notifiers: { 'notifier-a': factory('notifier-a') },
  };
  const config = baseConfig({
    lanes: ['lane-a', 'lane-b'],
    notifiers: ['notifier-a'],
  });

  const checks = assembleAdapterChecks(config, registry, fakeDeps());

  assert.deepEqual(
    checks.map((c) => c.name),
    ['lane-a', 'lane-b', 'fake-connector', 'notifier-a'],
  );
  assert.deepEqual(seen, ['lane-a', 'lane-b', 'fake-connector', 'notifier-a']);
});

test('assembleAdapterChecks: a factory can contribute more than one check', () => {
  const registry: AdapterRegistry = {
    lanes: {
      linkedin: () => [fakeCheck('linkedin-inventory'), fakeCheck('linkedin-cdp')],
    },
    connectors: { 'fake-connector': () => [fakeCheck('fake-connector')] },
    notifiers: {},
  };
  const config = baseConfig({ lanes: ['linkedin'] });

  const checks = assembleAdapterChecks(config, registry, fakeDeps());

  assert.deepEqual(
    checks.map((c) => c.name),
    ['linkedin-inventory', 'linkedin-cdp', 'fake-connector'],
  );
});

test('assembleAdapterChecks: empty lanes/notifiers is handled (only the connector contributes)', () => {
  const registry: AdapterRegistry = {
    lanes: {},
    connectors: { 'fake-connector': () => [fakeCheck('fake-connector')] },
    notifiers: {},
  };
  const config = baseConfig();

  const checks = assembleAdapterChecks(config, registry, fakeDeps());

  assert.deepEqual(
    checks.map((c) => c.name),
    ['fake-connector'],
  );
});

test('assembleAdapterChecks: throws naming an unknown lane', () => {
  const registry: AdapterRegistry = {
    lanes: {},
    connectors: { 'fake-connector': () => [] },
    notifiers: {},
  };
  const config = baseConfig({ lanes: ['not-a-real-lane'] });

  assert.throws(
    () => assembleAdapterChecks(config, registry, fakeDeps()),
    /not-a-real-lane/,
  );
});

test('assembleAdapterChecks: throws naming an unknown connector', () => {
  const registry: AdapterRegistry = { lanes: {}, connectors: {}, notifiers: {} };
  const config = baseConfig({ connector: 'not-a-real-connector' });

  assert.throws(
    () => assembleAdapterChecks(config, registry, fakeDeps()),
    /not-a-real-connector/,
  );
});

test('assembleAdapterChecks: throws naming an unknown notifier', () => {
  const registry: AdapterRegistry = {
    lanes: {},
    connectors: { 'fake-connector': () => [] },
    notifiers: {},
  };
  const config = baseConfig({ notifiers: ['not-a-real-notifier'] });

  assert.throws(
    () => assembleAdapterChecks(config, registry, fakeDeps()),
    /not-a-real-notifier/,
  );
});

test('assembleAdapterChecks: passes the correct settings[name] slice into each factory', () => {
  const received: Record<string, unknown> = {};
  const spyFactory = (name: string): CheckFactory => {
    return (settings) => {
      received[name] = settings;
      return [];
    };
  };
  const registry: AdapterRegistry = {
    lanes: { linkedin: spyFactory('linkedin') },
    connectors: { notion: spyFactory('notion') },
    notifiers: { telegram: spyFactory('telegram') },
  };
  const config = baseConfig({
    lanes: ['linkedin'],
    connector: 'notion',
    notifiers: ['telegram'],
    settings: {
      linkedin: { foo: 1 },
      notion: { dbId: 'abc123' },
      telegram: { chatId: 42 },
    },
  });

  assembleAdapterChecks(config, registry, fakeDeps());

  assert.deepEqual(received.linkedin, { foo: 1 });
  assert.deepEqual(received.notion, { dbId: 'abc123' });
  assert.deepEqual(received.telegram, { chatId: 42 });
});

test('assembleAdapterChecks: a missing settings[name] slice passes undefined through (factory validates its own slice)', () => {
  const received: Record<string, unknown> = {};
  const registry: AdapterRegistry = {
    lanes: {},
    connectors: {
      notion: (settings) => {
        received.notion = settings;
        return [];
      },
    },
    notifiers: {},
  };
  const config = baseConfig({ connector: 'notion' });

  assembleAdapterChecks(config, registry, fakeDeps());

  assert.equal(received.notion, undefined);
});

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
    readFile: fakeReadFile({ '/repo/profiles/rajni/profile.json': VALID_PROFILE_JSON }),
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
        '/repo/profiles/rajni/profile.json': JSON.stringify({ lanes: ['linkedin'] }),
      }),
    }),
  );
});

test('loadPipelineConfig: throws loudly when profile.json is not valid JSON', async () => {
  await assert.rejects(() =>
    loadPipelineConfig('rajni', {
      root: '/repo',
      readFile: fakeReadFile({ '/repo/profiles/rajni/profile.json': 'not json' }),
    }),
  );
});

// --- loadFilterConfig ---

const VALID_FILTER_JSON = JSON.stringify({
  locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
});

test('loadFilterConfig: parses a valid filter_config.json', async () => {
  const filterCfg = await loadFilterConfig('rajni', {
    root: '/repo',
    readFile: fakeReadFile({
      '/repo/profiles/rajni/filter_config.json': VALID_FILTER_JSON,
    }),
  });

  assert.deepEqual(filterCfg?.locations, [
    { city: 'Chennai', country: 'India', workTypes: ['onsite'] },
  ]);
});

test('loadFilterConfig: returns undefined when filter_config.json is missing', async () => {
  const filterCfg = await loadFilterConfig('rajni', {
    root: '/repo',
    readFile: fakeReadFile({}),
  });

  assert.equal(filterCfg, undefined);
});

test('loadFilterConfig: throws loudly when filter_config.json fails schema validation', async () => {
  await assert.rejects(() =>
    loadFilterConfig('rajni', {
      root: '/repo',
      readFile: fakeReadFile({
        '/repo/profiles/rajni/filter_config.json': JSON.stringify({
          locations: [{ city: '' }],
        }),
      }),
    }),
  );
});

// --- wire() ---

test('wire: does not throw when NOTION_TOKEN is missing (NotionApi construction failure is swallowed)', async () => {
  const originalToken = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    const result = await wire('rajni', {
      root: '/repo',
      readFile: fakeReadFile({
        '/repo/profiles/rajni/profile.json': VALID_PROFILE_JSON,
      }),
    });

    // Resolves rather than rejecting, and still carries the core checks
    // (including the envTokensCheck red that reports the missing token)
    // even though the real `notion` connector factory ran with no api
    // handle to reach-check.
    assert.ok(result.checks.length > 0);
  } finally {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
  }
});
