/**
 * config.test.ts (config→db Phase 4, Task 6) — TDD for `configCommand`.
 * Every dependency (`configStore`, `readStdin`, `writeRaw`, `write`,
 * `stderr`, `exists`, `readFile`, `writeFile`, `mkdir`) is FAKE; the fake
 * `configStore` wraps an in-memory `ConfigStore`, NOT a real DB.
 *
 * The plan's mandated REAL round-trip test (a real `SqliteConfigStore`)
 * lives in `test/integration/config_command_roundtrip.test.ts` instead of
 * here — same reason `state.ts`'s equivalent lives outside `src/`: only
 * `cli/wire/compose.ts` (and its named siblings) may import
 * `src/adapters/**` (`only-wire-imports-adapters`), and dependency-cruiser's
 * `includeOnly: '^src'` never cruises `test/`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigDocKey, ConfigStore } from '../../ports/config_store.ts';
import { type ConfigDeps, configCommand } from './config.ts';

/** In-memory `ConfigStore` fake. `throwOn` lets one test make `writeText`
 * reject for a specific key only, to exercise `set`'s rejection path and
 * `import`'s partial-failure path without touching a real validator. */
function fakeConfigStore(
  docs: Partial<Record<ConfigDocKey, string>> = {},
  opts: { throwOn?: ConfigDocKey; throwMessage?: string } = {},
): ConfigStore & { closed: boolean } {
  const map = new Map(Object.entries(docs));
  const store = {
    closed: false,
    async readText(key: ConfigDocKey) {
      return map.get(key);
    },
    async writeText(key: ConfigDocKey, text: string) {
      if (opts.throwOn === key) {
        throw new Error(opts.throwMessage ?? `invalid ${key}`);
      }
      map.set(key, text);
    },
    close() {
      store.closed = true;
    },
  };
  return store;
}

function baseDeps(overrides: Partial<ConfigDeps> = {}): Partial<ConfigDeps> {
  return {
    write: () => {},
    stderr: () => {},
    ...overrides,
  };
}

// ---------- get ----------

test('config get: doc present writes the exact stored text via writeRaw, exit 0', async () => {
  const store = fakeConfigStore({ 'filter.json': '{"locations":["remote"]}' });
  const written: string[] = [];

  const code = await configCommand(
    { profile: 'rajni', action: 'get', doc: 'filter.json' },
    baseDeps({
      configStore: () => store,
      writeRaw: (text) => written.push(text),
    }),
  );

  assert.equal(code, 0);
  assert.deepEqual(written, ['{"locations":["remote"]}']);
  assert.equal(store.closed, true);
});

test('config get: doc absent errors on stderr, writeRaw never called, exit 1', async () => {
  const store = fakeConfigStore();
  const written: string[] = [];
  const errors: string[] = [];

  const code = await configCommand(
    { profile: 'rajni', action: 'get', doc: 'profile.json' },
    baseDeps({
      configStore: () => store,
      writeRaw: (text) => written.push(text),
      stderr: (line) => errors.push(line),
    }),
  );

  assert.equal(code, 1);
  assert.deepEqual(written, []);
  assert.ok(errors.some((l) => l.includes('profile.json')));
});

// ---------- set ----------

test('config set: TTY stdin errors on stderr mentioning stdin, readStdin never called, exit 1', async () => {
  const store = fakeConfigStore();
  const errors: string[] = [];
  let readStdinCalled = false;

  const code = await configCommand(
    { profile: 'rajni', action: 'set', doc: 'filter.json' },
    baseDeps({
      configStore: () => store,
      isStdinTty: () => true,
      readStdin: async () => {
        readStdinCalled = true;
        return 'unreachable';
      },
      stderr: (line) => errors.push(line),
    }),
  );

  assert.equal(code, 1);
  assert.equal(readStdinCalled, false);
  assert.ok(errors.some((l) => l.includes('stdin')));
});

test('config set: valid doc writes piped content via writeText, exit 0', async () => {
  const store = fakeConfigStore();

  const code = await configCommand(
    { profile: 'rajni', action: 'set', doc: 'filter.json' },
    baseDeps({
      configStore: () => store,
      isStdinTty: () => false,
      readStdin: async () => '{"locations":["hybrid"]}',
    }),
  );

  assert.equal(code, 0);
  assert.equal(await store.readText('filter.json'), '{"locations":["hybrid"]}');
  assert.equal(store.closed, true);
});

test('config set: invalid doc (writeText throws) reports the thrown message on stderr, exit 1', async () => {
  const store = fakeConfigStore(
    {},
    { throwOn: 'filter.json', throwMessage: 'bad shape' },
  );
  const errors: string[] = [];

  const code = await configCommand(
    { profile: 'rajni', action: 'set', doc: 'filter.json' },
    baseDeps({
      configStore: () => store,
      isStdinTty: () => false,
      readStdin: async () => 'garbage',
      stderr: (line) => errors.push(line),
    }),
  );

  assert.equal(code, 1);
  assert.ok(errors.some((l) => l.includes('bad shape')));
});

// ---------- export ----------

