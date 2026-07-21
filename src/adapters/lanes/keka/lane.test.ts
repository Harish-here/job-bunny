import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JDSchema } from '../../../core/jd/index.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { candidateTokens, KekaLane, verifyBoardName } from './lane.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function loadFixtureText(name: string): Promise<string> {
  return readFile(`${FIXTURES}${name}`, 'utf8');
}
async function loadFixtureJson(name: string): Promise<unknown> {
  return JSON.parse(await loadFixtureText(name));
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

test('candidateTokens: squashed/hyphenated/raw-squashed guesses, hostname-filtered', () => {
  assert.deepEqual(candidateTokens('Nimble Labs Pvt Ltd'), [
    'nimblelabs',
    'nimble-labs',
    'nimblelabspvtltd',
  ]);
});

test('candidateTokens: drops guesses illegal in a hostname label', () => {
  // A raw name containing e.g. an underscore would otherwise squash to an
  // invalid hostname label — companyKey already strips non-alnum, so this
  // mainly guards the raw-squashed guess and any future edge case.
  for (const token of candidateTokens('Acme & Sons_Co')) {
    assert.match(token, /^[a-z0-9-]+$/);
  }
});

test('verifyBoardName: exact + containment match after normalization', () => {
  assert.equal(verifyBoardName('Nimble Labs', 'Nimble Labs Pvt Ltd'), true);
  assert.equal(verifyBoardName('Nimble Labs', 'Totally Different Co'), false);
  assert.equal(verifyBoardName('Nimble Labs', undefined), false);
});

test('probe: 200 + name match on first candidate → found', async () => {
  const portalInfo = await loadFixtureText('portal-info.json'); // name: "Nimble Labs"
  const calledUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calledUrls.push(String(input));
    return new Response(portalInfo, { status: 200 });
  }) as typeof fetch;

  const lane = new KekaLane();
  const result = await lane.probe('Nimble Labs', fakeCtx());
  assert.deepEqual(result, { status: 'found', boardRef: 'nimblelabs' });
  assert.equal(
    calledUrls[0],
    'https://nimblelabs.keka.com/careers/api/organization/default/careerportalinfo',
  );
});

test('probe: 404 for every candidate → not-found', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
  const lane = new KekaLane();
  const result = await lane.probe('Totally Unlisted Co', fakeCtx());
  assert.deepEqual(result, { status: 'not-found' });
});

test('probe: 410 for every candidate → not-found', async () => {
  globalThis.fetch = (async () => new Response('gone', { status: 410 })) as typeof fetch;
  const lane = new KekaLane();
  const result = await lane.probe('Totally Unlisted Co', fakeCtx());
  assert.deepEqual(result, { status: 'not-found' });
});

test('probe: 429 for every candidate → error, not not-found (rate-limited, not absent)', async () => {
  globalThis.fetch = (async () =>
    new Response('slow down', { status: 429 })) as typeof fetch;
  const lane = new KekaLane();
  const result = await lane.probe('Nimble Labs', fakeCtx());
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.message, /HTTP 429/);
});

test('probe: 503 for every candidate → error, not not-found (server trouble, not absent)', async () => {
  globalThis.fetch = (async () =>
    new Response('unavailable', { status: 503 })) as typeof fetch;
  const lane = new KekaLane();
  const result = await lane.probe('Nimble Labs', fakeCtx());
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.message, /HTTP 503/);
});

test('probe: aborted ctx.signal propagates instead of being folded into an error/not-found probe result', async () => {
  const controller = new AbortController();
  globalThis.fetch = (async () => {
    controller.abort(new Error('run cancelled'));
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }) as typeof fetch;

  const lane = new KekaLane();
  const ctx: RunContext = { ...fakeCtx(), signal: controller.signal };
  await assert.rejects(() => lane.probe('Nimble Labs', ctx));
});

test('probe: not valid JSON ("not a Keka tenant") for every candidate → not-found', async () => {
  globalThis.fetch = (async () =>
    new Response('<html></html>', { status: 200 })) as typeof fetch;
  const lane = new KekaLane();
  const result = await lane.probe('Nimble Labs', fakeCtx());
  assert.deepEqual(result, { status: 'not-found' });
});

test('probe: fetch throws for every candidate → error', async () => {
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  const lane = new KekaLane();
  const result = await lane.probe('Nimble Labs', fakeCtx());
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.message, /network down/);
});

