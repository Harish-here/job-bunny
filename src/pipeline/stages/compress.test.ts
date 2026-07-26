import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD } from '../../core/jd/index.ts';
import type { Storage } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import {
  compressStage,
  LOCATION_TRUNCATE_LENGTH,
  PASSTHROUGH_PATH,
  RAW_TEXT_TRUNCATE_LENGTH,
  TABLE_PATH,
  toTable,
} from './compress.ts';

type FakeSourcedJD = JD & { content: { rawText: string } };

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
    async listSubdirs() {
      return [];
    },
    async removeTree() {},
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
  overrides?: Partial<{
    title: string;
    company: string;
    rawText: string;
    location: string;
  }>,
): FakeSourcedJD {
  return {
    identity: {
      id,
      lane: 'linkedin',
      url: `https://example.com/jobs/${id}`,
      company: overrides?.company ?? 'Acme Corp',
      title: overrides?.title ?? 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
      location: overrides?.location,
    },
    content: { rawText: overrides?.rawText ?? 'About the job\nWe build things.' },
  };
}

test('toTable: one row per job with id | title | company | location | rawText columns', () => {
  const jobs = [fakeJob('li-1', { location: 'Bengaluru, India' })];
  const { table } = toTable(jobs);
  const lines = table.split('\n');
  assert.ok(lines[0]?.includes('id'));
  assert.ok(lines[0]?.includes('title'));
  assert.ok(lines[0]?.includes('company'));
  assert.ok(lines[0]?.includes('location'));
  assert.ok(lines[0]?.includes('rawText'));
  const dataRow = lines.find((l) => l.includes('li-1'));
  assert.ok(dataRow);
  assert.ok(dataRow?.includes('Frontend Engineer'));
  assert.ok(dataRow?.includes('Acme Corp'));
  assert.ok(dataRow?.includes('Bengaluru, India'));
  assert.ok(dataRow?.includes('We build things.'));
});

test('toTable: absent identity.location renders as an empty cell', () => {
  const jobs = [fakeJob('li-1b')];
  const { table } = toTable(jobs);
  const dataRow = table.split('\n').find((l) => l.includes('li-1b'));
  assert.ok(dataRow);
  const cells = (dataRow ?? '').split('|').map((c) => c.trim());
  // leading empty, id, title, company, location, rawText, trailing empty
  assert.equal(cells[4], '');
});

test('toTable: escapes | in title, company, and location', () => {
  const jobs = [
    fakeJob('li-2', {
      title: 'Engineer | Backend',
      company: 'Acme | Corp',
      location: 'Remote | US',
    }),
  ];
  const { table } = toTable(jobs);
  const dataRow = table.split('\n').find((l) => l.includes('li-2'));
  assert.ok(dataRow);
  assert.ok(dataRow?.includes('Engineer ｜ Backend'));
  assert.ok(dataRow?.includes('Acme ｜ Corp'));
  assert.ok(dataRow?.includes('Remote ｜ US'));
  // The raw pipe character must not appear inside the cell content itself
  // (only as the table's own column delimiters).
  const cells = dataRow?.split('|') ?? [];
  assert.equal(cells.length, 7); // leading empty + id, title, company, location, rawText + trailing empty
});

test('toTable: location truncated to LOCATION_TRUNCATE_LENGTH chars', () => {
  assert.equal(LOCATION_TRUNCATE_LENGTH, 100);
  const longLocation = `Bengaluru${'x'.repeat(200)}`;
  const jobs = [fakeJob('li-2b', { location: longLocation })];
  const { table } = toTable(jobs);
  const dataRow = table.split('\n').find((l) => l.includes('li-2b'));
  assert.ok(dataRow);
  const cells = (dataRow ?? '').split('|').map((c) => c.trim());
  assert.equal(cells[4]?.length, LOCATION_TRUNCATE_LENGTH);
});

test('toTable: rawText truncated to exactly 2500 chars and sanitised (newline collapse, header strip)', () => {
  assert.equal(RAW_TEXT_TRUNCATE_LENGTH, 2500);
  const longBody = 'x'.repeat(3000);
  const rawText = `About the Job\n\n${longBody}`;
  const jobs = [fakeJob('li-3', { rawText })];
  const { table } = toTable(jobs);
  const dataRow = table.split('\n').find((l) => l.includes('li-3'));
  assert.ok(dataRow);
  // header stripped, newlines collapsed to a single space, no more than
  // RAW_TEXT_TRUNCATE_LENGTH chars of the sanitised body survive.
  assert.ok(!dataRow?.toLowerCase().includes('about the job'));
  assert.ok(!dataRow?.includes('\n'));
  const xCount = (dataRow?.match(/x/g) ?? []).length;
  assert.equal(xCount, RAW_TEXT_TRUNCATE_LENGTH);
});

