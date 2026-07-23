import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CacheEntry, JD } from '../jd/index.ts';
import { dedupe, stripPrincipal } from './dedup.ts';

let seq = 0;
function jd(overrides: {
  id?: string;
  title?: string;
  company?: string;
  city?: string;
  evaluation?: JD['evaluation'];
}): JD {
  seq += 1;
  return {
    identity: {
      id: overrides.id ?? `li-${seq}`,
      lane: 'linkedin',
      url: `https://www.linkedin.com/jobs/view/${seq}`,
      company: overrides.company ?? 'Acme Corp',
      title: overrides.title ?? 'Senior Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    ...(overrides.city
      ? {
          structured: {
            titleParts: {},
            locations: [{ city: overrides.city }],
            skills: [],
          },
        }
      : {}),
    ...(overrides.evaluation ? { evaluation: overrides.evaluation } : {}),
  };
}

function cacheEntry(overrides: Partial<CacheEntry>): CacheEntry {
  return {
    id: overrides.id ?? 'cache-1',
    company: overrides.company ?? 'Acme Corp',
    title: overrides.title ?? 'Senior Frontend Engineer',
    pageId: overrides.pageId ?? 'page-1',
    ...(overrides.city ? { city: overrides.city } : {}),
  };
}

test('dedup.id: drops a job whose identity.id matches a CacheEntry.id', () => {
  const cache = [cacheEntry({ id: 'gh-42', pageId: 'page-42' })];
  const job = jd({ id: 'gh-42', title: 'Some Other Title', company: 'Some Other Co' });

  const { jobs, dropped } = dedupe([job], cache);

  assert.equal(jobs.length, 0);
  assert.equal(dropped.length, 1);
  const [record] = dropped;
  assert.equal(record?.reasons[0]?.rule, 'dedup.id');
  assert.equal(record?.reasons[0]?.severity, 'hard');
  assert.equal(record?.reasons[0]?.pass, false);
  assert.match(record?.reasons[0]?.detail ?? '', /page-42/);
});

test('dedup.repost: drops a job with a fresh id whose title+company (light-normalized) match a cache entry', () => {
  const cache = [
    cacheEntry({ id: '111', title: 'Staff Frontend Engineer', company: 'Acme Corp' }),
  ];
  const job = jd({ id: '222', title: 'staff   frontend engineer', company: 'ACME CORP' });

  const { jobs, dropped } = dedupe([job], cache);

  assert.equal(jobs.length, 0);
  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.repost');
  assert.match(dropped[0]?.reasons[0]?.detail ?? '', /Staff Frontend Engineer/);
});

test('dedup.repost: with-city path — same title+company+city (cache has city, job has same city) is still a repost', () => {
  const cache = [
    cacheEntry({
      id: '111',
      title: 'Staff Frontend Engineer',
      company: 'Acme Corp',
      city: 'Chennai',
    }),
  ];
  const job = jd({
    id: '222',
    title: 'Staff Frontend Engineer',
    company: 'Acme Corp',
    city: 'chennai ',
  });

  const { jobs, dropped } = dedupe([job], cache);

  assert.equal(jobs.length, 0);
  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.repost');
});

test('dedup.repost: without-city path (neither side has a city) falls back to the existing title+company match', () => {
  const cache = [
    cacheEntry({ id: '111', title: 'Staff Frontend Engineer', company: 'Acme Corp' }),
  ];
  const job = jd({ id: '222', title: 'Staff Frontend Engineer', company: 'Acme Corp' });

  const { jobs, dropped } = dedupe([job], cache);

  assert.equal(jobs.length, 0);
  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.repost');
});

test('dedup amendment: same title + same company + DIFFERENT city is NOT a repost (two distinct openings)', () => {
  const cache = [
    cacheEntry({
      id: '111',
      title: 'Staff Frontend Engineer',
      company: 'Acme Corp',
      city: 'Chennai',
    }),
  ];
  const job = jd({
    id: '222',
    title: 'Staff Frontend Engineer',
    company: 'Acme Corp',
    city: 'Bengaluru',
  });

  const { jobs, dropped } = dedupe([job], cache);

  assert.equal(dropped.length, 0);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.identity.id, '222');
});

test('does not clobber a cache-sourced index entry: a job kept only via citiesConflict must not let a later genuine repost escape', () => {
  const cache = [
    cacheEntry({
      id: 'cache-1',
      title: 'SWE',
      company: 'Acme',
      city: 'Bangalore',
      pageId: 'page-1',
    }),
  ];
  const jobA = jd({ id: 'fresh-a', title: 'SWE', company: 'Acme', city: 'Chennai' });
  const jobB = jd({ id: 'fresh-b', title: 'SWE', company: 'Acme', city: 'Bangalore' });

  const { jobs, dropped } = dedupe([jobA, jobB], cache);

  // jobA is kept (different city — citiesConflict rejects the cache match).
  assert.deepEqual(
    jobs.map((j) => j.identity.id),
    ['fresh-a'],
  );
  // jobB (same city as the cache entry) must still be recognized as a
  // repost of the CACHE entry, not compared against jobA's now-stale index
  // slot.
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.jd.identity.id, 'fresh-b');
  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.repost');
  assert.match(dropped[0]?.reasons[0]?.detail ?? '', /page-1/);
});