test('probe: 200 but name mismatch on every candidate → not-found', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ name: 'Completely Unrelated Inc' }), {
      status: 200,
    })) as typeof fetch;
  const lane = new KekaLane();
  const result = await lane.probe('Nimble Labs', fakeCtx());
  assert.deepEqual(result, { status: 'not-found' });
});

function fetchStub(portalInfo: string, embedJobs: unknown, careersHtml: string) {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/embedjobs/default/active/')) {
      return new Response(JSON.stringify(embedJobs), { status: 200 });
    }
    if (url.endsWith('/careerportalinfo')) {
      return new Response(portalInfo, { status: 200 });
    }
    if (url.endsWith('/careers/')) {
      return new Response(careersHtml, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

test('fetchBoard: fixture jobs → valid JDs, kk- ids, malformed job skipped', async () => {
  const portalInfo = await loadFixtureText('portal-info.json');
  const embedJobs = await loadFixtureJson('embedjobs-response.json');
  const careersHtml = await loadFixtureText('careers.html');
  globalThis.fetch = fetchStub(portalInfo, embedJobs, careersHtml);

  const lane = new KekaLane();
  const jds = await lane.fetchBoard('nimblelabs', fakeCtx());

  // fixture has 3 raw jobs, one with an empty title (KekaJobSchema-invalid) — dropped.
  assert.equal(jds.length, 2);
  for (const jd of jds) {
    JDSchema.parse(jd); // re-validates without throwing
    assert.match(jd.identity.id, /^kk-/);
    assert.equal(jd.identity.lane, 'keka');
    assert.equal(jd.identity.company, 'Nimble Labs');
    assert.ok(jd.content?.rawText.length);
  }
  assert.equal(jds[0]?.identity.id, 'kk-8891');
  assert.equal(
    jds[0]?.identity.url,
    'https://nimblelabs.keka.com/careers/jobdetails/8891',
  );
  assert.ok(jds[0]?.content?.rawText.startsWith('Experience: 3-5 years.'));
  assert.ok(jds[0]?.content?.rawText.includes('Design delightful experiences'));
  // no `experience` field on the second job → no prefix
  assert.ok(jds[1]?.content?.rawText.startsWith('Own paid acquisition'));
});

test('fetchBoard: portal-info has no guid → falls back to scraping /careers/ HTML', async () => {
  const portalInfoNoGuid = JSON.stringify({ name: 'Nimble Labs' }); // no /ats/documents/ path
  const embedJobs = await loadFixtureJson('embedjobs-response.json');
  const careersHtml = await loadFixtureText('careers.html');
  globalThis.fetch = fetchStub(portalInfoNoGuid, embedJobs, careersHtml);

  const lane = new KekaLane();
  const jds = await lane.fetchBoard('nimblelabs', fakeCtx());
  assert.equal(jds.length, 2);
});

test('fetchBoard: no guid found anywhere → throws', async () => {
  const portalInfoNoGuid = JSON.stringify({ name: 'Nimble Labs' });
  globalThis.fetch = fetchStub(portalInfoNoGuid, [], '<html>no guid here</html>');

  const lane = new KekaLane();
  await assert.rejects(
    () => lane.fetchBoard('nimblelabs', fakeCtx()),
    /no portal guid found/,
  );
});

test('fetchBoard: portal-info name lookup fails → falls back to boardRef as company', async () => {
  const embedJobs = await loadFixtureJson('embedjobs-response.json');
  const careersHtml = await loadFixtureText('careers.html');
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/embedjobs/default/active/')) {
      return new Response(JSON.stringify(embedJobs), { status: 200 });
    }
    if (url.endsWith('/careerportalinfo')) {
      return new Response('not found', { status: 404 });
    }
    if (url.endsWith('/careers/')) {
      return new Response(careersHtml, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const lane = new KekaLane();
  const jds = await lane.fetchBoard('nimblelabs', fakeCtx());
  assert.equal(jds.length, 2);
  assert.equal(jds[0]?.identity.company, 'nimblelabs');
});

test('fetchBoard: whole-board embedjobs failure throws (caller/source-stage turns it into a SoftError)', async () => {
  const portalInfo = await loadFixtureText('portal-info.json');
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/embedjobs/default/active/')) {
      return new Response('server error', { status: 500 });
    }
    return new Response(portalInfo, { status: 200 });
  }) as typeof fetch;

  const lane = new KekaLane();
  await assert.rejects(() => lane.fetchBoard('nimblelabs', fakeCtx()));
});
