import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { JD } from '../../core/jd/index.ts';
import type { RunContext } from '../../ports/context.ts';
import { mirrorReachableCheck } from './builders.ts';
import { wire } from './compose.ts';
import { wireMigrate } from './migrate.ts';
import { dataPath, fakeConfigStore } from './testkit.ts';

/**
 * compose.test.ts (P8, split from wire.test.ts) — exercises `wire()`'s live
 * ctx/stages/routines composition end to end. Adapter identity is asserted
 * via `.name`/`.kind`, never `instanceof` — like every file under `src/cli`
 * except `compose.ts` itself (and `registry.ts`'s type-only exception), this
 * file may not import `src/adapters/**` (depcruise's `only-wire-imports-adapters`).
 */

// --- wire() ---

// Deliberately lane-less (unlike VALID_PROFILE_JSON in config.test.ts):
// `linkedin`'s live construction needs a `filter.json`/`search_urls.md`
// this test doesn't provide, and that's not what's under test here — this
// test only exercises the missing-`NOTION_TOKEN` swallow behavior.
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
      configStore: fakeConfigStore({ 'profile.json': NOTION_ONLY_PROFILE_JSON }),
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
// These tests avoid `linkedin` (its live construction needs a real
// filesystem for inventories via `FsStorage`, and a browser port) so they
// run entirely against a fake `ConfigStore` — greenhouse/keka need no
// per-profile docs at all.

const LIVE_PROFILE_JSON = JSON.stringify({
  lanes: ['greenhouse', 'keka'],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: ['cleanup'],
  settings: { notion: { dbId: 'db-1' }, telegram: { chatId: 7 } },
});

function liveConfigStore(profileJson: string = LIVE_PROFILE_JSON) {
  return fakeConfigStore({ 'profile.json': profileJson });
}

test('wire: returns a live ctx with config/ports/storage/notify populated', async () => {
  const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });

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

// P9 closure register item 5: a notifier failure (e.g. Telegram's send()
// throwing on a missing token) must never propagate out of ctx.notify — a
// run.ts caller awaits notify() AFTER the pipeline has already produced a
// PASSED/FAILED RunResult, so a thrown/rejected notifier send must not turn
// an otherwise-passed run into a crash.
test('wire: ctx.notify never throws when a notifier fails, and still calls the others', async () => {
  const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });

  const errors: string[] = [];
  result.ctx.logger = {
    debug() {},
    info() {},
    warn() {},
    error: (msg: string) => errors.push(msg),
  };

  let okCalled = false;
  result.ctx.ports.notifiers = [
    {
      name: 'failing',
      async send() {
        throw new Error('boom');
      },
    },
    {
      name: 'ok',
      async send() {
        okCalled = true;
      },
    },
  ];

  await assert.doesNotReject(() =>
    result.ctx.notify({ kind: 'digest', profile: 'rajni', text: 'hi' }),
  );
  assert.equal(okCalled, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /failing/);
  assert.match(errors[0] ?? '', /boom/);
});

// Regression pin, 2026-07-25: `ctx.storage` was rooted at the REPO root
// alongside the shared `page_inventory/` handle, so every per-stage artifact
// (`cache/`, `registry/`, `structure/`) landed in the repo root and two
// profiles shared one cache and one company registry. The first real run
// therefore read a 0-entry `registry/companies.json` it had just created
// instead of the profile's own, silently sourcing nothing from the ATS lanes
// while still reporting `passed`. The two roots must stay distinct.
test('wire: ctx.storage is rooted at the profile data dir, not the repo root', async () => {
  const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });

  assert.equal(
    (result.ctx.storage as unknown as { rootDir: string }).rootDir,
    dataPath('rajni'),
  );
});

test('wire: stages is the 10 job-flow stages in spec order', async () => {
  const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });

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
  const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });

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
    () => wire('rajni', { root: '/repo', configStore: liveConfigStore(profileJson) }),
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
    () => wire('rajni', { root: '/repo', configStore: liveConfigStore(profileJson) }),
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
    () => wire('rajni', { root: '/repo', configStore: liveConfigStore(profileJson) }),
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
    () => wire('rajni', { root: '/repo', configStore: liveConfigStore(profileJson) }),
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
    () => wire('rajni', { root: '/repo', configStore: liveConfigStore(profileJson) }),
    /filter/,
  );
});

test('wire: missing NOTION_TOKEN still resolves wire(), but the live connector rejects on first use', async () => {
  const originalToken = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });

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
  const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });
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
      stateStore: result.ctx.stateStore,
    },
  );

  assert.equal(output?.jobs.length, 1);
  assert.equal(output?.dropped.length, 0);
});