test('dedup.role-company: drops a job that only matches a cache entry after aggressive (legal-suffix/token) normalization', () => {
  // "Widget Ltd" vs "Widget Private Limited" only line up once companyKey
  // folds legal suffixes — light exactKey normalization keeps them distinct,
  // so this must resolve to the fuzzy fallback, not dedup.repost.
  const cache = [
    cacheEntry({
      id: '',
      title: 'Backend Engineer',
      company: 'Widget Ltd',
      pageId: 'page-legacy',
    }),
  ];
  const job = jd({
    id: '555',
    title: 'Backend Engineer',
    company: 'Widget Private Limited',
  });

  const { jobs, dropped } = dedupe([job], cache);

  assert.equal(jobs.length, 0);
  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.role-company');
  assert.match(dropped[0]?.reasons[0]?.detail ?? '', /page-legacy/);
});

test('an id-only cache match takes priority over a title+company match to a different cache entry', () => {
  const cache = [
    cacheEntry({
      id: 'gh-1',
      title: 'Frontend Engineer',
      company: 'Acme Corp',
      pageId: 'page-a',
    }),
  ];
  const job = jd({
    id: 'gh-1',
    title: 'Totally Different Title',
    company: 'Totally Different Co',
  });

  const { dropped } = dedupe([job], cache);

  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.id');
});

test('intra-run duplicate: keeps the first occurrence and drops later ones with duplicateOf set', () => {
  const first = jd({ id: '333', title: 'Senior Product Designer', company: 'Nova Labs' });
  const second = jd({
    id: '444',
    title: 'Senior Product Designer',
    company: 'Nova Labs',
  });

  const { jobs, dropped } = dedupe([first, second], []);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.identity.id, '333');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.jd.identity.id, '444');
  assert.equal(dropped[0]?.jd.evaluation?.duplicateOf, '333');
  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.repost');
  assert.match(dropped[0]?.reasons[0]?.detail ?? '', /earlier job in this run/);
});

test('intra-run duplicate: a third repost of the same run resolves to the first kept occurrence, not the second (dropped) one', () => {
  const first = jd({ id: '333', title: 'Senior Product Designer', company: 'Nova Labs' });
  const second = jd({
    id: '444',
    title: 'Senior Product Designer',
    company: 'Nova Labs',
  });
  const third = jd({ id: '666', title: 'Senior Product Designer', company: 'Nova Labs' });

  const { jobs, dropped } = dedupe([first, second, third], []);

  assert.equal(jobs.length, 1);
  assert.equal(dropped.length, 2);
  assert.equal(dropped[0]?.jd.evaluation?.duplicateOf, '333');
  assert.equal(dropped[1]?.jd.evaluation?.duplicateOf, '333');
});

test('intra-run duplicate by exact id repeated in the same batch', () => {
  const first = jd({ id: '333', title: 'Senior Product Designer', company: 'Nova Labs' });
  const repeatedId = jd({
    id: '333',
    title: 'Senior Product Designer',
    company: 'Nova Labs',
  });

  const { jobs, dropped } = dedupe([first, repeatedId], []);

  assert.equal(jobs.length, 1);
  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.id');
  assert.equal(dropped[0]?.jd.evaluation?.duplicateOf, '333');
});

test('a genuinely new job (no cache or intra-run match) passes through unchanged', () => {
  const cache = [
    cacheEntry({ id: 'gh-1', title: 'Backend Engineer', company: 'Other Co' }),
  ];
  const job = jd({
    id: 'li-999',
    title: 'Staff Frontend Engineer',
    company: 'Acme Corp',
  });

  const { jobs, dropped } = dedupe([job], cache);

  assert.equal(dropped.length, 0);
  assert.deepEqual(jobs, [job]);
});

test('does not mutate input jobs or cache entries', () => {
  const cache = [
    cacheEntry({ id: 'gh-1', title: 'Backend Engineer', company: 'Other Co' }),
  ];
  const cacheSnapshot = JSON.parse(JSON.stringify(cache));
  const kept = jd({ id: 'li-1', title: 'Staff Frontend Engineer', company: 'Acme Corp' });
  const dup = jd({ id: 'li-2', title: 'Staff Frontend Engineer', company: 'Acme Corp' });
  const keptSnapshot = JSON.parse(JSON.stringify(kept));
  const dupSnapshot = JSON.parse(JSON.stringify(dup));

  dedupe([kept, dup], cache);

  assert.deepEqual(cache, cacheSnapshot);
  assert.deepEqual(kept, keptSnapshot);
  assert.deepEqual(dup, dupSnapshot);
});

test('stripPrincipal removes the standalone word "Principal" and tidies punctuation', () => {
  assert.equal(stripPrincipal('Principal Frontend Engineer'), 'Frontend Engineer');
  assert.equal(stripPrincipal('Frontend Engineer - Principal'), 'Frontend Engineer');
  assert.equal(stripPrincipal('Frontend  Engineer'), 'Frontend Engineer');
  assert.equal(stripPrincipal(''), '');
});

test('dedup.repost matching is insensitive to standalone "Principal" in the title (ports stripPrincipalFromTitle)', () => {
  const cache = [
    cacheEntry({ id: '111', title: 'Frontend Engineer', company: 'Acme Corp' }),
  ];
  const job = jd({
    id: '222',
    title: 'Principal Frontend Engineer',
    company: 'Acme Corp',
  });

  const { dropped } = dedupe([job], cache);

  assert.equal(dropped[0]?.reasons[0]?.rule, 'dedup.repost');
});

test('kept jobs preserve original relative order', () => {
  const a = jd({ id: 'a', title: 'Role A', company: 'Company A' });
  const b = jd({ id: 'b', title: 'Role B', company: 'Company B' });
  const c = jd({ id: 'c', title: 'Role C', company: 'Company C' });

  const { jobs } = dedupe([a, b, c], []);

  assert.deepEqual(
    jobs.map((j) => j.identity.id),
    ['a', 'b', 'c'],
  );
});
