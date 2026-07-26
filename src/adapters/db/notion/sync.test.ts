/**
 * sync.ts tests — always against a stubbed `NotionSdkClientLike` (via
 * `NotionApi({ client: stub })`), never the real SDK, never the network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD } from '../../../core/jd/index.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { NotionApi, type NotionSdkClientLike } from './client.ts';
import { AUTOMATED_FIELDS, PROPERTIES } from './schema.ts';
import { buildAutomatedProperties, syncJobs } from './sync.ts';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
    beat() {},
    ...overrides,
  };
}

function baseJob(overrides: Partial<JD> = {}): JD {
  return {
    identity: {
      id: 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company: 'Acme Corp',
      title: 'Staff Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    ...overrides,
  };
}

const FULL_JOB: JD = {
  identity: {
    id: 'li-42',
    lane: 'linkedin',
    url: 'https://www.linkedin.com/jobs/view/42',
    company: 'Acme Corp',
    title: 'Staff Frontend Engineer',
    scrapedAt: '2026-07-21T09:00:00.000Z',
  },
  structured: {
    titleParts: { seniority: 'Staff' },
    locations: [{ city: 'Chennai' }],
    workType: 'remote',
    timezone: 'APAC',
    skills: ['TypeScript', 'React'],
  },
  evaluation: {
    verdicts: [
      {
        rule: 'filter.some-soft-rule',
        severity: 'soft',
        pass: false,
        detail: 'soft-fail detail',
      },
      { rule: 'filter.hard-rule', severity: 'hard', pass: true },
    ],
    score: 80,
    excitement: 'Vera level',
    matchReasons: ['skills match'],
  },
};

test('buildAutomatedProperties: every key is one of AUTOMATED_FIELDS (no non-automated key ever present)', () => {
  const props = buildAutomatedProperties(FULL_JOB);
  for (const key of Object.keys(props)) {
    assert.ok(
      (AUTOMATED_FIELDS as readonly string[]).includes(key),
      `unexpected non-automated key written: ${key}`,
    );
  }
});

test('buildAutomatedProperties: exact key-by-key payload for a fully-structured/evaluated job', () => {
  const props = buildAutomatedProperties(FULL_JOB);

  assert.deepEqual(props, {
    [PROPERTIES.jobTitle.name]: {
      title: [{ type: 'text', text: { content: 'Staff Frontend Engineer' } }],
    },
    [PROPERTIES.company.name]: {
      rich_text: [{ type: 'text', text: { content: 'Acme Corp' } }],
    },
    [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/42' },
    [PROPERTIES.dateFound.name]: { date: { start: '2026-07-21' } },
    [PROPERTIES.locationCity.name]: {
      rich_text: [{ type: 'text', text: { content: 'Chennai' } }],
    },
    [PROPERTIES.seniorityLevel.name]: { select: { name: 'Staff' } },
    [PROPERTIES.workType.name]: { select: { name: 'Remote' } },
    [PROPERTIES.timezone.name]: { select: { name: 'APAC' } },
    [PROPERTIES.keySkills.name]: {
      rich_text: [{ type: 'text', text: { content: 'TypeScript, React' } }],
    },
    [PROPERTIES.excitement.name]: { select: { name: 'Vera level' } },
    [PROPERTIES.matchReasons.name]: {
      rich_text: [{ type: 'text', text: { content: 'skills match' } }],
    },
    [PROPERTIES.reviewFlags.name]: {
      rich_text: [{ type: 'text', text: { content: 'soft-fail detail' } }],
    },
  });
});

test('buildAutomatedProperties: an invalid free-form select value (seniority "Senior Staff", timezone "IST") is omitted from the payload, not written; valid values still pass through', () => {
  const invalidJob: JD = {
    ...FULL_JOB,
    structured: {
      titleParts: { seniority: 'Senior Staff' },
      locations: [{ city: 'Chennai' }],
      workType: 'remote',
      timezone: 'IST',
      skills: ['TypeScript', 'React'],
    },
  };

  const invalidProps = buildAutomatedProperties(invalidJob);
  assert.ok(
    !(PROPERTIES.seniorityLevel.name in invalidProps),
    'an invalid seniority value must not be written as a select property',
  );
  assert.ok(
    !(PROPERTIES.timezone.name in invalidProps),
    'an invalid timezone value must not be written as a select property',
  );

  const validProps = buildAutomatedProperties(FULL_JOB);
  assert.deepEqual(validProps[PROPERTIES.seniorityLevel.name], {
    select: { name: 'Staff' },
  });
  assert.deepEqual(validProps[PROPERTIES.timezone.name], { select: { name: 'APAC' } });
});

test('buildAutomatedProperties: an invalid excitement value is likewise omitted', () => {
  const invalidJob: JD = {
    ...FULL_JOB,
    evaluation: {
      verdicts: [],
      score: 80,
      excitement: 'Somewhat excited',
      matchReasons: ['skills match'],
    },
  };
  const props = buildAutomatedProperties(invalidJob);
  assert.ok(!(PROPERTIES.excitement.name in props));
});

test('buildAutomatedProperties: a bare identity-only job writes only the always-present fields', () => {
  const props = buildAutomatedProperties(baseJob());
  assert.deepEqual(
    Object.keys(props).sort(),
    [
      PROPERTIES.company.name,
      PROPERTIES.dateFound.name,
      PROPERTIES.jobTitle.name,
      PROPERTIES.jobUrl.name,
    ].sort(),
  );
});

test('syncJobs: a job with no known pageId is inserted via createPage', async () => {
  const created: { parent: unknown; properties: unknown }[] = [];
  const client: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async (args) => {
        created.push(args);
        return { id: 'new-page-1' };
      },
      update: async () => ({ id: 'x' }),
    },
  };
  const api = new NotionApi({ client });

  const results = await syncJobs(api, 'db1', [baseJob()], fakeCtx());

  assert.equal(created.length, 1);
  assert.deepEqual(created[0]?.parent, { database_id: 'db1' });
  for (const key of Object.keys(created[0]?.properties as Record<string, unknown>)) {
    assert.ok((AUTOMATED_FIELDS as readonly string[]).includes(key));
  }
  assert.equal(results.length, 1);
  assert.equal(results[0]?.sync.pageId, 'new-page-1');
  assert.ok(results[0]?.sync.syncedAt);
});

test('syncJobs: a job with a known sync.pageId is updated via updatePage, key-by-key automated-only payload', async () => {
  const updated: { page_id: string; properties?: Record<string, unknown> }[] = [];
  const client: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => ({ id: 'should-not-be-called' }),
      update: async (args) => {
        updated.push(args);
        return { id: args.page_id };
      },
    },
  };
  const api = new NotionApi({ client });

  const job: JD = {
    ...baseJob(),
    sync: { pageId: 'existing-page-9', syncedAt: '2026-07-01T00:00:00.000Z' },
  };
  const results = await syncJobs(api, 'db1', [job], fakeCtx());

  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.page_id, 'existing-page-9');
  const props = updated[0]?.properties ?? {};
  const keys = Object.keys(props);
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.ok(
      (AUTOMATED_FIELDS as readonly string[]).includes(key),
      `update payload must never contain a non-automated key, got: ${key}`,
    );
  }
  // Never a whole-page overwrite/delete signal: no `archived` key, and the
  // manual "Status" field name must never appear.
  assert.ok(!('Status' in props));
  assert.equal(results[0]?.sync.pageId, 'existing-page-9');
});

test('syncJobs: one page failing after exhausted retries (SoftError) is recorded and the batch continues', async () => {
  let createCalls = 0;
  const client: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => {
        createCalls++;
        if (createCalls === 1) {
          const err = new Error('HTTP 429') as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return { id: `page-${createCalls}` };
      },
      update: async () => ({ id: 'x' }),
    },
  };
  const api = new NotionApi({ client, maxAttempts: 1 });

  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: { ...noopLogger, warn: (msg, data) => warnings.push({ msg, data }) },
  });

  const jobA = baseJob({
    identity: {
      ...baseJob().identity,
      id: 'li-a',
      url: 'https://www.linkedin.com/jobs/view/a',
    },
  });
  const jobB = baseJob({
    identity: {
      ...baseJob().identity,
      id: 'li-b',
      url: 'https://www.linkedin.com/jobs/view/b',
    },
  });

  const results = await syncJobs(api, 'db1', [jobA, jobB], ctx);

  assert.equal(
    results.length,
    1,
    'the failed job is dropped, not thrown, and the batch continues',
  );
  assert.equal(results[0]?.identity.id, 'li-b');
  assert.equal(warnings.length, 1);
});

test('syncJobs: a non-retryable error (e.g. 400 validation) propagates and fails the whole call', async () => {
  const client: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => {
        const err = new Error('validation_error: bad select value') as Error & {
          status: number;
        };
        err.status = 400;
        throw err;
      },
      update: async () => ({ id: 'x' }),
    },
  };
  const api = new NotionApi({ client });

  await assert.rejects(
    () => syncJobs(api, 'db1', [baseJob()], fakeCtx()),
    /validation_error/,
  );
});
