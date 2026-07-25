import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('loadFilterConfig: parses a valid filter.json', async () => {
  const filterCfg = await loadFilterConfig('rajni', {
    root: '/repo',
    readFile: fakeReadFile({
      '/repo/profiles/rajni/filter.json': VALID_FILTER_JSON,
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
        '/repo/profiles/rajni/filter.json': JSON.stringify({
          locations: [{ city: '' }],
        }),
      }),
    }),
  );
});

// --- wire() ---

// Deliberately lane-less (unlike VALID_PROFILE_JSON): `linkedin`'s live
// construction needs a `filter.json`/`search_urls.md` this test
// doesn't provide, and that's not what's under test here — this test only
// exercises the missing-`NOTION_TOKEN` swallow behavior.
const NOTION_ONLY_PROFILE_JSON = JSON.stringify({
  lanes: [],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: [],
  settings: { notion: { dbId: 'db-1' }, telegram: { chatId: 7 } },
});

test('wire: does not throw when NOTION_TOKEN is missing (NotionApi construction failure is swallowed)', async () => {
  const originalToken = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    const result = await wire('rajni', {
      root: '/repo',
      readFile: fakeReadFile({
        '/repo/profiles/rajni/profile.json': NOTION_ONLY_PROFILE_JSON,
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

// --- wire(): live ctx/stages/routines composition ---
//
// These tests avoid `linkedin` (its live construction needs a real
// filesystem for inventories via `FsStorage`, and a browser port) so they
// can run entirely against the injected fake `readFile` — greenhouse/keka
// need no per-profile files at all. Adapter identity is asserted via each
// port's `.name`/`.kind`, never `instanceof` — this test file, like every
// file under `src/cli` except `wire.ts` itself, may not import
// `src/adapters/**` (depcruise's `only-wire-imports-adapters`).

const LIVE_PROFILE_JSON = JSON.stringify({
  lanes: ['greenhouse', 'keka'],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: ['cleanup'],
  settings: { notion: { dbId: 'db-1' }, telegram: { chatId: 7 } },
});

function fakeLiveReadFile(profileJson: string = LIVE_PROFILE_JSON) {
  return fakeReadFile({ '/repo/profiles/rajni/profile.json': profileJson });
}

test('wire: returns a live ctx with config/ports/storage/notify populated', async () => {
  const result = await wire('rajni', { root: '/repo', readFile: fakeLiveReadFile() });

  assert.equal(result.ctx.profile, 'rajni');
  assert.equal(result.ctx.config.connector, 'notion');
  assert.deepEqual(result.ctx.ports.lanes.map((l) => l.name).sort(), [
    'greenhouse',
    'keka',
  ]);
  assert.equal(result.ctx.ports.connector.name, 'notion');
  assert.deepEqual(
    result.ctx.ports.notifiers.map((n) => n.name),
    ['telegram'],
  );
  assert.equal(result.ctx.ports.llm?.name, 'claude-cli');
  assert.equal(result.ctx.ports.browser?.name, 'cdp-chrome');
  assert.equal(typeof result.ctx.storage.readJson, 'function');
  assert.equal(typeof result.ctx.notify, 'function');
});

// Regression pin, 2026-07-25: `ctx.storage` was rooted at the REPO root
// alongside the shared `page_inventory/` handle, so every per-stage artifact
// (`cache/`, `registry/`, `structure/`) landed in the repo root and two
// profiles shared one cache and one company registry. The first real run
// therefore read a 0-entry `registry/companies.json` it had just created
// instead of the profile's own, silently sourcing nothing from the ATS lanes
// while still reporting `passed`. The two roots must stay distinct.
test('wire: ctx.storage is rooted at the profile data dir, not the repo root', async () => {
  const result = await wire('rajni', { root: '/repo', readFile: fakeLiveReadFile() });

  assert.equal(
    (result.ctx.storage as unknown as { rootDir: string }).rootDir,
    '/repo/profiles/rajni/data',
  );
});

test('wire: stages is the 10 job-flow stages in spec order', async () => {
  const result = await wire('rajni', { root: '/repo', readFile: fakeLiveReadFile() });

  assert.deepEqual(
    result.stages.map((s) => s.name),
    [
      'reconcile',
      'farm',
      'source',
      'compress',
      'structure',
      'assemble',
      'filter',
      'dedup',
      'rank',
      'sync',
    ],
  );
});

test('wire: routines maps config.routines to instances', async () => {
  const result = await wire('rajni', { root: '/repo', readFile: fakeLiveReadFile() });

  assert.deepEqual(
    result.routines.map((r) => r.name),
    ['cleanup'],
  );
});

test('wire: unknown routine name throws loud', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'notion',
    notifiers: [],
    routines: ['not-a-real-routine'],
    settings: { notion: { dbId: 'db-1' } },
  });

  await assert.rejects(
    () => wire('rajni', { root: '/repo', readFile: fakeLiveReadFile(profileJson) }),
    /not-a-real-routine/,
  );
});

test('wire: unknown lane name throws loud (live construction, not just checks)', async () => {
  const profileJson = JSON.stringify({
    lanes: ['not-a-real-lane'],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-1' } },
  });

  await assert.rejects(
    () => wire('rajni', { root: '/repo', readFile: fakeLiveReadFile(profileJson) }),
    /not-a-real-lane/,
  );
});

test('wire: unknown connector name throws loud', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'not-a-real-connector',
    notifiers: [],
    routines: [],
    settings: {},
  });

  await assert.rejects(
    () => wire('rajni', { root: '/repo', readFile: fakeLiveReadFile(profileJson) }),
    /not-a-real-connector/,
  );
});

