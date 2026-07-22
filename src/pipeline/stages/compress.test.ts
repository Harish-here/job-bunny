import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD } from '../../core/jd/index.ts';
import type { Storage } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import {
  compressStage,
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
  overrides?: Partial<{ title: string; company: string; rawText: string }>,
): FakeSourcedJD {
  return {
    identity: {
      id,
      lane: 'linkedin',
      url: `https://example.com/jobs/${id}`,
      company: overrides?.company ?? 'Acme Corp',
      title: overrides?.title ?? 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    content: { rawText: overrides?.rawText ?? 'About the job\nWe build things.' },
  };
}

test('toTable: one row per job with id | title | company | rawText columns', () => {
  const jobs = [fakeJob('li-1')];
  const { table } = toTable(jobs);
  const lines = table.split('\n');
  assert.ok(lines[0]?.includes('id'));
  assert.ok(lines[0]?.includes('title'));
  assert.ok(lines[0]?.includes('company'));
  assert.ok(lines[0]?.includes('rawText'));
  const dataRow = lines.find((l) => l.includes('li-1'));
  assert.ok(dataRow);
  assert.ok(dataRow?.includes('Frontend Engineer'));
  assert.ok(dataRow?.includes('Acme Corp'));
  assert.ok(dataRow?.includes('We build things.'));
});

test('toTable: escapes | in title and company', () => {
  const jobs = [fakeJob('li-2', { title: 'Engineer | Backend', company: 'Acme | Corp' })];
  const { table } = toTable(jobs);
  const dataRow = table.split('\n').find((l) => l.includes('li-2'));
  assert.ok(dataRow);
  assert.ok(dataRow?.includes('Engineer ｜ Backend'));
  assert.ok(dataRow?.includes('Acme ｜ Corp'));
  // The raw pipe character must not appear inside the cell content itself
  // (only as the table's own column delimiters).
  const cells = dataRow?.split('|') ?? [];
  assert.equal(cells.length, 6); // leading empty + id, title, company, rawText + trailing empty
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

test('compressStage: writes table + passthrough to storage and threads payload through unchanged', async () => {
  const storage = fakeStorage();
  const ctx = fakeCtx(storage);
  const jobs = [fakeJob('li-7'), fakeJob('li-8')];
  const input: StagePayload = { jobs, dropped: [] };

  const out = await compressStage.run(input, ctx);

  assert.equal(out, input);

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
