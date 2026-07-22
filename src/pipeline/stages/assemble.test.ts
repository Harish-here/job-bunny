import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD } from '../../core/jd/index.ts';
import type { Storage } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { assembleStage, parseDecisions } from './assemble.ts';
import { PASSTHROUGH_PATH } from './compress.ts';
import { DECISIONS_PATH } from './structure.ts';

function fakeStorage(): Storage & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async readJson<T>(relPath: string, schema: { parse(v: unknown): T }) {
      if (!store.has(relPath)) return undefined;
      return schema.parse(store.get(relPath));
    },
    async writeJson(relPath: string, value: unknown) {
      store.set(relPath, value);
    },
  };
}

function fakeCtx(storage: ReturnType<typeof fakeStorage>): StageContext {
  return {
    profile: 'rajni',
    signal: AbortSignal.timeout(30_000),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    beat() {},
    storage,
  };
}

function fakeJob(
  id: string,
  overrides?: Partial<{ title: string; company: string }>,
): JD {
  return {
    identity: {
      id,
      lane: 'linkedin',
      url: `https://example.com/jobs/${id}`,
      company: overrides?.company ?? 'Acme Corp',
      title: overrides?.title ?? 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    content: { rawText: 'We build things.' },
  };
}

const DECISIONS_HEADER =
  '| id | domain | seniority | func | city | country | workType | timezone | skills | salary |';
const DECISIONS_SEPARATOR = '|---|---|---|---|---|---|---|---|---|---|';

function decisionsTable(rows: string[]): string {
  return `${DECISIONS_HEADER}\n${DECISIONS_SEPARATOR}\n${rows.join('\n')}`;
}

function emptyPayload(): StagePayload {
  return { jobs: [], dropped: [] };
}

test('parseDecisions: skips header and separator lines, keys rows by id', () => {
  const md = decisionsTable([
    '| li-1 | Frontend | Senior | React | Bengaluru | India | onsite |  | React; TypeScript |  |',
  ]);
  const parsed = parseDecisions(md);
  assert.equal(parsed.size, 1);
  assert.ok(parsed.has('li-1'));
});

test('parseDecisions: skips a stray header-looking line and rows with no usable id', () => {
  const md = [
    DECISIONS_HEADER,
    DECISIONS_SEPARATOR,
    '| li-1 | Frontend | Senior | React | Bengaluru | India | onsite |  | React |  |',
    DECISIONS_HEADER, // a second header line mid-table (e.g. from a re-sent batch)
    '|  |  |  |  |  |  |  |  |  |  |', // no usable id
  ].join('\n');
  const parsed = parseDecisions(md);
  assert.deepEqual([...parsed.keys()], ['li-1']);
});

test('parseDecisions: preserves actual cell count for column-drift detection', () => {
  const md = decisionsTable(['| li-1 | Frontend | Senior |']); // only 3 cells, not 10
  const parsed = parseDecisions(md);
  const cells = parsed.get('li-1') as string[];
  assert.equal(cells.length, 3);
});

test('clean row -> StructuredJD joined to the right passthrough JD', async () => {
  const storage = fakeStorage();
  const job = fakeJob('li-1');
  storage.store.set(PASSTHROUGH_PATH, { 'li-1': job });
  storage.store.set(
    DECISIONS_PATH,
    decisionsTable([
      '| li-1 | Frontend | Senior | React | Bengaluru | India | onsite | | React; TypeScript | 20-30 LPA |',
    ]),
  );

  const out = await assembleStage.run(emptyPayload(), fakeCtx(storage));

  assert.equal(out.jobs.length, 1);
  assert.equal(out.dropped.length, 0);
  const structuredJob = out.jobs[0];
  assert.ok(structuredJob);
  assert.deepEqual(structuredJob.identity, job.identity);
  assert.deepEqual(structuredJob.structured, {
    titleParts: { domain: 'Frontend', seniority: 'Senior', func: 'React' },
    locations: [{ city: 'Bengaluru', country: 'India' }],
    workType: 'onsite',
    timezone: undefined,
    skills: ['React', 'TypeScript'],
    salary: '20-30 LPA',
  });
});

test('garbage/unparseable row (wrong shape entirely) -> DroppedRecord with rule structure.unparseable, severity hard, pass false', async () => {
  const storage = fakeStorage();
  const job = fakeJob('li-1');
  storage.store.set(PASSTHROUGH_PATH, { 'li-1': job });
  // A garbage LLM response row: far too few cells to be a real decisions
  // row at all (id + 2 stray cells). buildCandidate is never reached —
  // this is caught by the column-count check, same as the dedicated
  // column-drift test below, but exercises the shared verdict shape
  // end-to-end from a realistically malformed input.
  storage.store.set(DECISIONS_PATH, decisionsTable(['| li-1 | garbage |']));

  const out = await assembleStage.run(emptyPayload(), fakeCtx(storage));

  assert.equal(out.jobs.length, 0);
  assert.equal(out.dropped.length, 1);
  const dropped = out.dropped[0];
  assert.ok(dropped);
  assert.deepEqual(dropped.jd, job);
  assert.equal(dropped.reasons.length, 1);
  assert.equal(dropped.reasons[0]?.rule, 'structure.unparseable');
  assert.equal(dropped.reasons[0]?.severity, 'hard');
  assert.equal(dropped.reasons[0]?.pass, false);
});

test('MISSING row (passthrough id absent from decisions) -> DroppedRecord, detail "row missing from LLM output" (required safety net)', async () => {
  const storage = fakeStorage();
  const job = fakeJob('li-1');
  storage.store.set(PASSTHROUGH_PATH, { 'li-1': job });
  storage.store.set(DECISIONS_PATH, decisionsTable([])); // LLM silently dropped this row

  const out = await assembleStage.run(emptyPayload(), fakeCtx(storage));

  assert.equal(out.jobs.length, 0);
  assert.equal(out.dropped.length, 1);
  const dropped = out.dropped[0];
  assert.ok(dropped);
  assert.deepEqual(dropped.jd, job);
  assert.equal(dropped.reasons[0]?.rule, 'structure.unparseable');
  assert.equal(dropped.reasons[0]?.severity, 'hard');
  assert.equal(dropped.reasons[0]?.pass, false);
  assert.equal(dropped.reasons[0]?.detail, 'row missing from LLM output');
});

test('skills split + normalization: "React; TypeScript ; " -> [React, TypeScript] (trim + drop empties)', async () => {
  const storage = fakeStorage();
  const job = fakeJob('li-1');
  storage.store.set(PASSTHROUGH_PATH, { 'li-1': job });
  storage.store.set(
    DECISIONS_PATH,
    decisionsTable([
      '| li-1 | Frontend | Senior | React | Bengaluru | India | onsite | | React; TypeScript ; |  |',
    ]),
  );

  const out = await assembleStage.run(emptyPayload(), fakeCtx(storage));

  assert.deepEqual(out.jobs[0]?.structured?.skills, ['React', 'TypeScript']);
});

test('empty city -> locations: [] (not a rejected zero-length-city entry); remote row still yields a valid StructuredJD', async () => {
  const storage = fakeStorage();
  const job = fakeJob('li-1');
  storage.store.set(PASSTHROUGH_PATH, { 'li-1': job });
  storage.store.set(
    DECISIONS_PATH,
    decisionsTable([
      '| li-1 | Frontend | Senior | React |  |  | remote | APAC | React |  |',
    ]),
  );

  const out = await assembleStage.run(emptyPayload(), fakeCtx(storage));

  assert.equal(out.dropped.length, 0);
  assert.equal(out.jobs.length, 1);
  assert.deepEqual(out.jobs[0]?.structured?.locations, []);
  assert.equal(out.jobs[0]?.structured?.workType, 'remote');
  assert.equal(out.jobs[0]?.structured?.timezone, 'APAC');
});

test('column-count drift (row with != 10 cells) -> DroppedRecord, stage does not throw', async () => {
  const storage = fakeStorage();
  const job = fakeJob('li-1');
  storage.store.set(PASSTHROUGH_PATH, { 'li-1': job });
  storage.store.set(
    DECISIONS_PATH,
    decisionsTable(['| li-1 | Frontend | Senior | React | Bengaluru | India |']), // 6 cells
  );

  const out = await assembleStage.run(emptyPayload(), fakeCtx(storage));

  assert.equal(out.jobs.length, 0);
  assert.equal(out.dropped.length, 1);
  assert.match(out.dropped[0]?.reasons[0]?.detail ?? '', /expected 10 columns, got 6/);
});

test('workType unknown value (e.g. "flexible") -> StructuredJD with workType undefined (NOT dropped)', async () => {
  const storage = fakeStorage();
  const job = fakeJob('li-1');
  storage.store.set(PASSTHROUGH_PATH, { 'li-1': job });
  storage.store.set(
    DECISIONS_PATH,
    decisionsTable([
      '| li-1 | Frontend | Senior | React | Bengaluru | India | flexible |  | React |  |',
    ]),
  );

  const out = await assembleStage.run(emptyPayload(), fakeCtx(storage));

  assert.equal(out.dropped.length, 0);
  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.structured?.workType, undefined);
});

