/**
 * lane_add_url.test.ts (P8) — TDD for the pure URL helpers (ported
 * straight from v0 `scripts/setup/add_url.test.js`) and for
 * `laneAddUrlCommand`'s file-append behavior against a temp profile dir
 * (never the real `profiles/`).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { laneAddUrlCommand, resolvePage, stripEphemerals } from './lane_add_url.ts';

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
    const code = await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search/?keywords=engineer',
        label: 'eng',
      },
      { root, write: () => {}, warn: (l) => warnings.push(l) },
    );
    assert.equal(code, 0);

    const text = await readFile(
      path.join(root, 'profiles', 'acme', 'search_urls.md'),
      'utf8',
    );
    assert.match(text, /## linkedin/);
    assert.match(text, /### linkedin__jobs-search/);
    assert.match(text, /<!-- inventory: page_inventory\/linkedin__jobs-search\.md -->/);
    assert.match(
      text,
      /• eng - https:\/\/www\.linkedin\.com\/jobs\/search\/\?keywords=engineer/,
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /no inventory yet/);
  });
});

test('laneAddUrlCommand does not warn when the page inventory exists', async () => {
  await withTmpRoot(async (root) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(root, 'page_inventory'), { recursive: true });
    await writeFile(
      path.join(root, 'page_inventory', 'linkedin__jobs-search.md'),
      '# inventory\n',
    );

    const warnings: string[] = [];
    const code = await laneAddUrlCommand(
      { profile: 'acme', url: 'https://www.linkedin.com/jobs/search/' },
      { root, write: () => {}, warn: (l) => warnings.push(l) },
    );
    assert.equal(code, 0);
    assert.equal(warnings.length, 0);
  });
});

test('laneAddUrlCommand defaults an unlabeled URL to "unlabeled"', async () => {
  await withTmpRoot(async (root) => {
    await laneAddUrlCommand(
      { profile: 'acme', url: 'https://www.linkedin.com/jobs/search/?keywords=engineer' },
      { root, write: () => {}, warn: () => {} },
    );
    const text = await readFile(
      path.join(root, 'profiles', 'acme', 'search_urls.md'),
      'utf8',
    );
    assert.match(text, /• unlabeled - /);
  });
});

test('laneAddUrlCommand appends a second URL under the same page node without duplicating the heading', async () => {
  await withTmpRoot(async (root) => {
    await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search/?keywords=engineer',
        label: 'one',
      },
      { root, write: () => {}, warn: () => {} },
    );
    await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search/?keywords=manager',
        label: 'two',
      },
      { root, write: () => {}, warn: () => {} },
    );
    const text = await readFile(
      path.join(root, 'profiles', 'acme', 'search_urls.md'),
      'utf8',
    );
    const headingCount = (text.match(/### linkedin__jobs-search$/gm) || []).length;
    assert.equal(headingCount, 1);
    assert.match(text, /• one - /);
    assert.match(text, /• two - /);
  });
});

test('laneAddUrlCommand adds a distinct page node for a different page type without disturbing the first', async () => {
  await withTmpRoot(async (root) => {
    await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search/?keywords=engineer',
        label: 'one',
      },
      { root, write: () => {}, warn: () => {} },
    );
    await laneAddUrlCommand(
      {
        profile: 'acme',
        url: 'https://www.linkedin.com/jobs/search-results/?keywords=manager',
        label: 'two',
      },
      { root, write: () => {}, warn: () => {} },
    );
    const text = await readFile(
      path.join(root, 'profiles', 'acme', 'search_urls.md'),
      'utf8',
    );
    assert.match(text, /### linkedin__jobs-search$/m);
    assert.match(text, /### linkedin__jobs-search-results$/m);
    assert.match(text, /• one - /);
    assert.match(text, /• two - /);
  });
});

test('laneAddUrlCommand rejects a URL with no known page-type mapping', async () => {
  await withTmpRoot(async (root) => {
    await assert.rejects(
      laneAddUrlCommand(
        { profile: 'acme', url: 'https://www.indeed.com/jobs' },
        { root, write: () => {}, warn: () => {} },
      ),
    );
  });
});
