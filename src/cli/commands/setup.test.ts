/**
 * setup.test.ts (P8; config→db Phase 4, Tasks 5 & 7) — TDD for
 * `setupCommand`'s idempotent, resumable step list. Most tests still
 * exercise the real temp-dir + real `wireConfigStore` path end to end
 * (the default `configStore` lifts from these same disk-written legacy
 * files ONCE — the first `readText` call for a given doc — so a fixture
 * must seed a doc's real content BEFORE that first read, either by
 * writing the legacy file to disk before `setupCommand`/
 * `profileBuildCommand` ever runs, or, once a `config_docs` row already
 * exists from an earlier scaffold in the SAME test, by writing through a
 * `wireConfigStore` handle on the same root/profile instead of the disk
 * file — a later disk write is otherwise silently ignored once a row is
 * present, `stepScaffold` (Task 7) now being one more reader/writer of
 * that same row); a dedicated handful further down inject a fake,
 * in-memory `configStore` to prove `readConnectorNeeds`/`stepResume`/
 * `stepSearchUrls` genuinely reach the injected seam rather than falling
 * through to disk.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConfigDocKey, ConfigStore } from '../../ports/config_store.ts';
import { wireConfigStore } from '../wire/index.ts';
import { profileBuildCommand } from './profile.ts';
import { setupCommand } from './setup.ts';

async function withTmpRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'jobbunny-setup-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** In-memory `ConfigStore` fake, pre-seeded with `docs` — same Map-backed
 * shape as `cli/wire/testkit.ts`'s `fakeConfigStore` (colocated here
 * rather than imported: `cli/wire/testkit.ts` is that module's own
 * internal test fixture, not part of its `index.ts` public surface, and
 * the two-pair rule keeps internals from crossing module boundaries). */
function fakeConfigStore(docs: Partial<Record<ConfigDocKey, string>>): ConfigStore {
  const map = new Map(Object.entries(docs));
  return {
    readText: async (key) => map.get(key),
    writeText: async (key, text) => {
      map.set(key, text);
    },
    close() {},
  };
}

test('setupCommand on a completely empty root: seeds scaffold, everything else needs-action, exits 1', async () => {
  await withTmpRoot(async (root) => {
    const lines: string[] = [];
    const code = await setupCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l) },
    );
    assert.equal(code, 1);

    // scaffold got seeded even though nothing existed before
    assert.ok(lines.some((l) => l.includes('profile scaffold: done')));
    // scaffold defaults to a local sqlite profile — no Notion token needed
    assert.ok(lines.some((l) => l.includes('.env NOTION_TOKEN: skipped')));
    assert.ok(lines.some((l) => l.includes('resume.json: needs-action')));
    assert.ok(lines.some((l) => l.includes('search_urls.md: needs-action')));
    assert.ok(lines.some((l) => l.includes('page_inventory coverage: skipped')));
  });
});

test('setupCommand: fully satisfied profile reports all done/skipped and exits 0', async () => {
  await withTmpRoot(async (root) => {
    await profileBuildCommand({ profile: 'acme' }, { root, write: () => {} });
    const profileDir = path.join(root, 'profiles', 'acme');

    await writeFile(path.join(root, '.env'), 'NOTION_TOKEN=secret-value-123\n');
    await writeFile(path.join(profileDir, 'resume.json'), '{}');
    // profileBuildCommand's scaffold already created a config_docs row for
    // search_urls.md (the zero-URL template) — writing the real content to
    // disk now would be silently ignored (a row already exists), so write
    // it through the SAME store instead.
    const store = wireConfigStore('acme', { root });
    await store.writeText(
      'search_urls.md',
      '## linkedin\n### linkedin__jobs-search\n<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->\n  • eng - https://www.linkedin.com/jobs/search/?keywords=eng\n',
    );
    store.close();
    const inventoryDir = path.join(
      root,
      'src',
      'adapters',
      'lanes',
      'linkedin',
      'page_inventory',
    );
    await mkdir(inventoryDir, { recursive: true });
    await writeFile(path.join(inventoryDir, 'linkedin__jobs-search.json'), '{}\n');
    const uiDistDir = path.join(root, 'ui', 'dist');
    await mkdir(uiDistDir, { recursive: true });
    await writeFile(path.join(uiDistDir, 'index.html'), '<!doctype html>\n');

    const lines: string[] = [];
    const code = await setupCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l) },
    );
    assert.equal(code, 0);
    assert.ok(lines.every((l) => !l.includes('needs-action')));
  });
});

