import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineConfig } from '../../core/config/schema.ts';
import type { DoctorCheck, DoctorFinding } from '../../ports/doctor.ts';
import {
  type AdapterRegistry,
  assembleAdapterChecks,
  type CheckFactory,
  type RuntimeDeps,
} from './registry.ts';

/**
 * registry.test.ts (P8, split from wire.test.ts) — exercises the PURE
 * registry-assembly logic (`assembleAdapterChecks`) via a FAKE registry
 * only. No real adapter is imported here — depcruise's
 * `only-wire-imports-adapters` rule forbids it for every file under
 * `src/cli` except `cli/wire/compose.ts` (and `registry.ts`'s type-only
 * exception — see its doc comment; see `.dependency-cruiser.cjs`).
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
  return { sqliteDefaultPath: '/tmp/fake/jobbunny.db' } as RuntimeDeps;
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
