/**
 * migrate.test.ts (local-DB spec PR 2, Task 5; config→db Phase 4,
 * Task 7) — TDD for `migrateCommand`. The fake `MigrateWire` is a plain
 * object literal, and `MigrateWire.configStore` is a fake, in-memory
 * `ConfigStore` (same Map-backed shape used throughout this program) —
 * no `src/adapters/**` import anywhere in this file
 * (`only-wire-imports-adapters` has no test-file exemption).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MigratedRecord } from '../../core/tracking/index.ts';
import type { ConfigDocKey, ConfigStore } from '../../ports/config_store.ts';
import type { MigrateWire } from '../wire/index.ts';
import { migrateCommand } from './migrate.ts';

function fakeConfigStore(docs: Partial<Record<ConfigDocKey, string>> = {}): ConfigStore {
  const map = new Map(Object.entries(docs));
  return {
    readText: async (key) => map.get(key),
    writeText: async (key, text) => {
      map.set(key, text);
    },
    close() {},
  };
}

const FIXTURE_RECORDS: MigratedRecord[] = [
  {
    jd: {
      identity: {
        id: 'li-1',
        lane: 'linkedin',
        url: 'https://www.linkedin.com/jobs/view/1',
        company: 'Acme Corp',
        title: 'Staff Frontend Engineer',
        scrapedAt: '2026-07-01T00:00:00.000Z',
      },
    },
    tracking: { status: 'Applied' },
  },
  {
    jd: {
      identity: {
        id: 'li-2',
        lane: 'linkedin',
        url: 'https://www.linkedin.com/jobs/view/2',
        company: 'Widget Inc',
        title: 'Backend Engineer',
        scrapedAt: '2026-07-02T00:00:00.000Z',
      },
    },
  },
  {
    jd: {
      identity: {
        id: 'nt-abcd1234',
        lane: 'notion-import',
        url: 'https://www.notion.so/abcd1234',
        company: 'Mystery Co',
        title: 'Mystery Role',
        scrapedAt: '2026-07-03T00:00:00.000Z',
      },
    },
  },
];

const PROFILE_JSON_FIXTURE = {
  notion_db_id: 'legacy-db-id',
  schedule: { enabled: false, time: '09:00', times: [] },
  notify: { telegram: { enabled: false, chat_id: '' } },
  lanes: ['linkedin'],
  connector: 'notion',
  notifiers: [],
  routines: [],
  settings: {
    notion: { dbId: 'db-123', dryRun: true },
  },
};

function makeFakeWire(
  configStore: ConfigStore,
  overrides: Partial<MigrateWire> = {},
): { wire: MigrateWire; importCalls: Array<[MigratedRecord[], string]> } {
  const importCalls: Array<[MigratedRecord[], string]> = [];
  const wire: MigrateWire = {
    dbId: 'db-123',
    profileJsonPath: '/unused/profile.json',
    dbPath: '/x/jobbunny.db',
    configStore,
    exportRecords: async () => FIXTURE_RECORDS,
    importRecords: (recs, now) => {
      importCalls.push([recs, now]);
      return { jobs: 2, tracking: 1 };
    },
    ...overrides,
  };
  return { wire, importCalls };
}

test('migrateCommand: dbId "" returns 1, prints the no-dbId message, never calls exportRecords', async () => {
  const lines: string[] = [];
  let exportCalled = false;
  const wire: MigrateWire = {
    dbId: '',
    profileJsonPath: '/unused/profile.json',
    dbPath: '/unused/jobbunny.db',
    configStore: fakeConfigStore(),
    exportRecords: async () => {
      exportCalled = true;
      return [];
    },
    importRecords: () => {
      throw new Error('must not be called');
    },
  };

  const code = await migrateCommand(
    { profile: 'acme', apply: false },
    { wireMigrate: async () => wire, write: (l) => lines.push(l) },
  );

  assert.equal(code, 1);
  assert.equal(exportCalled, false);
  assert.deepEqual(lines, [
    'no settings.notion.dbId configured for this profile — nothing to migrate',
  ]);
});

test('migrateCommand: dry-run prints summary + nt- line, never calls importRecords, leaves profile.json byte-unchanged', async () => {
  const store = fakeConfigStore({
    'profile.json': `${JSON.stringify(PROFILE_JSON_FIXTURE, null, 2)}\n`,
  });
  const before = await store.readText('profile.json');
  const lines: string[] = [];
  const { wire, importCalls } = makeFakeWire(store);

  const code = await migrateCommand(
    { profile: 'acme', apply: false },
    { wireMigrate: async () => wire, write: (l) => lines.push(l) },
  );

  assert.equal(code, 0);
  assert.equal(importCalls.length, 0);

  assert.ok(lines.includes('total: 3, withTracking: 1, fallback: 1'));
  assert.ok(lines.includes('nt-abcd1234 Mystery Role — Mystery Co'));
  assert.ok(lines.includes('db: /x/jobbunny.db'));
  assert.ok(
    lines.includes(
      'dry-run — nothing written (no DB file created). Re-run with --apply to import and flip the connector.',
    ),
  );

  const after = await store.readText('profile.json');
  assert.equal(after, before, 'profile.json must be byte-identical after a dry-run');
});

test('migrateCommand: --apply calls importRecords once with (FIXTURE_RECORDS, isoNow) and flips profile.json via the store, preserving unrelated keys', async () => {
  const store = fakeConfigStore({
    'profile.json': `${JSON.stringify(PROFILE_JSON_FIXTURE, null, 2)}\n`,
  });
  const lines: string[] = [];
  const { wire, importCalls } = makeFakeWire(store);

  const code = await migrateCommand(
    { profile: 'acme', apply: true },
    { wireMigrate: async () => wire, write: (l) => lines.push(l) },
  );

  assert.equal(code, 0);
  assert.equal(importCalls.length, 1);
  const [recs, now] = importCalls[0] as [MigratedRecord[], string];
  assert.deepEqual(recs, FIXTURE_RECORDS);
  assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  assert.ok(
    lines.includes(
      'imported 2 jobs (1 already present, left untouched), 1 tracking rows; connector flipped to sqlite',
    ),
  );

  const afterRaw = await store.readText('profile.json');
  const after = JSON.parse(afterRaw ?? '{}');
  assert.equal(after.connector, 'sqlite');
  assert.deepEqual(after.settings.sqlite, {});
  // Everything else — including the notion slice and legacy top-level
  // keys — survives the round-trip untouched.
  assert.deepEqual(after.settings.notion, { dbId: 'db-123', dryRun: true });
  assert.equal(after.notion_db_id, 'legacy-db-id');
  assert.deepEqual(after.schedule, { enabled: false, time: '09:00', times: [] });
  assert.deepEqual(after.notify, { telegram: { enabled: false, chat_id: '' } });
});

test('migrateCommand: exportRecords rejecting makes migrateCommand reject', async () => {
  const wire: MigrateWire = {
    dbId: 'db-123',
    profileJsonPath: '/unused/profile.json',
    dbPath: '/unused/jobbunny.db',
    configStore: fakeConfigStore(),
    exportRecords: async () => {
      throw new Error('notion query failed');
    },
    importRecords: () => {
      throw new Error('must not be called');
    },
  };

  await assert.rejects(
    () =>
      migrateCommand(
        { profile: 'acme', apply: false },
        { wireMigrate: async () => wire },
      ),
    /notion query failed/,
  );
});

test('migrateCommand: --apply with profile.json unexpectedly missing from the store throws loud', async () => {
  const store = fakeConfigStore(); // no profile.json row at all
  const { wire } = makeFakeWire(store);

  await assert.rejects(
    () =>
      migrateCommand(
        { profile: 'acme', apply: true },
        { wireMigrate: async () => wire, write: () => {} },
      ),
    /profile\.json unexpectedly missing/,
  );
});