test('setupCommand never prints or leaks the NOTION_TOKEN value', async () => {
  await withTmpRoot(async (root) => {
    await profileBuildCommand({ profile: 'acme' }, { root, write: () => {} });
    // profileBuildCommand's scaffold already created a config_docs row for
    // profile.json (the sqlite default) — overwrite it via the SAME store
    // so the token path picks up the notion connector (a disk write here
    // would be silently ignored, a row already exists).
    const store = wireConfigStore('acme', { root });
    await store.writeText('profile.json', JSON.stringify({ connector: 'notion' }));
    store.close();
    await writeFile(path.join(root, '.env'), 'NOTION_TOKEN=super-secret-value\n');

    const lines: string[] = [];
    await setupCommand({ profile: 'acme' }, { root, write: (l) => lines.push(l) });
    assert.ok(lines.every((l) => !l.includes('super-secret-value')));
    assert.ok(lines.some((l) => l.includes('.env NOTION_TOKEN: done')));
  });
});

test('setupCommand: .env present but NOTION_TOKEN empty is needs-action', async () => {
  await withTmpRoot(async (root) => {
    await profileBuildCommand({ profile: 'acme' }, { root, write: () => {} });
    // same rationale as the test above — overwrite the already-scaffolded
    // profile.json row via the store, not the (now-inert) legacy file.
    const store = wireConfigStore('acme', { root });
    await store.writeText('profile.json', JSON.stringify({ connector: 'notion' }));
    store.close();
    await writeFile(path.join(root, '.env'), 'NOTION_TOKEN=\n');

    const lines: string[] = [];
    const code = await setupCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l) },
    );
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes('.env NOTION_TOKEN: needs-action')));
  });
});

test('setupCommand: search_urls.md present with a referenced page but missing inventory is needs-action', async () => {
  await withTmpRoot(async (root) => {
    await profileBuildCommand({ profile: 'acme' }, { root, write: () => {} });
    // profileBuildCommand's scaffold already created a config_docs row for
    // search_urls.md — overwrite it via the SAME store, not the (now-
    // inert) legacy file.
    const store = wireConfigStore('acme', { root });
    await store.writeText(
      'search_urls.md',
      '## linkedin\n### linkedin__jobs-search\n<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->\n  • eng - https://www.linkedin.com/jobs/search/?keywords=eng\n',
    );
    store.close();

    const lines: string[] = [];
    const code = await setupCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l) },
    );
    assert.equal(code, 1);
    assert.ok(
      lines.some(
        (l) =>
          l.includes('page_inventory coverage: needs-action') &&
          l.includes('linkedin__jobs-search'),
      ),
    );
  });
});

test('setupCommand is resumable: re-running after fixing one step only clears that step', async () => {
  await withTmpRoot(async (root) => {
    await profileBuildCommand({ profile: 'acme' }, { root, write: () => {} });
    const profileDir = path.join(root, 'profiles', 'acme');

    let lines: string[] = [];
    let code = await setupCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l) },
    );
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes('resume.json: needs-action')));

    await writeFile(path.join(profileDir, 'resume.json'), '{}');

    lines = [];
    code = await setupCommand({ profile: 'acme' }, { root, write: (l) => lines.push(l) });
    assert.equal(code, 1); // other steps still outstanding
    assert.ok(lines.some((l) => l.includes('resume.json: done')));
    assert.ok(!lines.some((l) => l.includes('resume.json: needs-action')));
  });
});