test('wire: existing checks behavior is unchanged alongside the live ctx/stages/routines', async () => {
  const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });
  assert.ok(result.checks.length > 0);
  assert.ok(result.checks.some((c) => c.name.length > 0));
});

// --- sqlite connector (P8 local-DB spec) ---

test('wire: a sqlite profile builds SqliteConnector and contributes the sqlite doctor check', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: { sqlite: {} },
  });

  const result = await wire('rajni', {
    root: '/repo',
    configStore: liveConfigStore(profileJson),
  });

  assert.equal(result.ctx.ports.connector.name, 'sqlite');
  assert.ok(result.checks.some((c) => c.name === 'sqlite-db-openable'));
  assert.ok(!result.checks.some((c) => c.name === 'notion-db-reachable'));
});

// --- mirror connector (P8 local-DB spec, PR 3 Task 2) ---
//
// `builders.ts`'s `mirrorDbId`/`buildMirroredConnector` own the opt-in
// decision: `settings.notion.mirror: true` on a sqlite profile wraps the
// live connector in a `MirrorConnector` and adds the notion reachability
// check alongside the sqlite one. No adapter class is imported here
// (`only-wire-imports-adapters` has no test-file exemption) — identity is
// asserted purely via `.name` strings and doctor-check names.

function fakeQueryableNotionApi() {
  return { queryDatabase: async () => [] };
}

test('wire: a sqlite profile with settings.notion.mirror wraps the connector in a MirrorConnector and adds notion-db-reachable', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: { sqlite: {}, notion: { dbId: 'db-x', mirror: true } },
  });

  const result = await wire('rajni', {
    root: '/repo',
    configStore: liveConfigStore(profileJson),
    deps: { notionApi: fakeQueryableNotionApi() },
  });

  assert.equal(result.ctx.ports.connector.name, 'sqlite+notion');
  assert.ok(result.checks.some((c) => c.name === 'notion-db-reachable'));
  assert.ok(result.checks.some((c) => c.name === 'sqlite-db-openable'));
});

test('wire: settings.notion.mirror true but no dbId does not wrap and does not add notion-db-reachable', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: { sqlite: {}, notion: { mirror: true } },
  });

  const result = await wire('rajni', {
    root: '/repo',
    configStore: liveConfigStore(profileJson),
    deps: { notionApi: fakeQueryableNotionApi() },
  });

  assert.equal(result.ctx.ports.connector.name, 'sqlite');
  assert.ok(!result.checks.some((c) => c.name === 'notion-db-reachable'));
});

// I1: mirror applies IFF the slice also passes NotionConnectorSettingsSchema
// — a malformed slice (mirror: true, wrong field type) is 'no mirror', not
// a wire-time throw, and never trips the mirror-aware env-tokens message.
test('wire: a malformed settings.notion slice never mirrors, never throws, no notion-db-reachable check or mirror token messaging (I1)', async () => {
  const originalToken = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    const profileJson = JSON.stringify({
      lanes: [],
      connector: 'sqlite',
      notifiers: [],
      routines: [],
      settings: { sqlite: {}, notion: { dbId: 'x', mirror: true, dryRun: 'yes' } },
    });
    const result = await wire('rajni', {
      root: '/repo',
      configStore: liveConfigStore(profileJson),
      deps: { notionApi: fakeQueryableNotionApi() },
    });
    assert.equal(result.ctx.ports.connector.name, 'sqlite');
    assert.ok(!result.checks.some((c) => c.name === 'notion-db-reachable'));
    const envTokens = result.checks.find((c) => c.name === 'env-tokens');
    assert.ok(envTokens);
    const finding = await envTokens.run();
    assert.doesNotMatch(finding.detail, /mirror/);
  } finally {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
  }
});

test('wire: a sqlite profile with settings.notion.dbId but no mirror flag does not wrap', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: { sqlite: {}, notion: { dbId: 'db-x' } },
  });

  const result = await wire('rajni', {
    root: '/repo',
    configStore: liveConfigStore(profileJson),
    deps: { notionApi: fakeQueryableNotionApi() },
  });

  assert.equal(result.ctx.ports.connector.name, 'sqlite');
  assert.ok(!result.checks.some((c) => c.name === 'notion-db-reachable'));
});

test('wire: settings.notion.mirror on a notion profile is a no-op (gate is sqlite-only)', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-1', mirror: true } },
  });

  const result = await wire('rajni', {
    root: '/repo',
    configStore: liveConfigStore(profileJson),
    deps: { notionApi: fakeQueryableNotionApi() },
  });

  assert.equal(result.ctx.ports.connector.name, 'notion');
});

