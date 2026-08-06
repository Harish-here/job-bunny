/**
 * profile.test.ts (P8; config→db Phase 4, Task 7) — TDD for
 * `profileBuildCommand`/`seedProfileDocs` (seed-never-clobber, idempotent,
 * schema-validated, against a fake in-memory `ConfigStore`) and
 * `profileRemoveCommand` (dry-run unless --force, still against a temp
 * root — `remove` never touches a `ConfigStore`, it deletes the whole
 * profile directory).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import type { ConfigDocKey, ConfigStore } from '../../ports/config_store.ts';
import { wireConfigStore } from '../wire/index.ts';
import { profileBuildCommand, profileRemoveCommand, seedProfileDocs } from './profile.ts';

/** In-memory `ConfigStore` fake, same Map-backed shape used throughout
 * this program (`cli/commands/config.test.ts`, `setup.test.ts`).
 * `throwOnRead` simulates a legacy file present but malformed enough to
 * fail the real adapter's lift-time check. */
function fakeConfigStore(
  docs: Partial<Record<ConfigDocKey, string>> = {},
  opts: { throwOnRead?: ConfigDocKey } = {},
): ConfigStore & { writes: ConfigDocKey[] } {
  const map = new Map(Object.entries(docs));
  const writes: ConfigDocKey[] = [];
  return {
    writes,
    async readText(key) {
      if (opts.throwOnRead === key) {
        throw new Error(`Malformed legacy config file: ${key}`);
      }
      return map.get(key);
    },
    async writeText(key, text) {
      writes.push(key);
      map.set(key, text);
    },
    close() {},
  };
}

async function withTmpRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'jobbunny-profile-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------- profileBuildCommand / seedProfileDocs ----------

test('profileBuildCommand seeds the three scaffold docs as valid schema instances, never seeds avoid.md or resume.json', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore();
    const lines: string[] = [];
    const code = await profileBuildCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l), configStore: () => store },
    );
    assert.equal(code, 0);

    const pipelineRaw = await store.readText('profile.json');
    const filterRaw = await store.readText('filter.json');
    assert.doesNotThrow(() => PipelineConfigSchema.parse(JSON.parse(pipelineRaw ?? '')));
    assert.doesNotThrow(() => FilterConfigSchema.parse(JSON.parse(filterRaw ?? '')));
    assert.ok((await store.readText('search_urls.md'))?.includes('Search URLs'));

    assert.equal(lines.filter((l) => l.includes(': created')).length, 3);
    assert.ok(!store.writes.includes('resume.json' as ConfigDocKey));
  });
});

test('profile build scaffolds connector sqlite (local-first default, spec §8)', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore();
    const code = await profileBuildCommand(
      { profile: 'acme' },
      { root, write: () => {}, configStore: () => store },
    );
    assert.equal(code, 0);

    const parsed = JSON.parse((await store.readText('profile.json')) ?? '{}');
    assert.equal(parsed.connector, 'sqlite');
    assert.deepEqual(parsed.settings, {});
  });
});

test('profileBuildCommand leaves an existing doc byte-for-byte untouched and reports it as kept', async () => {
  await withTmpRoot(async (root) => {
    const customProfileJson = JSON.stringify(
      { lanes: ['linkedin'], connector: 'notion' },
      null,
      2,
    );
    const store = fakeConfigStore({ 'profile.json': customProfileJson });

    const lines: string[] = [];
    await profileBuildCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l), configStore: () => store },
    );

    assert.equal(await store.readText('profile.json'), customProfileJson);
    assert.ok(lines.some((l) => l.includes('profile.json') && l.includes(': kept')));
    assert.ok(!store.writes.includes('profile.json'));
  });
});

test('profileBuildCommand is idempotent: a second run creates nothing', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore();
    await profileBuildCommand(
      { profile: 'acme' },
      { root, write: () => {}, configStore: () => store },
    );
    store.writes.length = 0;

    const lines: string[] = [];
    await profileBuildCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l), configStore: () => store },
    );
    assert.equal(lines.filter((l) => l.includes(': created')).length, 0);
    assert.equal(lines.filter((l) => l.includes(': kept')).length, 3);
    assert.equal(store.writes.length, 0);
  });
});

test("seedProfileDocs never seeds resume.json (advisor ruling: hand-maintained, would silence setup's needs-action signal)", async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore();
    const results = await seedProfileDocs('acme', {
      root,
      configStore: () => store,
      mkdir: async () => {},
      write: () => {},
    });
    assert.ok(!results.some((r) => r.doc === ('resume.json' as ConfigDocKey)));
    assert.ok(!store.writes.includes('resume.json' as ConfigDocKey));
  });
});