test('setupCommand never mutates outside profiles/<p>/: does not touch .env or page_inventory/', async () => {
  await withTmpRoot(async (root) => {
    await setupCommand({ profile: 'acme' }, { root, write: () => {} });
    let envExists = true;
    try {
      await readFile(path.join(root, '.env'), 'utf8');
    } catch {
      envExists = false;
    }
    assert.equal(envExists, false);

    let inventoryExists = true;
    try {
      await readFile(
        path.join(root, 'src', 'adapters', 'lanes', 'linkedin', 'page_inventory'),
        'utf8',
      );
    } catch {
      inventoryExists = false;
    }
    assert.equal(inventoryExists, false);
  });
});

// ---------- Notion-conditional token step ----------

test('sqlite-only profile: .env NOTION_TOKEN is skipped even with no .env', async () => {
  await withTmpRoot(async (root) => {
    // fresh root, no .env — setupCommand's own scaffold step seeds
    // profile.json with connector "sqlite" (the PR-4 default)
    const lines: string[] = [];
    const code = await setupCommand(
      { profile: 'zz' },
      { root, write: (l) => lines.push(l) },
    );
    const tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
    assert.match(tokenLine ?? '', /skipped — local sqlite profile/);
    // exit code may still be 1 (resume.json etc. need action) — token must not be the cause
    assert.equal(code, 1);
  });
});

test('connector "notion" still requires the token', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'zz');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({ connector: 'notion' }),
    );

    // no .env → needs-action
    const lines: string[] = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    const tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
    assert.match(tokenLine ?? '', /needs-action/);
  });
});

test('sqlite profile with settings.notion.mirror=true AND a dbId requires the token', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'zz');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({
        connector: 'sqlite',
        settings: { notion: { dbId: 'x', mirror: true } },
      }),
    );

    // no NOTION_TOKEN → needs-action
    let lines: string[] = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    let tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
    assert.match(tokenLine ?? '', /needs-action/);

    // with NOTION_TOKEN in .env → done
    await writeFile(path.join(root, '.env'), 'NOTION_TOKEN=abc\n');
    lines = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
    assert.match(tokenLine ?? '', /done/);
  });
});

test('mirror=true WITHOUT a dbId does not require the token (matches mirrorSettings())', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'zz');
    await mkdir(profileDir, { recursive: true });
    // compose.test.ts pins this slice as no-mirror — token step must be skipped
    await writeFile(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({ connector: 'sqlite', settings: { notion: { mirror: true } } }),
    );

    const lines: string[] = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    const tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
    assert.match(tokenLine ?? '', /skipped/);
  });
});

test('non-sqlite, non-notion connector never needs the token, even with mirror settings present', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'zz');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({
        connector: 'weird',
        settings: { notion: { dbId: 'x', mirror: true } },
      }),
    );

    const lines: string[] = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    const tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
    assert.match(tokenLine ?? '', /skipped/);
  });
});

test('unparseable profile.json makes the token step needs-action, not a crash', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'zz');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'profile.json'), '{nope');

    const lines: string[] = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    const tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
    assert.match(tokenLine ?? '', /needs-action — profile\.json is not valid JSON/);
  });
});

// ---------- ui build step ----------

test('ui build: needs-action without ui/dist, done with it', async () => {
  await withTmpRoot(async (root) => {
    let lines: string[] = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    assert.ok(
      lines.some((l) =>
        l.includes(
          '[setup] ui build: needs-action — board UI not built — run: npm run ui:build',
        ),
      ),
    );

    await mkdir(path.join(root, 'ui', 'dist'), { recursive: true });
    await writeFile(path.join(root, 'ui', 'dist', 'index.html'), '<!doctype html>\n');

    lines = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes('[setup] ui build: done — ui/dist present')));
  });
});

// ---------- page_inventory .json authority ----------

test('page_inventory coverage accepts .json inventory files', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'zz');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, 'search_urls.md'),
      '## linkedin\n### search-results\n  • eng - https://example.com/jobs\n',
    );
    const inventoryDir = path.join(
      root,
      'src',
      'adapters',
      'lanes',
      'linkedin',
      'page_inventory',
    );
    await mkdir(inventoryDir, { recursive: true });
    // pins the .md->.json bugfix — with .md-only lookup this reports missing
    await writeFile(path.join(inventoryDir, 'search-results.json'), '{}\n');

    const lines: string[] = [];
    await setupCommand({ profile: 'zz' }, { root, write: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes('page_inventory coverage: done')));
  });
});

