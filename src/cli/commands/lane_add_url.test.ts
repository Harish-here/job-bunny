/**
 * lane_add_url.test.ts (P8; config→db Phase 4, Task 7) — TDD for the pure
 * URL helpers (ported straight from v0 `scripts/setup/add_url.test.js`)
 * and for `laneAddUrlCommand`'s search_urls.md-append behavior against a
 * fake, in-memory `ConfigStore` (never the real `profiles/`). The
 * inventory-presence warning still exercises a real temp dir via the
 * unrelated `exists`/`mkdir` deps.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConfigDocKey, ConfigStore } from '../../ports/config_store.ts';
import { laneAddUrlCommand, resolvePage, stripEphemerals } from './lane_add_url.ts';

/** In-memory `ConfigStore` fake, same Map-backed shape used throughout
 * this program (`cli/commands/config.test.ts`, `setup.test.ts`). */
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

// ---------- stripEphemerals ----------

test('stripEphemerals removes all ephemeral params when several are present', () => {
  const raw =
    'https://www.linkedin.com/jobs/search/?keywords=engineer' +
    '&currentJobId=123&referralSearchId=abc&origin=JOB_SEARCH_PAGE' +
    '&originToLandingJobPostings=456&savedSearchId=789&alertAction=viewjob' +
    '&trackingId=xyz&refId=def&eBP=ghi&start=25';
  const u = stripEphemerals(raw);
  for (const p of [
    'currentJobId',
    'referralSearchId',
    'origin',
    'originToLandingJobPostings',
    'savedSearchId',
    'alertAction',
    'trackingId',
    'refId',
    'eBP',
    'start',
  ]) {
    assert.equal(u.searchParams.has(p), false, `expected ${p} to be stripped`);
  }
  assert.equal(u.searchParams.get('keywords'), 'engineer');
});

test('stripEphemerals deletes an absolute f_TPR anchor (a<epoch>-)', () => {
  const u = stripEphemerals(
    'https://www.linkedin.com/jobs/search/?f_TPR=a1700000000-&keywords=engineer',
  );
  assert.equal(u.searchParams.has('f_TPR'), false);
  assert.equal(u.searchParams.get('keywords'), 'engineer');
});

test('stripEphemerals keeps a relative f_TPR window (r<seconds>) unchanged', () => {
  const u = stripEphemerals(
    'https://www.linkedin.com/jobs/search/?f_TPR=r86400&keywords=engineer',
  );
  assert.equal(u.searchParams.get('f_TPR'), 'r86400');
});

test('stripEphemerals leaves stable/non-ephemeral params untouched', () => {
  const u = stripEphemerals(
    'https://www.linkedin.com/jobs/search/?keywords=engineer&location=Remote&f_WT=2',
  );
  assert.equal(u.searchParams.get('keywords'), 'engineer');
  assert.equal(u.searchParams.get('location'), 'Remote');
  assert.equal(u.searchParams.get('f_WT'), '2');
});

test('stripEphemerals does not throw and returns the URL essentially unchanged when no ephemeral params present', () => {
  const raw = 'https://www.linkedin.com/jobs/search/?keywords=engineer&location=Remote';
  let u: URL | undefined;
  assert.doesNotThrow(() => {
    u = stripEphemerals(raw);
  });
  assert.equal(u?.searchParams.get('keywords'), 'engineer');
  assert.equal(u?.searchParams.get('location'), 'Remote');
  assert.equal(u?.searchParams.toString(), new URL(raw).searchParams.toString());
});

// ---------- resolvePage ----------

test('resolvePage maps /jobs/search and /jobs/search/ to linkedin__jobs-search', () => {
  assert.deepEqual(resolvePage(new URL('https://www.linkedin.com/jobs/search')), {
    channel: 'linkedin',
    page: 'linkedin__jobs-search',
  });
  assert.deepEqual(resolvePage(new URL('https://www.linkedin.com/jobs/search/')), {
    channel: 'linkedin',
    page: 'linkedin__jobs-search',
  });
});

test('resolvePage maps anything starting with /jobs/collections/ to linkedin__jobs-search', () => {
  assert.deepEqual(
    resolvePage(new URL('https://www.linkedin.com/jobs/collections/recommended')),
    {
      channel: 'linkedin',
      page: 'linkedin__jobs-search',
    },
  );
});

test('resolvePage maps /jobs/search-results and /jobs/search-results/ to linkedin__jobs-search-results', () => {
  assert.deepEqual(resolvePage(new URL('https://www.linkedin.com/jobs/search-results')), {
    channel: 'linkedin',
    page: 'linkedin__jobs-search-results',
  });
  assert.deepEqual(
    resolvePage(new URL('https://www.linkedin.com/jobs/search-results/')),
    {
      channel: 'linkedin',
      page: 'linkedin__jobs-search-results',
    },
  );
});

test('resolvePage throws for a non-linkedin hostname', () => {
  assert.throws(() => resolvePage(new URL('https://www.indeed.com/jobs/search')));
});