test('output payload preserves pre-existing input.dropped and appends new drops; jobs + dropped reconcile against passthrough size', async () => {
  const storage = fakeStorage();
  const jobA = fakeJob('li-1');
  const jobB = fakeJob('li-2');
  storage.store.set(PASSTHROUGH_PATH, { 'li-1': jobA, 'li-2': jobB });
  storage.store.set(
    DECISIONS_PATH,
    decisionsTable([
      '| li-1 | Frontend | Senior | React | Bengaluru | India | onsite |  | React |  |',
      // li-2 deliberately absent -> missing-row drop
    ]),
  );

  const preExistingDrop = { jd: fakeJob('li-99'), reasons: [] };
  const input: StagePayload = { jobs: [], dropped: [preExistingDrop] };

  const out = await assembleStage.run(input, fakeCtx(storage));

  assert.equal(out.jobs.length, 1);
  assert.equal(out.dropped.length, 2);
  assert.equal(out.dropped[0], preExistingDrop);
  assert.equal(out.jobs.length + (out.dropped.length - 1), 2); // reconciles against passthrough size (2)
});

test('missing PASSTHROUGH_PATH throws (loud)', async () => {
  const storage = fakeStorage();
  storage.store.set(DECISIONS_PATH, decisionsTable([]));

  await assert.rejects(
    () => assembleStage.run(emptyPayload(), fakeCtx(storage)),
    /no passthrough found/,
  );
});

test('missing DECISIONS_PATH throws (loud)', async () => {
  const storage = fakeStorage();
  storage.store.set(PASSTHROUGH_PATH, {});

  await assert.rejects(
    () => assembleStage.run(emptyPayload(), fakeCtx(storage)),
    /no decisions found/,
  );
});
