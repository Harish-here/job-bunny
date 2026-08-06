/**
 * migrate.test.ts (local-DB spec PR 2, Task 5) — TDD for `migrateCommand`.
 * The fake `MigrateWire` is a plain object literal — no `src/adapters/**`
 * import anywhere in this file (`only-wire-imports-adapters` has no
 * test-file exemption).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MigratedRecord } from '../../core/tracking/index.ts';
import type { ConfigStore } from '../../ports/config_store.ts';
import type { MigrateWire } from '../wire/index.ts';
import { migrateCommand } from './migrate.ts';

/** Config→db Phase 4: `MigrateWire.configStore` field — unused by this
 * command's own logic (Task 7's future job), so a plain no-op fake
 * satisfies the type here. */
const FAKE_CONFIG_STORE: ConfigStore = {
  readText: async () => undefined,
  writeText: async () => {},
  close() {},
};

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

async function withTmpProfileJson(
  fn: (profileJsonPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'jobbunny-migrate-'));
  const profileJsonPath = path.join(root, 'profile.json');
  await writeFile(
    profileJsonPath,
    `${JSON.stringify(PROFILE_JSON_FIXTURE, null, 2)}\n`,
    'utf8',
  );
  try {
    await fn(profileJsonPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeFakeWire(
  profileJsonPath: string,
  overrides: Partial<MigrateWire> = {},
): { wire: MigrateWire; importCalls: Array<[MigratedRecord[], string]> } {
  const importCalls: Array<[MigratedRecord[], string]> = [];
  const wire: MigrateWire = {
    dbId: 'db-123',
    profileJsonPath,
    dbPath: '/x/jobbunny.db',
    configStore: FAKE_CONFIG_STORE,
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
    configStore: FAKE_CONFIG_STORE,
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
  await withTmpProfileJson(async (profileJsonPath) => {
    const before = await readFile(profileJsonPath, 'utf8');
    const lines: string[] = [];
    const { wire, importCalls } = makeFakeWire(profileJsonPath);

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

    const after = await readFile(profileJsonPath, 'utf8');
    assert.equal(after, before, 'profile.json must be byte-identical after a dry-run');
  });
});

test('migrateCommand: --apply calls importRecords once with (FIXTURE_RECORDS, isoNow) and flips profile.json, preserving unrelated keys', async () => {
  await withTmpProfileJson(async (profileJsonPath) => {
    const lines: string[] = [];
    const { wire, importCalls } = makeFakeWire(profileJsonPath);

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

    const after = JSON.parse(await readFile(profileJsonPath, 'utf8'));
    assert.equal(after.connector, 'sqlite');
    assert.deepEqual(after.settings.sqlite, {});
    // Everything else — including the notion slice and legacy top-level
    // keys — survives the round-trip untouched.
    assert.deepEqual(after.settings.notion, { dbId: 'db-123', dryRun: true });
    assert.equal(after.notion_db_id, 'legacy-db-id');
    assert.deepEqual(after.schedule, { enabled: false, time: '09:00', times: [] });
    assert.deepEqual(after.notify, { telegram: { enabled: false, chat_id: '' } });
  });
});

test('migrateCommand: exportRecords rejecting makes migrateCommand reject', async () => {
  const wire: MigrateWire = {
    dbId: 'db-123',
    profileJsonPath: '/unused/profile.json',
    dbPath: '/unused/jobbunny.db',
    configStore: FAKE_CONFIG_STORE,
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