test('config export: default dir is profiles/<profile>/export, mkdir called before any writeFile', async () => {
  const store = fakeConfigStore({ 'profile.json': '{}' });
  const mkdirCalls: string[] = [];
  const writeFileCalls: Array<{ path: string; data: string }> = [];
  let mkdirHappenedBeforeWrite = false;

  const code = await configCommand(
    { profile: 'acme', action: 'export' },
    baseDeps({
      configStore: () => store,
      root: '/repo',
      mkdir: async (p) => {
        mkdirCalls.push(p);
      },
      writeFile: async (p, data) => {
        mkdirHappenedBeforeWrite = mkdirCalls.length > 0;
        writeFileCalls.push({ path: p, data });
      },
    }),
  );

  assert.equal(code, 0);
  assert.deepEqual(mkdirCalls, ['/repo/profiles/acme/export']);
  assert.ok(mkdirHappenedBeforeWrite);
  assert.deepEqual(writeFileCalls, [
    { path: '/repo/profiles/acme/export/profile.json', data: '{}' },
  ]);
});

test('config export: explicit --dir is respected over the default', async () => {
  const store = fakeConfigStore({ 'resume.json': '{"name":"x"}' });
  const writeFileCalls: Array<{ path: string }> = [];

  const code = await configCommand(
    { profile: 'acme', action: 'export', dir: '/custom/dir' },
    baseDeps({
      configStore: () => store,
      root: '/repo',
      mkdir: async () => {},
      writeFile: async (p) => {
        writeFileCalls.push({ path: p });
      },
    }),
  );

  assert.equal(code, 0);
  assert.deepEqual(writeFileCalls, [{ path: '/custom/dir/resume.json' }]);
});

test('config export: a doc undefined in the store produces a "skipped (not present)" line, exit still 0', async () => {
  const store = fakeConfigStore({});
  const lines: string[] = [];

  const code = await configCommand(
    { profile: 'acme', action: 'export' },
    baseDeps({
      configStore: () => store,
      root: '/repo',
      mkdir: async () => {},
      writeFile: async () => {},
      write: (l) => lines.push(l),
    }),
  );

  assert.equal(code, 0);
  assert.ok(
    lines.some((l) => l.includes('profile.json') && l.includes('skipped (not present)')),
  );
  assert.ok(
    lines.some((l) => l.includes('filter.json') && l.includes('skipped (not present)')),
  );
  assert.ok(
    lines.some((l) => l.includes('resume.json') && l.includes('skipped (not present)')),
  );
  assert.ok(
    lines.some(
      (l) => l.includes('search_urls.md') && l.includes('skipped (not present)'),
    ),
  );
});

// ---------- import ----------

test('config import: a file present in exists/readFile is imported via writeText', async () => {
  const store = fakeConfigStore();
  const lines: string[] = [];

  const code = await configCommand(
    { profile: 'acme', action: 'import', dir: '/from' },
    baseDeps({
      configStore: () => store,
      exists: async (p) => p === '/from/profile.json',
      readFile: async () => '{"connector":"sqlite"}',
      write: (l) => lines.push(l),
    }),
  );

  assert.equal(code, 0);
  assert.equal(await store.readText('profile.json'), '{"connector":"sqlite"}');
  assert.ok(lines.some((l) => l.includes('profile.json') && l.includes('imported')));
});

test('config import: an absent file is skipped, writeText not called for that key', async () => {
  const store = fakeConfigStore();
  const lines: string[] = [];
  let writeTextCalled = false;
  const wrapped: ConfigStore = {
    ...store,
    writeText: async (key, text) => {
      writeTextCalled = true;
      await store.writeText(key, text);
    },
  };

  const code = await configCommand(
    { profile: 'acme', action: 'import', dir: '/from' },
    baseDeps({
      configStore: () => wrapped,
      exists: async () => false,
      readFile: async () => 'unreachable',
      write: (l) => lines.push(l),
    }),
  );

  assert.equal(code, 0);
  assert.equal(writeTextCalled, false);
  assert.ok(
    lines.some(
      (l) => l.includes('profile.json') && l.includes('skipped (file not found)'),
    ),
  );
});

test('config import: a present-but-invalid file rejects for that key but the other three keys still get processed (partial import)', async () => {
  const store = fakeConfigStore(
    {},
    { throwOn: 'filter.json', throwMessage: 'schema violation' },
  );
  const lines: string[] = [];

  const code = await configCommand(
    { profile: 'acme', action: 'import', dir: '/from' },
    baseDeps({
      configStore: () => store,
      exists: async () => true,
      readFile: async (p) => `content of ${p}`,
      write: (l) => lines.push(l),
    }),
  );

  assert.equal(code, 1);
  assert.ok(
    lines.some(
      (l) =>
        l.includes('filter.json') &&
        l.includes('rejected') &&
        l.includes('schema violation'),
    ),
  );
  assert.ok(lines.some((l) => l.includes('profile.json') && l.includes('imported')));
  assert.ok(lines.some((l) => l.includes('resume.json') && l.includes('imported')));
  assert.ok(lines.some((l) => l.includes('search_urls.md') && l.includes('imported')));
  // All four keys were attempted — proves the rejection did not abort the loop.
  assert.equal(lines.length, 4);
});
