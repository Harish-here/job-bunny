import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { BOARDS_API, getBoardInfo, getBoardJobs, htmlToText } from './api.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${FIXTURES}${name}`, 'utf8'));
}

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

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('getBoardInfo: 200 + valid body → ok with name', async () => {
  const boardInfo = await loadFixture('board-info.json');
  let calledUrl: string | undefined;
  globalThis.fetch = (async (input: string | URL) => {
    calledUrl = String(input);
    return new Response(JSON.stringify(boardInfo), { status: 200 });
  }) as typeof fetch;

  const result = await getBoardInfo('acmerobotics', fakeCtx());
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.name, 'Acme Robotics');
  assert.equal(calledUrl, `${BOARDS_API}/acmerobotics`);
});

test('getBoardInfo: 404 → ok:false', async () => {
  globalThis.fetch = (async () =>
    new Response('not found', { status: 404 })) as typeof fetch;

  const result = await getBoardInfo('nope', fakeCtx());
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('getBoardInfo: malformed JSON body → ok:false', async () => {
  globalThis.fetch = (async () =>
    new Response('not json{{{', { status: 200 })) as typeof fetch;

  const result = await getBoardInfo('weird', fakeCtx());
  assert.equal(result.ok, false);
});

test('getBoardInfo: network error propagates (rejects)', async () => {
  globalThis.fetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND boards-api.greenhouse.io');
  }) as typeof fetch;

  await assert.rejects(() => getBoardInfo('acmerobotics', fakeCtx()));
});

test('getBoardJobs: valid envelope → returns raw jobs array', async () => {
  const jobsResponse = await loadFixture('jobs-response.json');
  let calledUrl: string | undefined;
  globalThis.fetch = (async (input: string | URL) => {
    calledUrl = String(input);
    return new Response(JSON.stringify(jobsResponse), { status: 200 });
  }) as typeof fetch;

  const jobs = await getBoardJobs('acmerobotics', fakeCtx());
  assert.equal(jobs.length, 3);
  assert.equal(calledUrl, `${BOARDS_API}/acmerobotics/jobs?content=true`);
});

test('getBoardJobs: HTTP error → throws', async () => {
  globalThis.fetch = (async () =>
    new Response('server error', { status: 500 })) as typeof fetch;
  await assert.rejects(() => getBoardJobs('acmerobotics', fakeCtx()), /HTTP 500/);
});

test('getBoardJobs: malformed envelope (no jobs array) → throws', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ notJobs: true }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    () => getBoardJobs('acmerobotics', fakeCtx()),
    /invalid jobs response/,
  );
});

test('htmlToText: decodes entities then strips tags', () => {
  // "&amp;amp;" is itself entity-escaped ("&amp;" escaping "&amp;") — the
  // first decode pass unmasks it to the literal text "&amp;", the second
  // decode pass (after tag-stripping) resolves that down to a plain "&",
  // matching v0's two-pass htmlToText contract.
  const text = htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;');
  assert.equal(text, 'Hello & welcome');
});

test('htmlToText: null/undefined → empty string', () => {
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});
