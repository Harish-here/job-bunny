/**
 * test/integration/config_command_roundtrip.test.ts — lives OUTSIDE `src/`
 * (mirrors `test/integration/state_command_roundtrip.test.ts`'s own
 * placement) precisely so it can exercise the REAL cross-layer path:
 * `cli/commands/config.ts`'s `configCommand` driven against a REAL
 * `SqliteConfigStore` (`adapters/db/sqlite/config`) over a real on-disk
 * `jobbunny.db`. `dependency-cruiser`'s `includeOnly: '^src'` never cruises
 * this file, so it is free to import both `cli/commands` and `adapters` the
 * way no file under `src/` may (`only-wire-imports-adapters`).
 *
 * Pins the plan's own explicit requirements:
 * - `config set filter.json` then `config get filter.json` round-trips
 *   BYTE-FOR-BYTE (`assert.equal`, string identity) through a real store.
 * - `config export` then `config import` into a FRESH profile
 *   directory/db round-trips all four docs byte-exact.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SqliteConfigStore } from '../../src/adapters/db/sqlite/config/index.ts';
import { configCommand } from '../../src/cli/commands/config.ts';
import type { ConfigStore } from '../../src/ports/config_store.ts';

const rajniProfileJson = readFileSync(
  fileURLToPath(new URL('../../profiles/rajni/profile.json', import.meta.url)),
  'utf8',
);
const rajniFilterJson = readFileSync(
  fileURLToPath(new URL('../../profiles/rajni/filter.json', import.meta.url)),
  'utf8',
);

function freshProfileRoot(prefix: string): {
  root: string;
  dbPath: string;
  profileRoot: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    root,
    dbPath: path.join(root, 'jobbunny.db'),
    profileRoot: root,
  };
}

test('config set filter.json then config get filter.json round-trips byte-for-byte through a real SqliteConfigStore', async () => {
  // `configCommand` opens and closes its OWN short-lived store per call
  // (`ConfigDeps.configStore` is a FACTORY, never a shared/memoized
  // instance) — mirroring two separate `jobbunny config ...` process
  // invocations against the same on-disk db, each command call here gets
  // its own fresh `SqliteConfigStore` pointed at the same dbPath.
  const { dbPath, profileRoot, root } = freshProfileRoot('jb-config-cmd-roundtrip-');

  try {
    const setCode = await configCommand(
      { profile: 'ignored', action: 'set', doc: 'filter.json' },
      {
        configStore: () => new SqliteConfigStore(dbPath, profileRoot),
        isStdinTty: () => false,
        readStdin: async () => rajniFilterJson,
      },
    );
    assert.equal(setCode, 0);

    let readBack: string | undefined;
    const getCode = await configCommand(
      { profile: 'ignored', action: 'get', doc: 'filter.json' },
      {
        configStore: () => new SqliteConfigStore(dbPath, profileRoot),
        writeRaw: (text) => {
          readBack = text;
        },
      },
    );
    assert.equal(getCode, 0);
    assert.equal(readBack, rajniFilterJson);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('config export then config import into a FRESH profile directory/db round-trips all four docs byte-exact', async () => {
  const source = freshProfileRoot('jb-config-cmd-export-src-');
  const dest = freshProfileRoot('jb-config-cmd-export-dst-');
  const exportDir = path.join(source.root, 'export');

  const docs = {
    'profile.json': rajniProfileJson,
    'filter.json': rajniFilterJson,
    'resume.json': '{"name":"Test Person"}',
    'search_urls.md': '## linkedin\n### x\n  • eng - https://example.com/jobs\n',
  } as const;

  // Each store instance below is fresh and short-lived, mirroring
  // `configCommand`'s own "open one, close it in finally" per-call
  // discipline (`ConfigDeps.configStore` is a factory, never shared) —
  // exactly like two/three separate `jobbunny config ...` process
  // invocations against the same on-disk db files would be.
  const seedStore: ConfigStore = new SqliteConfigStore(source.dbPath, source.profileRoot);
  try {
    // Seed the source store with all four docs via writeText first.
    for (const [key, text] of Object.entries(docs)) {
      await seedStore.writeText(key as keyof typeof docs, text);
    }
  } finally {
    seedStore.close();
  }

  try {
    const exportCode = await configCommand(
      { profile: 'ignored', action: 'export', dir: exportDir },
      { configStore: () => new SqliteConfigStore(source.dbPath, source.profileRoot) },
    );
    assert.equal(exportCode, 0);

    const importCode = await configCommand(
      { profile: 'ignored', action: 'import', dir: exportDir },
      { configStore: () => new SqliteConfigStore(dest.dbPath, dest.profileRoot) },
    );
    assert.equal(importCode, 0);

    const verifyStore: ConfigStore = new SqliteConfigStore(dest.dbPath, dest.profileRoot);
    try {
      for (const [key, text] of Object.entries(docs)) {
        const value = await verifyStore.readText(key as keyof typeof docs);
        assert.equal(value, text, `${key} did not round-trip byte-exact`);
      }
    } finally {
      verifyStore.close();
    }
  } finally {
    rmSync(source.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(dest.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