// ---------- config→db Phase 4: readConnectorNeeds/stepResume/stepSearchUrls
// read via the injected configStore, not the filesystem ----------

test('stepResume and stepSearchUrls read via the injected configStore: resume.json/search_urls.md content that exists ONLY in the fake store (never written to disk) is reported done', async () => {
  await withTmpRoot(async (root) => {
    // resume.json is never scaffolded (seedProfileDocs never seeds it —
    // it stays hand-maintained), so a real disk read would report
    // "missing" here; search_urls.md pre-seeded in the SAME fake store is
    // "kept" as-is by stepScaffold (Task 7 — scaffold reads/writes through
    // this same injected store too), so the 1-URL content below survives
    // unclobbered — either fallthrough would make this test fail, proving
    // the seam is genuinely reached.
    const store = fakeConfigStore({
      'resume.json': '{}',
      'search_urls.md': '## linkedin\n### x\n  • eng - https://example.com/jobs\n',
    });
    const lines: string[] = [];
    await setupCommand(
      { profile: 'ghost' },
      { root, write: (l) => lines.push(l), configStore: () => store },
    );
    assert.ok(lines.some((l) => l.includes('resume.json: done')));
    assert.ok(
      lines.some((l) => l.includes('search_urls.md: done') && l.includes('1 URL(s)')),
    );
  });
});

test('stepResume/stepSearchUrls: configStore resolving undefined for both docs reports the same needs-action shape as a true "missing" on disk', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore({});
    const lines: string[] = [];
    await setupCommand(
      { profile: 'ghost' },
      { root, write: (l) => lines.push(l), configStore: () => store },
    );
    assert.ok(
      lines.some((l) => l.includes('resume.json: needs-action') && l.includes('missing')),
    );
    // search_urls.md, unlike resume.json, IS scaffolded (Task 7 —
    // stepScaffold seeds it into this same empty fake store before
    // stepSearchUrls reads it back), so an empty store reports the
    // zero-URL template's own detail, not a bare "missing".
    assert.ok(
      lines.some((l) => l.includes('search_urls.md: needs-action — no URLs yet')),
    );
  });
});

// ---------- home creation (P8 data-home Task 3) ----------

test('setupCommand creates <root>/profiles/ first, before any other step', async () => {
  await withTmpRoot(async (root) => {
    const mkdirCalls: string[] = [];
    const lines: string[] = [];
    const code = await setupCommand(
      { profile: 'acme' },
      {
        root,
        write: (l) => lines.push(l),
        mkdir: async (p) => {
          mkdirCalls.push(p);
          return mkdir(p, { recursive: true });
        },
      },
    );
    assert.ok(mkdirCalls.some((p) => p.endsWith('profiles')));
    assert.match(lines[0] as string, /^\[setup\] home: done — /);
    assert.ok((lines[0] as string).includes(root));
    // the home step never blocks the command by itself
    assert.equal(typeof code, 'number');
  });
});

test('readConnectorNeeds reads via the injected configStore: a notion connector known only to the fake store still requires the token', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore({
      'profile.json': JSON.stringify({ connector: 'notion' }),
    });
    await writeFile(path.join(root, '.env'), 'NOTION_TOKEN=abc\n');
    const lines: string[] = [];
    await setupCommand(
      { profile: 'ghost' },
      { root, write: (l) => lines.push(l), configStore: () => store },
    );
    // stepScaffold (Task 7) reads/writes through this SAME injected fake
    // store: profile.json is already present (the notion connector above),
    // so scaffold reports "kept" and leaves it untouched — proving the
    // token step below reflects that same, unclobbered notion connector.
    assert.equal(
      await store.readText('profile.json'),
      JSON.stringify({ connector: 'notion' }),
    );
    const tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
    assert.match(tokenLine ?? '', /done/);
  });
});
