import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ZodType } from 'zod';
import type { Storage } from '../../../ports/storage.ts';
import { RESUME_STATE_PATH, ResumeState } from './resume_state.ts';

/** In-memory fake mirroring the real FsStorage contract: undefined for a
 * missing file, schema-validated for a present one. */
class FakeStorage implements Storage {
  private readonly files = new Map<string, unknown>();

  set(relPath: string, value: unknown): void {
    this.files.set(relPath, value);
  }

  async readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined> {
    if (!this.files.has(relPath)) return undefined;
    return schema.parse(this.files.get(relPath));
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    this.files.set(relPath, value);
  }
}

test('load with no persisted file returns a fresh empty state for today', async () => {
  const storage = new FakeStorage();
  const state = await ResumeState.load(storage, '2026-07-21');
  assert.equal(state.shouldSkip('https://example.com/a'), false);
  assert.equal(state.allDone([]), true);
  assert.equal(state.allDone(['https://example.com/a']), false);
});

test('load with a stale (different) persisted date returns a fresh empty state', async () => {
  const storage = new FakeStorage();
  storage.set(RESUME_STATE_PATH, {
    date: '2026-07-20',
    done: { 'https://example.com/a': 5 },
  });
  const state = await ResumeState.load(storage, '2026-07-21');
  assert.equal(state.shouldSkip('https://example.com/a'), false);
});

test('load with the same-day persisted date restores the done-map', async () => {
  const storage = new FakeStorage();
  storage.set(RESUME_STATE_PATH, {
    date: '2026-07-21',
    done: { 'https://example.com/a': 3, 'https://example.com/b': 0 },
  });
  const state = await ResumeState.load(storage, '2026-07-21');
  assert.equal(state.shouldSkip('https://example.com/a'), true);
  assert.equal(state.shouldSkip('https://example.com/b'), true);
  assert.equal(state.shouldSkip('https://example.com/c'), false);
});

test('markDone + shouldSkip + allDone correctness', async () => {
  const storage = new FakeStorage();
  const state = await ResumeState.load(storage, '2026-07-21');
  const urls = ['https://example.com/a', 'https://example.com/b'];

  assert.equal(state.allDone(urls), false);
  state.markDone(urls[0] as string, 4);
  assert.equal(state.shouldSkip(urls[0] as string), true);
  assert.equal(state.shouldSkip(urls[1] as string), false);
  assert.equal(state.allDone(urls), false);

  state.markDone(urls[1] as string, 0);
  assert.equal(state.allDone(urls), true);
});

test('persist writes the current date + done-map to lanes/linkedin/extract_resume.json', async () => {
  const storage = new FakeStorage();
  const state = await ResumeState.load(storage, '2026-07-21');
  state.markDone('https://example.com/a', 7);

  await state.persist(storage);

  const reloaded = await ResumeState.load(storage, '2026-07-21');
  assert.equal(reloaded.shouldSkip('https://example.com/a'), true);
});

// v0 invariant (explicit test, per plan §Task 6): a same-day
// rescanReset() must NEVER discard already-flushed captures. Flushed jobs
// are NOT ResumeState's concern — they live entirely in the caller's own
// collection. This proves ResumeState structurally cannot own/delete them:
// clearing `done` (so URLs are rescanned) leaves a caller-held "flushed
// jobs" collection completely untouched.
test('rescanReset clears done (so URLs get rescanned) but never touches a caller-held flushed-jobs collection', async () => {
  const storage = new FakeStorage();
  const state = await ResumeState.load(storage, '2026-07-21');
  const urls = [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
  ];

  // Simulate a run: each URL's capture flushes jobs into the CALLER's own
  // collection (never handed to ResumeState) and is separately marked done.
  const flushedJobs: string[] = [];
  for (const url of urls) {
    flushedJobs.push(`job-from-${url}`);
    state.markDone(url, 1);
  }

  assert.equal(state.allDone(urls), true);
  assert.equal(flushedJobs.length, 3);

  state.rescanReset();

  // done-map is cleared: every URL is eligible for rescanning again.
  for (const url of urls) {
    assert.equal(state.shouldSkip(url), false);
  }
  assert.equal(state.allDone(urls), false);

  // The caller's already-flushed captures are completely unaffected —
  // ResumeState never held a reference to them and has no way to touch
  // them.
  assert.deepEqual(flushedJobs, [
    'job-from-https://example.com/a',
    'job-from-https://example.com/b',
    'job-from-https://example.com/c',
  ]);
});
