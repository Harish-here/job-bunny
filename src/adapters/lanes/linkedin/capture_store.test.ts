import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ZodType } from 'zod';
import { type JD, JDSchema } from '../../../core/jd/index.ts';
import type { Storage } from '../../../ports/storage.ts';
import { CAPTURE_PATH, CaptureStore } from './capture_store.ts';

/** In-memory fake mirroring the real FsStorage contract. */
class FakeStorage implements Storage {
  private readonly files = new Map<string, unknown>();

  set(relPath: string, value: unknown): void {
    this.files.set(relPath, value);
  }

  get(relPath: string): unknown {
    return this.files.get(relPath);
  }

  async readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined> {
    if (!this.files.has(relPath)) return undefined;
    return schema.parse(this.files.get(relPath));
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    this.files.set(relPath, value);
  }
}

function fakeJD(id: string): JD {
  return JDSchema.parse({
    identity: {
      id,
      lane: 'linkedin',
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      company: 'Acme',
      title: 'Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
  });
}

test('load with no persisted file returns an empty store', async () => {
  const storage = new FakeStorage();
  const store = await CaptureStore.load(storage);
  assert.deepEqual(store.all(), []);
});

test('load with a persisted captures file restores its contents', async () => {
  const storage = new FakeStorage();
  const seeded = [fakeJD('1'), fakeJD('2')];
  storage.set(CAPTURE_PATH, seeded);
  const store = await CaptureStore.load(storage);
  assert.deepEqual(
    store.all().map((jd) => jd.identity.id),
    ['1', '2'],
  );
});

test('append adds the job to all() and persists immediately (not batched)', async () => {
  const storage = new FakeStorage();
  const store = await CaptureStore.load(storage);

  await store.append(storage, fakeJD('a'));
  assert.deepEqual(
    store.all().map((jd) => jd.identity.id),
    ['a'],
  );
  // Persisted synchronously after this one append — a reload right now
  // (simulating a crash right after) sees it.
  const reloaded = await CaptureStore.load(storage);
  assert.deepEqual(
    reloaded.all().map((jd) => jd.identity.id),
    ['a'],
  );

  await store.append(storage, fakeJD('b'));
  assert.deepEqual(
    store.all().map((jd) => jd.identity.id),
    ['a', 'b'],
  );
  const reloadedAgain = await CaptureStore.load(storage);
  assert.deepEqual(
    reloadedAgain.all().map((jd) => jd.identity.id),
    ['a', 'b'],
  );
});

test('all() returns a defensive copy — mutating it does not affect the store', async () => {
  const storage = new FakeStorage();
  const store = await CaptureStore.load(storage);
  await store.append(storage, fakeJD('x'));

  const snapshot = store.all();
  snapshot.push(fakeJD('y'));

  assert.deepEqual(
    store.all().map((jd) => jd.identity.id),
    ['x'],
  );
});

test('reset clears both the in-memory list and the persisted file', async () => {
  const storage = new FakeStorage();
  const store = await CaptureStore.load(storage);
  await store.append(storage, fakeJD('stale'));
  assert.equal(store.all().length, 1);

  await store.reset(storage);

  assert.deepEqual(store.all(), []);
  const reloaded = await CaptureStore.load(storage);
  assert.deepEqual(reloaded.all(), []);
});
