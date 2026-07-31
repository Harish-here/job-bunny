/**
 * migrate_export.ts tests — always against a stubbed `NotionSdkClientLike`
 * (via `NotionApi({ client: stub })`), never the real SDK, never the
 * network. `pageToMigratedRecord` cases (1-6) pin a fixed `now` so
 * assertions on `scrapedAt`/`syncedAt` are deterministic; `exportForMigration`
 * cases (7-8) exercise the full read path, including the ZERO-writes
 * guarantee.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { NotionApi, type NotionSdkClientLike } from './client.ts';
import { exportForMigration, pageToMigratedRecord } from './migrate_export.ts';
import { PROPERTIES } from './schema.ts';

const NOW = '2026-08-02T10:00:00.000Z';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
    beat() {},
  };
}

function rt(content: string) {
  return { rich_text: [{ plain_text: content }] };
}

function titleVal(content: string) {
  return { title: [{ plain_text: content }] };
}

function select(name: string) {
  return { select: { name } };
}

function date(start: string) {
  return { date: { start } };
}

function page(id: string, props: Record<string, unknown>) {
  return { id, properties: props };
}

function stubWithPages(pages: unknown[]): NotionSdkClientLike {
  return {
    databases: {
      query: async () => ({ results: pages, has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async () => ({ id: 'x' }),
    },
  };
}

test('pageToMigratedRecord: full page (li- URL, all automated + all 7 manual fields) maps per contract', () => {
  const raw = page('page-1111', {
    [PROPERTIES.jobTitle.name]: titleVal('Staff Frontend Engineer'),
    [PROPERTIES.company.name]: rt('Acme Corp'),
    [PROPERTIES.seniorityLevel.name]: select('Staff'),
    [PROPERTIES.locationCity.name]: rt('Chennai'),
    [PROPERTIES.workType.name]: select('Remote'),
    [PROPERTIES.keySkills.name]: rt('React, TypeScript, Node.js'),
    [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/12345' },
    [PROPERTIES.dateFound.name]: date('2026-07-01'),
    [PROPERTIES.timezone.name]: select('APAC'),
    [PROPERTIES.excitement.name]: select('Vera level'),
    [PROPERTIES.matchReasons.name]: rt('Strong skills match\nGreat comp'),
    [PROPERTIES.status.name]: select('Applied'),
    [PROPERTIES.compRange.name]: rt('$150k-$180k'),
    [PROPERTIES.notes.name]: rt('Referred by a friend'),
    [PROPERTIES.contact.name]: rt('Jane Recruiter'),
    [PROPERTIES.dateApplied.name]: date('2026-07-15'),
    [PROPERTIES.nextAction.name]: rt('Follow up'),
    [PROPERTIES.nextActionDate.name]: date('2026-07-22'),
  });

  const record = pageToMigratedRecord(raw, NOW);

  assert.deepEqual(record.jd, {
    identity: {
      id: 'li-12345',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/12345',
      company: 'Acme Corp',
      title: 'Staff Frontend Engineer',
      scrapedAt: '2026-07-01T00:00:00.000Z',
    },
    structured: {
      titleParts: { seniority: 'Staff' },
      locations: [{ city: 'Chennai' }],
      workType: 'remote',
      timezone: 'APAC',
      skills: ['React', 'TypeScript', 'Node.js'],
    },
    evaluation: {
      verdicts: [],
      matchReasons: ['Strong skills match', 'Great comp'],
      excitement: 'Vera level',
    },
    sync: { pageId: 'page-1111', syncedAt: NOW },
  });
  assert.deepEqual(record.tracking, {
    status: 'Applied',
    compRange: '$150k-$180k',
    notes: 'Referred by a friend',
    contact: 'Jane Recruiter',
    dateApplied: '2026-07-15',
    nextAction: 'Follow up',
    nextActionDate: '2026-07-22',
  });
});

test('pageToMigratedRecord: no manual fields at all => tracking is undefined', () => {
  const raw = page('page-2222', {
    [PROPERTIES.jobTitle.name]: titleVal('Backend Engineer'),
    [PROPERTIES.company.name]: rt('Other Co'),
    [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/999' },
  });

  const record = pageToMigratedRecord(raw, NOW);

  assert.equal(record.tracking, undefined);
});

test('pageToMigratedRecord: un-derivable URL => id nt-<pageid-no-dashes>, lane notion-import', () => {
  const raw = page('abcd-1234-ef56', {
    [PROPERTIES.jobTitle.name]: titleVal('Mystery Role'),
    [PROPERTIES.company.name]: rt('Mystery Co'),
    [PROPERTIES.jobUrl.name]: { url: 'https://example.com/careers/mystery' },
  });

  const record = pageToMigratedRecord(raw, NOW);

  assert.equal(record.jd.identity.id, 'nt-abcd1234ef56');
  assert.equal(record.jd.identity.lane, 'notion-import');
});

test('pageToMigratedRecord: no Job URL => notion.so permalink fallback, id nt-…', () => {
  const raw = page('abcd-1234-ef56', {
    [PROPERTIES.jobTitle.name]: titleVal('No URL Role'),
    [PROPERTIES.company.name]: rt('No URL Co'),
  });

  const record = pageToMigratedRecord(raw, NOW);

  assert.equal(record.jd.identity.url, 'https://www.notion.so/abcd1234ef56');
  assert.equal(record.jd.identity.id, 'nt-abcd1234ef56');
  assert.equal(record.jd.identity.lane, 'notion-import');
});

test('pageToMigratedRecord: On-site maps to onsite; seniority not in SENIORITY_OPTIONS is omitted; empty Location City => []', () => {
  const raw = page('page-3333', {
    [PROPERTIES.jobTitle.name]: titleVal('Site Reliability Engineer'),
    [PROPERTIES.company.name]: rt('Widget Inc'),
    [PROPERTIES.seniorityLevel.name]: select('Junior'),
    [PROPERTIES.workType.name]: select('On-site'),
    [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/55' },
  });

  const record = pageToMigratedRecord(raw, NOW);

  assert.equal(record.jd.structured?.workType, 'onsite');
  assert.deepEqual(record.jd.structured?.titleParts, {});
  // Load-bearing: locations must be [] here, never [{ city: '' }] — an
  // empty-city entry would defeat dedup.repost's company+title+city key,
  // the only duplicate protection an `nt-` row (no derivable identity.id)
  // ever gets.
  assert.deepEqual(record.jd.structured?.locations, []);
});

test('pageToMigratedRecord: no Date Found => scrapedAt is now; Date Found present => date + midnight UTC', () => {
  const noDate = page('page-4444', {
    [PROPERTIES.jobTitle.name]: titleVal('No Date Role'),
    [PROPERTIES.company.name]: rt('No Date Co'),
  });
  const withDate = page('page-5555', {
    [PROPERTIES.jobTitle.name]: titleVal('Dated Role'),
    [PROPERTIES.company.name]: rt('Dated Co'),
    [PROPERTIES.dateFound.name]: date('2026-07-01'),
  });

  assert.equal(pageToMigratedRecord(noDate, NOW).jd.identity.scrapedAt, NOW);
  assert.equal(
    pageToMigratedRecord(withDate, NOW).jd.identity.scrapedAt,
    '2026-07-01T00:00:00.000Z',
  );
});

test('pageToMigratedRecord: Date Found with a time component slices to the date before appending midnight UTC', () => {
  const raw = page('page-6666', {
    [PROPERTIES.jobTitle.name]: titleVal('Timed Date Role'),
    [PROPERTIES.company.name]: rt('Timed Date Co'),
    [PROPERTIES.dateFound.name]: date('2026-07-01T10:00:00.000+05:30'),
  });

  const record = pageToMigratedRecord(raw, NOW);

  assert.equal(record.jd.identity.scrapedAt, '2026-07-01T00:00:00.000Z');
});

test('exportForMigration: a two-page stub yields 2 records (pagination via queryDatabase)', async () => {
  const pages = [
    page('page-a', {
      [PROPERTIES.jobTitle.name]: titleVal('A'),
      [PROPERTIES.company.name]: rt('Co A'),
      [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/1' },
    }),
    page('page-b', {
      [PROPERTIES.jobTitle.name]: titleVal('B'),
      [PROPERTIES.company.name]: rt('Co B'),
      [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/2' },
    }),
  ];
  const api = new NotionApi({ client: stubWithPages(pages) });

  const records = await exportForMigration(api, 'db1', fakeCtx(), NOW);

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.jd.sync?.pageId),
    ['page-a', 'page-b'],
  );
});

test('exportForMigration: performs ZERO Notion writes', async () => {
  let createCalls = 0;
  let updateCalls = 0;
  const pages = [
    page('page-a', {
      [PROPERTIES.jobTitle.name]: titleVal('A'),
      [PROPERTIES.company.name]: rt('Co A'),
      [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/1' },
    }),
  ];
  const client: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: pages, has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => {
        createCalls++;
        return { id: 'x' };
      },
      update: async () => {
        updateCalls++;
        return { id: 'x' };
      },
    },
  };
  const api = new NotionApi({ client });

  await exportForMigration(api, 'db1', fakeCtx(), NOW);

  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 0);
});

test('exportForMigration: a page with a schemeless Job URL rejects, naming the page id', async () => {
  const pages = [
    page('page-bad-url', {
      [PROPERTIES.jobTitle.name]: titleVal('Bad URL Role'),
      [PROPERTIES.company.name]: rt('Bad URL Co'),
      [PROPERTIES.jobUrl.name]: { url: 'linkedin.com/jobs/view/99' },
    }),
  ];
  const api = new NotionApi({ client: stubWithPages(pages) });

  await assert.rejects(
    () => exportForMigration(api, 'db1', fakeCtx(), NOW),
    (err: Error) => {
      assert.match(err.message, /page-bad-url/);
      return true;
    },
  );
});