test('toTable: passthrough contains every input id, keyed to the full JD', () => {
  const jobs = [fakeJob('li-4'), fakeJob('li-5')];
  const { passthrough } = toTable(jobs);
  assert.deepEqual(Object.keys(passthrough).sort(), ['li-4', 'li-5']);
  assert.deepEqual(passthrough['li-4'], jobs[0]);
  assert.deepEqual(passthrough['li-5'], jobs[1]);
});

test('toTable: empty input yields an empty table body (header only)', () => {
  const { table, passthrough } = toTable([]);
  assert.deepEqual(passthrough, {});
  const lines = table.split('\n').filter((l) => l.trim().length > 0);
  // header + separator row only, no data rows
  assert.equal(lines.length, 2);
});

test('toTable: a job without content.rawText fails loud', () => {
  const bad = { identity: fakeJob('li-6').identity } as unknown as FakeSourcedJD;
  assert.throws(() => toTable([bad]), /content/i);
});

test('toTable: two jobs sharing an id — first kept, second dropped with a compress.duplicate-id DroppedRecord', () => {
  const first = fakeJob('dup-1', { title: 'Backend Engineer', company: 'Acme' });
  const second = fakeJob('dup-1', { title: 'Different Title', company: 'Different Co' });
  const { table, passthrough, dropped } = toTable([first, second]);

  // Only the first occurrence survives into the table and passthrough map.
  assert.deepEqual(Object.keys(passthrough), ['dup-1']);
  assert.deepEqual(passthrough['dup-1'], first);
  const dataRows = table.split('\n').filter((l) => l.includes('dup-1'));
  assert.equal(dataRows.length, 1);
  assert.ok(dataRows[0]?.includes('Backend Engineer'));

  // The second (loser) is recorded as a DroppedRecord, not silently lost.
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0]?.jd, second);
  assert.equal(dropped[0]?.reasons[0]?.rule, 'compress.duplicate-id');
  assert.equal(dropped[0]?.reasons[0]?.severity, 'hard');
  assert.equal(dropped[0]?.reasons[0]?.pass, false);
  assert.match(dropped[0]?.reasons[0]?.detail ?? '', /dup-1/);
});

test('compressStage: writes table + passthrough to storage and threads jobs through unchanged (no dropped)', async () => {
  const storage = fakeStorage();
  const ctx = fakeCtx(storage);
  const jobs = [fakeJob('li-7'), fakeJob('li-8')];
  const input: StagePayload = { jobs, dropped: [] };

  const out = await compressStage.run(input, ctx);

  assert.equal(out.jobs, input.jobs);
  assert.deepEqual(out.dropped, []);

  const table = storage.store.get(TABLE_PATH);
  assert.equal(typeof table, 'string');
  assert.ok((table as string).includes('li-7'));
  assert.ok((table as string).includes('li-8'));

  const passthrough = storage.store.get(PASSTHROUGH_PATH) as Record<string, JD>;
  assert.deepEqual(Object.keys(passthrough).sort(), ['li-7', 'li-8']);
  assert.deepEqual(passthrough['li-7'], jobs[0]);
});

test('compressStage: fails loud when a job in the payload has no content', async () => {
  const storage = fakeStorage();
  const ctx = fakeCtx(storage);
  const contentless: JD = { identity: fakeJob('li-9').identity };
  const input: StagePayload = { jobs: [contentless], dropped: [] };

  await assert.rejects(() => compressStage.run(input, ctx), /content/i);

  // Nothing should be written on a loud failure.
  assert.equal(storage.store.has(TABLE_PATH), false);
  assert.equal(storage.store.has(PASSTHROUGH_PATH), false);
});

test('compressStage: a duplicate id in the payload accumulates onto input.dropped, not replacing it', async () => {
  const storage = fakeStorage();
  const ctx = fakeCtx(storage);
  const first = fakeJob('dup-2');
  const second = fakeJob('dup-2', { title: 'Other Title' });
  const preexisting = {
    jd: fakeJob('unrelated'),
    reasons: [
      {
        rule: 'source.earlier-drop',
        severity: 'hard' as const,
        pass: false,
        detail: 'x',
      },
    ],
  };
  const input: StagePayload = { jobs: [first, second], dropped: [preexisting] };

  const out = await compressStage.run(input, ctx);

  assert.equal(out.dropped.length, 2);
  assert.equal(out.dropped[0], preexisting);
  assert.equal(out.dropped[1]?.reasons[0]?.rule, 'compress.duplicate-id');
});