test('resolvePage throws for an unrecognized linkedin path', () => {
  assert.throws(() => resolvePage(new URL('https://www.linkedin.com/feed/')));
});

// ---------- laneAddUrlCommand ----------

async function withTmpRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'jobbunny-lane-add-url-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('laneAddUrlCommand creates search_urls.md with channel/page nodes and the URL line, warns on missing inventory', async () => {
  await withTmpRoot(async (root) => {
    const warnings: string[] = [];
    const store = fakeConfigStore();
    // `exists` is stubbed (rather than relying on a real missing file)
    // because the inventory probe is now package-rooted (fix round) —
    // `linkedin__jobs-search.json` genuinely ships in this repo's own
    // package, so a real fs check would never report "missing" for it.
    // The stub also pins the regression itself: the probed path must NOT
    // contain `root` (the data home) at all.
    const probedPaths: string[] = [];
    const code = await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search/?keywords=engineer',
        label: 'eng',
      },
      {
        root,
        write: () => {},
        warn: (l) => warnings.push(l),
        configStore: () => store,
        exists: async (p) => {
          probedPaths.push(p);
          return false;
        },
      },
    );
    assert.equal(code, 0);

    const text = await store.readText('search_urls.md');
    assert.match(text ?? '', /## linkedin/);
    assert.match(text ?? '', /### linkedin__jobs-search/);
    assert.match(
      text ?? '',
      /<!-- inventory: src\/adapters\/lanes\/linkedin\/page_inventory\/linkedin__jobs-search\.json -->/,
    );
    assert.match(
      text ?? '',
      /• eng - https:\/\/www\.linkedin\.com\/jobs\/search\/\?keywords=engineer/,
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /no inventory yet/);
    assert.equal(probedPaths.length, 1);
    assert.ok(
      !(probedPaths[0] ?? '').includes(root),
      'the inventory probe must not be rooted at the data home',
    );
  });
});

test('laneAddUrlCommand does not warn when the page inventory exists in the package — even with a data-home-shaped root that has no src/ tree at all', async () => {
  // Real-component regression proof (fix round, important finding 3):
  // `root` here is a genuine data-home tmp dir with NO `src/` tree
  // whatsoever, and `exists` is left on its REAL default (no stub) — the
  // page ('linkedin__jobs-search') is a page inventory that genuinely
  // ships inside this repo's own package. Before the fix, the probe was
  // rooted at `root` and always reported "missing" here.
  await withTmpRoot(async (root) => {
    const warnings: string[] = [];
    const store = fakeConfigStore();
    const code = await laneAddUrlCommand(
      { profile: 'acme', url: 'https://www.linkedin.com/jobs/search/' },
      { root, write: () => {}, warn: (l) => warnings.push(l), configStore: () => store },
    );
    assert.equal(code, 0);
    assert.equal(warnings.length, 0);
  });
});

test('laneAddUrlCommand defaults an unlabeled URL to "unlabeled"', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore();
    await laneAddUrlCommand(
      { profile: 'acme', url: 'https://www.linkedin.com/jobs/search/?keywords=engineer' },
      { root, write: () => {}, warn: () => {}, configStore: () => store },
    );
    const text = await store.readText('search_urls.md');
    assert.match(text ?? '', /• unlabeled - /);
  });
});

test('laneAddUrlCommand appends a second URL under the same page node without duplicating the heading', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore();
    await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search/?keywords=engineer',
        label: 'one',
      },
      { root, write: () => {}, warn: () => {}, configStore: () => store },
    );
    await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search/?keywords=manager',
        label: 'two',
      },
      { root, write: () => {}, warn: () => {}, configStore: () => store },
    );
    const text = (await store.readText('search_urls.md')) ?? '';
    const headingCount = (text.match(/### linkedin__jobs-search$/gm) || []).length;
    assert.equal(headingCount, 1);
    assert.match(text, /• one - /);
    assert.match(text, /• two - /);
  });
});

test('laneAddUrlCommand adds a distinct page node for a different page type without disturbing the first', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore();
    await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search/?keywords=engineer',
        label: 'one',
      },
      { root, write: () => {}, warn: () => {}, configStore: () => store },
    );
    await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search-results/?keywords=manager',
        label: 'two',
      },
      { root, write: () => {}, warn: () => {}, configStore: () => store },
    );
    const text = (await store.readText('search_urls.md')) ?? '';
    assert.match(text, /### linkedin__jobs-search$/m);
    assert.match(text, /### linkedin__jobs-search-results$/m);
    assert.match(text, /• one - /);
    assert.match(text, /• two - /);
  });
});

test('laneAddUrlCommand rejects a URL with no known page-type mapping', async () => {
  await withTmpRoot(async (root) => {
    const store = fakeConfigStore();
    await assert.rejects(
      laneAddUrlCommand(
        { profile: 'acme', url: 'https://www.indeed.com/jobs' },
        { root, write: () => {}, warn: () => {}, configStore: () => store },
      ),
    );
  });
});
