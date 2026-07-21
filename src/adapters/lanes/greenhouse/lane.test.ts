import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JDSchema } from '../../../core/jd/index.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { BOARDS_API } from './api.ts';
import { candidateTokens, GreenhouseLane, verifyBoardName } from './lane.ts';

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

test('candidateTokens: squashed, hyphenated, raw-squashed guesses', () => {
  assert.deepEqual(candidateTokens('Acme Robotics Pvt Ltd'), [
    'acmerobotics',
    'acme-robotics',
    'acmeroboticspvtltd',
  ]);
});

test('verifyBoardName: exact + containment match after normalization', () => {
  assert.equal(verifyBoardName('Acme Robotics', 'Acme Robotics Pvt Ltd'), true);
  assert.equal(verifyBoardName('Acme Robotics', 'Totally Different Co'), false);
  assert.equal(verifyBoardName('Acme Robotics', undefined), false);
});

test('probe: 200 + name match on first candidate → found', async () => {
  const boardInfo = await loadFixture('board-info.json'); // name: "Acme Robotics"
  const calledUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calledUrls.push(String(input));
    return new Response(JSON.stringify(boardInfo), { status: 200 });
  }) as typeof fetch;

  const lane = new GreenhouseLane();
  const result = await lane.probe('Acme Robotics', fakeCtx());
  assert.deepEqual(result, { status: 'found', boardRef: 'acmerobotics' });
  assert.equal(calledUrls[0], `${BOARDS_API}/acmerobotics`);
});

test('probe: 404 for every candidate → not-found', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;

  const lane = new GreenhouseLane();
  const result = await lane.probe('Totally Unlisted Co', fakeCtx());
  assert.deepEqual(result, { status: 'not-found' });
});

test('probe: fetch throws for every candidate → error', async () => {
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  const lane = new GreenhouseLane();
  const result = await lane.probe('Acme Robotics', fakeCtx());
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.message, /network down/);
});

test('probe: 200 but name mismatch on every candidate → not-found', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ name: 'Completely Unrelated Inc' }), {
      status: 200,
    })) as typeof fetch;

  const lane = new GreenhouseLane();
  const result = await lane.probe('Acme Robotics', fakeCtx());
  assert.deepEqual(result, { status: 'not-found' });
});

test('fetchBoard: fixture jobs → valid JDs, gh- ids, malformed job skipped', async () => {
  const boardInfo = await loadFixture('board-info.json');
  const jobsResponse = await loadFixture('jobs-response.json');

  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/jobs?content=true')) {
      return new Response(JSON.stringify(jobsResponse), { status: 200 });
    }
    return new Response(JSON.stringify(boardInfo), { status: 200 });
  }) as typeof fetch;

  const lane = new GreenhouseLane();
  const jds = await lane.fetchBoard('acmerobotics', fakeCtx());

  // fixture has 3 raw jobs, one with an empty title (JDSchema-invalid) — dropped.
  assert.equal(jds.length, 2);
  for (const jd of jds) {
    JDSchema.parse(jd); // re-validates without throwing
    assert.match(jd.identity.id, /^gh-/);
    assert.equal(jd.identity.lane, 'greenhouse');
    assert.equal(jd.identity.company, 'Acme Robotics');
    assert.ok(jd.content?.rawText.length);
  }
  assert.equal(jds[0]?.identity.id, 'gh-5738292');
  assert.equal(jds[0]?.identity.postedAt, '2026-07-15');
  assert.ok(jds[0]?.content?.rawText.includes('Senior Backend Engineer'));
});

test('fetchBoard: board-info lookup failing falls back to boardRef as company', async () => {
  const jobsResponse = await loadFixture('jobs-response.json');

  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/jobs?content=true')) {
      return new Response(JSON.stringify(jobsResponse), { status: 200 });
    }
    return new Response('server error', { status: 500 });
  }) as typeof fetch;

  const lane = new GreenhouseLane();
  const jds = await lane.fetchBoard('acmerobotics', fakeCtx());
  assert.equal(jds.length, 2);
  assert.equal(jds[0]?.identity.company, 'acmerobotics');
});

test('fetchBoard: whole-board fetch failure throws (caller/source-stage turns it into a SoftError)', async () => {
  globalThis.fetch = (async () =>
    new Response('server error', { status: 500 })) as typeof fetch;

  const lane = new GreenhouseLane();
  await assert.rejects(() => lane.fetchBoard('acmerobotics', fakeCtx()));
});
