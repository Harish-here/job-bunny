/**
 * static.test.ts (local-DB spec PR 4, Task 6) — pure tests over a temp
 * `uiDir`, no sockets involved.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { serveStatic } from './static.ts';

async function withUiDir(fn: (uiDir: string) => Promise<void>) {
  const uiDir = await mkdtemp(path.join(tmpdir(), 'jobbunny-uidir-'));
  try {
    await fn(uiDir);
  } finally {
    await rm(uiDir, { recursive: true, force: true });
  }
}

test('serves index.html at /', async () => {
  await withUiDir(async (uiDir) => {
    await writeFile(path.join(uiDir, 'index.html'), '<html>board</html>');
    const res = await serveStatic(uiDir, '/');
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'text/html; charset=utf-8');
    assert.equal(String(res.body), '<html>board</html>');
  });
});

test('traversal is refused — never returns a file escaped to a dedicated outside dir', async () => {
  await withUiDir(async (uiDir) => {
    // A dedicated temp dir of its OWN — never a shared ancestor of uiDir
    // (dirname(dirname(uiDir)) collapses to '/' on Linux, where tmpdir()
    // is '/tmp', which would make this test write to and delete the
    // host's real /etc). This dir is the actual escape target the guard
    // must block, and it's cleaned up on its own.
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'jobbunny-outside-'));
    try {
      const secretFile = path.join(outsideDir, 'passwd');
      await writeFile(secretFile, 'root:x:0:0:secret-sauce');

      // Derive the traversal string from the real relative path between
      // uiDir and the secret file, rather than assuming a fixed '../../'
      // depth — this keeps the test correct regardless of how deep the
      // OS's tmpdir() happens to be.
      const traversalPath = path.relative(uiDir, secretFile);
      assert.ok(
        traversalPath.startsWith('..'),
        'sanity: this must be a real escape attempt',
      );

      // No index.html in uiDir, so the fallback path is the no-UI page —
      // proving the secret contents never made it into the response.
      const res = await serveStatic(uiDir, traversalPath);
      assert.equal(res.status, 200);
      assert.equal(res.contentType, 'text/plain; charset=utf-8');
      const body = String(res.body ?? '');
      assert.ok(
        !body.includes('secret-sauce'),
        'must not leak the escaped file contents',
      );
      assert.match(body, /npm run ui:build/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('.js content-type', async () => {
  await withUiDir(async (uiDir) => {
    await writeFile(path.join(uiDir, 'app.js'), 'console.log(1)');
    const res = await serveStatic(uiDir, '/app.js');
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'text/javascript; charset=utf-8');
  });
});

test('missing uiDir falls back to the no-UI page', async () => {
  const missing = path.join(tmpdir(), 'jobbunny-uidir-does-not-exist');
  const res = await serveStatic(missing, '/');
  assert.equal(res.status, 200);
  assert.equal(res.contentType, 'text/plain; charset=utf-8');
  assert.match(String(res.body ?? ''), /npm run ui:build/);
});

test('uiDir undefined always serves the no-UI page', async () => {
  const res = await serveStatic(undefined, '/');
  assert.equal(res.status, 200);
  assert.equal(res.contentType, 'text/plain; charset=utf-8');
  assert.equal(
    res.body,
    'Job Bunny board API is running. UI not built yet — run: npm run ui:build. ' +
      'API: GET /api/profiles',
  );
});

test('missing file with an existing index.html falls back to the SPA shell', async () => {
  await withUiDir(async (uiDir) => {
    await writeFile(path.join(uiDir, 'index.html'), '<html>spa</html>');
    const res = await serveStatic(uiDir, '/some/deep/route');
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'text/html; charset=utf-8');
    assert.equal(String(res.body), '<html>spa</html>');
  });
});