test('wire: a mirrored sqlite connector writes locally and best-effort pushes to a failing Notion mirror without throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-mirror-'));
  const originalToken = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  let result: Awaited<ReturnType<typeof wire>> | undefined;
  try {
    const profileJson = JSON.stringify({
      lanes: [],
      connector: 'sqlite',
      notifiers: [],
      routines: [],
      settings: { sqlite: {}, notion: { dbId: 'db-x', mirror: true } },
    });
    result = await wire('rajni', {
      root,
      configStore: fakeConfigStore({ 'profile.json': profileJson }),
    });

    assert.equal(result.ctx.ports.connector.name, 'sqlite+notion');

    const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    result.ctx.logger = {
      debug() {},
      info() {},
      warn: (msg, data) => warnings.push({ msg, data }),
      error() {},
    };

    const job: JD = {
      identity: {
        id: 'job-1',
        lane: 'greenhouse',
        url: 'https://example.com/job-1',
        company: 'Acme',
        title: 'Staff Engineer',
        scrapedAt: new Date().toISOString(),
      },
    };
    const runCtx: RunContext = {
      profile: 'rajni',
      signal: new AbortController().signal,
      logger: result.ctx.logger,
      beat() {},
    };

    await result.ctx.ports.connector.syncJobs([job], runCtx); // rejects -> fails the test
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]?.msg ?? '', /mirror/);
    assert.match(String(warnings[0]?.data?.error ?? ''), /NOTION_TOKEN/);
  } finally {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
    result?.ctx.ports.connector.close?.(); // Windows can't unlink an open db.
    await rm(root, { recursive: true, force: true });
  }
});