test('wire: unknown notifier name throws loud', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'notion',
    notifiers: ['not-a-real-notifier'],
    routines: [],
    settings: { notion: { dbId: 'db-1' } },
  });

  await assert.rejects(
    () => wire('rajni', { root: '/repo', readFile: fakeLiveReadFile(profileJson) }),
    /not-a-real-notifier/,
  );
});

test('wire: linkedin lane requires a FilterConfig, throws a clear error when absent', async () => {
  const profileJson = JSON.stringify({
    lanes: ['linkedin'],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-1' } },
  });

  await assert.rejects(
    () => wire('rajni', { root: '/repo', readFile: fakeLiveReadFile(profileJson) }),
    /filter/,
  );
});

test('wire: missing NOTION_TOKEN still resolves wire(), but the live connector rejects on first use', async () => {
  const originalToken = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    const result = await wire('rajni', { root: '/repo', readFile: fakeLiveReadFile() });

    await assert.rejects(
      () =>
        result.ctx.ports.connector.rebuildCache({
          profile: 'rajni',
          signal: new AbortController().signal,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          beat() {},
        }),
      /NOTION_TOKEN/,
    );
  } finally {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
  }
});

test('wire: filter defaults to parsed-{} FilterConfig when filter.json is absent (no rule drops anything)', async () => {
  const result = await wire('rajni', { root: '/repo', readFile: fakeLiveReadFile() });
  const filterStage = result.stages.find((s) => s.name === 'filter');
  assert.ok(filterStage);

  const job = {
    identity: {
      id: 'job-1',
      lane: 'greenhouse',
      url: 'https://example.com/job-1',
      company: 'Acme',
      title: 'Staff Engineer',
      scrapedAt: new Date().toISOString(),
    },
    structured: {
      titleParts: {},
      locations: [{ city: 'Nowhereville' }],
      skills: [],
    },
  };

  const output = await filterStage?.run(
    { jobs: [job], dropped: [] },
    {
      profile: 'rajni',
      signal: new AbortController().signal,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      beat() {},
      storage: result.ctx.storage,
    },
  );

  assert.equal(output?.jobs.length, 1);
  assert.equal(output?.dropped.length, 0);
});

test('wire: existing checks behavior is unchanged alongside the live ctx/stages/routines', async () => {
  const result = await wire('rajni', { root: '/repo', readFile: fakeLiveReadFile() });
  assert.ok(result.checks.length > 0);
  assert.ok(result.checks.some((c) => c.name.length > 0));
});

// --- linkedin lane: happy path ---
// Unlike greenhouse/keka, the linkedin lane's live construction reads a
// per-page `Inventory` via `loadInventory(storage, page)`, and `storage` is
// always a real `FsStorage(root)` inside `wire()` — there is no injectable
// Storage seam for the live composition path (only `readFile`/`root`, used
// above for profile.json/filter.json/search_urls.md). So this test
// uses a real temp directory as `root` and writes a real
// `page_inventory/<page>.json` file for `FsStorage` to read, while still
// routing profile.json/filter.json/search_urls.md through the same
// injected `readFile` seam every other test in this file uses.
function validInventoryJson(page: string): string {
  return JSON.stringify({
    page,
    pageType: 'details-page',
    generatedAt: '2026-01-01',
    selectors: {
      cardList: '.jobs-list',
      card: '.job-card',
      cardTitle: '.job-title',
      cardCompany: '.job-company',
      cardLocation: '.job-location',
      cardLink: 'a.job-link',
      jdRoot: '.jd-root',
    },
    behaviors: {},
  });
}

test('wire: linkedin lane builds successfully end to end (search_urls.md -> parseSearchUrls -> loadInventory -> LinkedInLane)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-linkedin-'));
  try {
    await mkdir(join(root, 'page_inventory'), { recursive: true });
    await writeFile(
      join(root, 'page_inventory', 'staff-eng.json'),
      validInventoryJson('staff-eng'),
      'utf8',
    );

    const profileJson = JSON.stringify({
      lanes: ['linkedin'],
      connector: 'notion',
      notifiers: [],
      routines: [],
      settings: { notion: { dbId: 'db-1' } },
    });
    const searchUrlsMd = [
      '## Staff Engineer searches',
      '### staff-eng',
      '  • US remote - https://www.linkedin.com/jobs/search/?keywords=staff+engineer',
    ].join('\n');
    const readFile = fakeReadFile({
      [join(root, 'profiles', 'rajni', 'profile.json')]: profileJson,
      [join(root, 'profiles', 'rajni', 'filter.json')]: JSON.stringify({}),
      [join(root, 'profiles', 'rajni', 'search_urls.md')]: searchUrlsMd,
    });

    const result = await wire('rajni', { root, readFile });

    const farmingLanes = result.ctx.ports.lanes.filter((l) => l.kind === 'farming');
    assert.equal(farmingLanes.length, 1);
    assert.equal(farmingLanes[0]?.name, 'linkedin');

    const farmStage = result.stages.find((s) => s.name === 'farm');
    assert.ok(farmStage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