test('seedProfileDocs: a doc present as a row/lift on the FIRST readText call is reported "kept" and never written', async () => {
  await withTmpRoot(async (root) => {
    // Simulates either a real config_docs row or a legacy-file lift —
    // readText resolving to a defined value on the first call is the
    // whole "does this doc already exist, in either form" signal.
    const store = fakeConfigStore({ 'filter.json': '{"locations":["remote"]}' });
    const results = await seedProfileDocs('acme', {
      root,
      configStore: () => store,
      mkdir: async () => {},
      write: () => {},
    });
    const filterResult = results.find((r) => r.doc === 'filter.json');
    assert.equal(filterResult?.status, 'kept');
    assert.ok(!store.writes.includes('filter.json'));
    assert.equal(await store.readText('filter.json'), '{"locations":["remote"]}');
  });
});

test('seedProfileDocs treats a malformed-legacy-file throw from readText as "present" (kept), not a crash', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore({}, { throwOnRead: 'profile.json' });
    const results = await seedProfileDocs('acme', {
      root,
      configStore: () => store,
      mkdir: async () => {},
      write: () => {},
    });
    const profileResult = results.find((r) => r.doc === 'profile.json');
    assert.equal(profileResult?.status, 'kept');
    assert.ok(!store.writes.includes('profile.json'));
  });
});

test('seedProfileDocs: a readText throw NOT shaped like the malformed-legacy-file error (e.g. a db-open failure) propagates loud, never reported "kept"', async () => {
  await withTmpRoot(async (root) => {
    const store: ConfigStore = {
      readText: async () => {
        throw new Error('file is not a database');
      },
      writeText: async () => {},
      close() {},
    };
    await assert.rejects(
      () =>
        seedProfileDocs('acme', {
          root,
          configStore: () => store,
          mkdir: async () => {},
          write: () => {},
        }),
      /file is not a database/,
    );
  });
});

test('profileBuildCommand: a REAL garbage (non-sqlite) jobbunny.db is a loud non-zero failure, never a false "kept" all-clear', async () => {
  await withTmpRoot(async (root) => {
    const name = 'broken';
    const dataDir = path.join(root, 'profiles', name, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'jobbunny.db'), 'not a real sqlite file at all');

    const lines: string[] = [];
    await assert.rejects(
      () =>
        profileBuildCommand(
          { profile: name },
          {
            root,
            configStore: (profileName) => wireConfigStore(profileName, { root }),
            write: (line) => lines.push(line),
          },
        ),
      /file is not a database/,
    );
    // The old bug: every doc printed "kept" and the command returned 0
    // despite nothing having been read or written. Confirm no such
    // misleading "kept" lines were ever printed before the throw.
    assert.ok(!lines.some((l) => l.includes(': kept')));
  });
});

// ---------- profileRemoveCommand ----------

test('profileRemoveCommand without --force prints a summary and returns non-zero without touching anything', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'acme');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'profile.json'), '{}');

    const lines: string[] = [];
    const code = await profileRemoveCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l) },
    );
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes('would remove')));

    const stillThere = await readFile(path.join(profileDir, 'profile.json'), 'utf8');
    assert.equal(stillThere, '{}');
  });
});

test('profileRemoveCommand with --force deletes the profile directory', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'acme');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'profile.json'), '{}');

    const code = await profileRemoveCommand(
      { profile: 'acme', force: true },
      { root, write: () => {} },
    );
    assert.equal(code, 0);

    let exists = true;
    try {
      await readFile(path.join(profileDir, 'profile.json'), 'utf8');
    } catch {
      exists = false;
    }
    assert.equal(exists, false);
  });
});

test('profileRemoveCommand returns non-zero when the profile does not exist', async () => {
  await withTmpRoot(async (root) => {
    const code = await profileRemoveCommand(
      { profile: 'ghost', force: true },
      { root, write: () => {} },
    );
    assert.equal(code, 1);
  });
});

test('profileRemoveCommand refuses to remove the "rajni" fixture profile even with --force', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'rajni');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'profile.json'), '{}');

    const code = await profileRemoveCommand(
      { profile: 'rajni', force: true },
      { root, write: () => {} },
    );
    assert.equal(code, 1);
    const stillThere = await readFile(path.join(profileDir, 'profile.json'), 'utf8');
    assert.equal(stillThere, '{}');
  });
});
