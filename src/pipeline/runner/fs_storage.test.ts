import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { FsStorage } from './fs_storage.ts';

const PayloadSchema = z.object({ hello: z.string() });

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-fs-storage-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
function freshStorage(): { storage: FsStorage; dir: string } {
  counter += 1;
  return { storage: new FsStorage(root), dir: `case-${counter}` };
}

beforeEach(() => {});

test('round-trip write/read', async () => {
  const { storage, dir } = freshStorage();
  const relPath = `${dir}/thing.json`;
  await storage.writeJson(relPath, { hello: 'world' });
  const result = await storage.readJson(relPath, PayloadSchema);
  assert.deepEqual(result, { hello: 'world' });
});

test('missing file returns undefined', async () => {
  const { storage, dir } = freshStorage();
  const result = await storage.readJson(`${dir}/nope.json`, PayloadSchema);
  assert.equal(result, undefined);
});

test('schema mismatch throws ZodError', async () => {
  const { storage, dir } = freshStorage();
  const relPath = `${dir}/bad.json`;
  await storage.writeJson(relPath, { hello: 42 });
  await assert.rejects(
    () => storage.readJson(relPath, PayloadSchema),
    (err: unknown) => err instanceof z.ZodError,
  );
});

test('nested relPath creates parent dirs', async () => {
  const { storage, dir } = freshStorage();
  const relPath = `${dir}/deeply/nested/path/thing.json`;
  await storage.writeJson(relPath, { hello: 'nested' });
  const result = await storage.readJson(relPath, PayloadSchema);
  assert.deepEqual(result, { hello: 'nested' });
});

test('pretty-prints with 2-space indent', async () => {
  const { storage, dir } = freshStorage();
  const relPath = `${dir}/pretty.json`;
  await storage.writeJson(relPath, { hello: 'pretty' });
  const raw = await (await import('node:fs/promises')).readFile(
    join(root, relPath),
    'utf8',
  );
  assert.equal(raw, `${JSON.stringify({ hello: 'pretty' }, null, 2)}\n`);
});

test('.tmp file is never left behind after a successful write', async () => {
  const { storage, dir } = freshStorage();
  const relPath = `${dir}/clean.json`;
  await storage.writeJson(relPath, { hello: 'clean' });
  const entries = await readdir(join(root, dir));
  assert.deepEqual(entries, ['clean.json']);
  await assert.rejects(() => stat(join(root, relPath) + '.tmp'));
});