// --- mirrorReachableCheck (I2): red downgraded to warn, ok/warn untouched.
// Stub-api shape mirrors `adapters/db/notion/check.test.ts`, via `builders.ts`.
function fakeMirrorApi(result: unknown[] | Error) {
  return {
    async queryDatabase() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('mirrorReachableCheck: downgrades red to warn (suffixed), passes ok/warn through unchanged', async () => {
  const authErr = Object.assign(new Error('HTTP 401'), { status: 401 });
  const red = mirrorReachableCheck({ api: fakeMirrorApi(authErr), dbId: 'db-x' });
  const redFinding = await red.run();
  assert.equal(red.name, 'notion-db-reachable');
  assert.equal(redFinding.status, 'warn');
  assert.match(redFinding.detail, /mirror only; local runs are unaffected/);

  const ok = mirrorReachableCheck({ api: fakeMirrorApi([]), dbId: 'db-x' });
  assert.equal((await ok.run()).status, 'ok');
  const warn = mirrorReachableCheck({
    api: fakeMirrorApi(new Error('ECONNRESET')),
    dbId: 'db-x',
  });
  const warnFinding = await warn.run();
  assert.equal(warnFinding.status, 'warn');
  assert.doesNotMatch(warnFinding.detail, /mirror only/);
});

// --- linkedin lane: happy path ---
// Unlike greenhouse/keka, the linkedin lane's live construction reads a
// per-page `Inventory` via `loadInventory(storage, page)`, and `storage` is
// always a real `FsStorage(root)` inside `wire()` — there is no injectable
// Storage seam for the live composition path (only `readFile`/`root`, used
// above for profile.json/filter.json/search_urls.md). So this test
// uses a real temp directory as `root` and writes a real
// `src/adapters/lanes/linkedin/page_inventory/<page>.json` file for
// `FsStorage` to read, while still
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
    const inventoryDir = join(
      root,
      'src',
      'adapters',
      'lanes',
      'linkedin',
      'page_inventory',
    );
    await mkdir(inventoryDir, { recursive: true });
    await writeFile(
      join(inventoryDir, 'staff-eng.json'),
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
    const configStore = fakeConfigStore({
      'profile.json': profileJson,
      'filter.json': JSON.stringify({}),
      'search_urls.md': searchUrlsMd,
    });

    const result = await wire('rajni', { root, configStore });

    const farmingLanes = result.ctx.ports.lanes.filter((l) => l.kind === 'farming');
    assert.equal(farmingLanes.length, 1);
    assert.equal(farmingLanes[0]?.name, 'linkedin');

    const farmStage = result.stages.find((s) => s.name === 'farm');
    assert.ok(farmStage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wire: the linkedin lane is constructed with each resolved pacing value in its own slot (no transposed positional argument)', async () => {
  // `new LinkedInLane(...)` takes 13 positional arguments, four of them
  // adjacent plain `number`s — so swapping a min with a max, or the jitter
  // pair with the inter-url pair, typechecks and passes every behavioral
  // test in the suite while quietly changing the live cadence the whole
  // throttle guard rests on. This pins the composition itself, through the
  // real `wire()` path, using four deliberately distinct configured values
  // (a transposition of any pair changes at least one assertion below).
  // Read via a structural cast on the four private fields (same precedent
  // as `ctx.storage as unknown as { rootDir }` above) — no adapter type is
  // imported here (`only-wire-imports-adapters`).
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-linkedin-pacing-'));
  try {
    const inventoryDir = join(
      root,
      'src',
      'adapters',
      'lanes',
      'linkedin',
      'page_inventory',
    );
    await mkdir(inventoryDir, { recursive: true });
    await writeFile(
      join(inventoryDir, 'staff-eng.json'),
      validInventoryJson('staff-eng'),
      'utf8',
    );

    const profileJson = JSON.stringify({
      lanes: ['linkedin'],
      connector: 'notion',
      notifiers: [],
      routines: [],
      settings: {
        notion: { dbId: 'db-1' },
        linkedin: {
          jitterMinMs: 1_001,
          jitterMaxMs: 2_002,
          interUrlDelayMinMs: 3_003,
          interUrlDelayMaxMs: 4_004,
        },
      },
    });
    const searchUrlsMd = [
      '### staff-eng',
      '  • US remote - https://www.linkedin.com/jobs/search/?keywords=staff+engineer',
    ].join('\n');
    const configStore = fakeConfigStore({
      'profile.json': profileJson,
      'filter.json': JSON.stringify({}),
      'search_urls.md': searchUrlsMd,
    });

    const result = await wire('rajni', { root, configStore });

    const lane = result.ctx.ports.lanes.find((l) => l.name === 'linkedin');
    assert.ok(lane);
    const pacing = lane as unknown as {
      jitterMinMs: number;
      jitterMaxMs: number;
      interUrlDelayMinMs: number;
      interUrlDelayMaxMs: number;
    };
    assert.deepEqual(
      {
        jitterMinMs: pacing.jitterMinMs,
        jitterMaxMs: pacing.jitterMaxMs,
        interUrlDelayMinMs: pacing.interUrlDelayMinMs,
        interUrlDelayMaxMs: pacing.interUrlDelayMaxMs,
      },
      {
        jitterMinMs: 1_001,
        jitterMaxMs: 2_002,
        interUrlDelayMinMs: 3_003,
        interUrlDelayMaxMs: 4_004,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- wire logger (N4) ---

test('wire: ctx.logger is a wire logger emitting NDJSON to stderr before it is swapped', async () => {
  const result = await wire('rajni', { root: '/repo', configStore: liveConfigStore() });

  const originalConsoleError = console.error;
  const lines: string[] = [];
  console.error = (line: string) => lines.push(line);
  try {
    result.ctx.logger.error('x', { a: 1 });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? '{}');
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.msg, 'x');
  assert.deepEqual(parsed.data, { a: 1 });
  assert.equal(typeof parsed.ts, 'string');
});

test('wire: a profile with invalid settings.logging throws', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-1' }, logging: { ttyLevel: 'loud' } },
  });

  await assert.rejects(() =>
    wire('rajni', { root: '/repo', configStore: liveConfigStore(profileJson) }),
  );
});

// --- wireMigrate() (local-DB spec, PR 2 Task 4) ---
//
// Narrow composition seam for `jobbunny migrate` (Task 5): no store call, no
// filesystem touch here — `importRecords` opens the sqlite DB lazily on
// first call, which Task 3's store tests already cover.

test('wireMigrate: resolves dbId/profileJsonPath/dbPath from a profile with settings.notion.dbId', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-x' } },
  });

  const migrateWire = await wireMigrate('p1', {
    root: '/repo',
    configStore: fakeConfigStore({ 'profile.json': profileJson }),
  });

  assert.equal(migrateWire.dbId, 'db-x');
  assert.ok(migrateWire.profileJsonPath.endsWith(join('profiles', 'p1', 'profile.json')));
  assert.ok(migrateWire.dbPath.endsWith(join('profiles', 'p1', 'data', 'jobbunny.db')));
});

test('wireMigrate: dbId is "" when the profile has no settings.notion slice', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: {},
  });

  const migrateWire = await wireMigrate('p1', {
    root: '/repo',
    configStore: fakeConfigStore({ 'profile.json': profileJson }),
  });

  assert.equal(migrateWire.dbId, '');
});

test('wireMigrate: dbId is "" when settings.notion exists but has no dbId (e.g. { dryRun: true })', async () => {
  const profileJson = JSON.stringify({
    lanes: [],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dryRun: true } },
  });

  const migrateWire = await wireMigrate('p1', {
    root: '/repo',
    configStore: fakeConfigStore({ 'profile.json': profileJson }),
  });

  assert.equal(migrateWire.dbId, '');
});
