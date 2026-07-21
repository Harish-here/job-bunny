import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Logger, RunContext } from '../../../ports/context.ts';
import {
  extractPortalGuid,
  getCareersHtml,
  getEmbedJobs,
  getPortalInfo,
  htmlToText,
  kekaBase,
} from './api.ts';

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

test('kekaBase: builds the tenant subdomain URL', () => {
  assert.equal(kekaBase('nimblelabs'), 'https://nimblelabs.keka.com');
});

test('extractPortalGuid: finds a guid embedded in an /ats/documents/ path', () => {
  const guid = extractPortalGuid(
    'https://cdn.keka.com/ats/documents/3fa85f64-5717-4562-b3fc-2c963f66afa6/logo.png',
  );
  assert.equal(guid, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
});

test('extractPortalGuid: no match → null', () => {
  assert.equal(extractPortalGuid('no guid here'), null);
  assert.equal(extractPortalGuid(null), null);
  assert.equal(extractPortalGuid(undefined), null);
});

test('getPortalInfo: 200 + valid JSON → ok, name + guid extracted', async () => {
  const portalInfo = await loadFixtureText('portal-info.json');
  let calledUrl: string | undefined;
  globalThis.fetch = (async (input: string | URL) => {
    calledUrl = String(input);
    return new Response(portalInfo, { status: 200 });
  }) as typeof fetch;

  const result = await getPortalInfo('nimblelabs', fakeCtx());
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Nimble Labs');
  assert.equal(result.guid, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(
    calledUrl,
    'https://nimblelabs.keka.com/careers/api/organization/default/careerportalinfo',
  );
});

test('getPortalInfo: 404 → ok:false', async () => {
  globalThis.fetch = (async () =>
    new Response('not found', { status: 404 })) as typeof fetch;
  const result = await getPortalInfo('nope', fakeCtx());
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('getPortalInfo: 200 but not JSON ("not a Keka tenant") → ok:false', async () => {
  globalThis.fetch = (async () =>
    new Response('<html>this is not a keka tenant</html>', {
      status: 200,
    })) as typeof fetch;
  const result = await getPortalInfo('random-domain', fakeCtx());
  assert.equal(result.ok, false);
});

test('getPortalInfo: network error propagates (rejects)', async () => {
  globalThis.fetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND nope.keka.com');
  }) as typeof fetch;
  await assert.rejects(() => getPortalInfo('nope', fakeCtx()));
});

test('getCareersHtml: 200 → returns body text', async () => {
  const html = await loadFixtureText('careers.html');
  globalThis.fetch = (async () => new Response(html, { status: 200 })) as typeof fetch;
  const result = await getCareersHtml('nimblelabs', fakeCtx());
  assert.equal(result, html);
});

test('getCareersHtml: non-2xx → null', async () => {
  globalThis.fetch = (async () => new Response('gone', { status: 404 })) as typeof fetch;
  const result = await getCareersHtml('nimblelabs', fakeCtx());
  assert.equal(result, null);
});

test('getEmbedJobs: valid array envelope → returns raw jobs', async () => {
  const jobs = await loadFixtureJson('embedjobs-response.json');
  let calledUrl: string | undefined;
  globalThis.fetch = (async (input: string | URL) => {
    calledUrl = String(input);
    return new Response(JSON.stringify(jobs), { status: 200 });
  }) as typeof fetch;

  const guid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const result = await getEmbedJobs('nimblelabs', guid, fakeCtx());
  assert.equal(result.length, 3);
  assert.equal(
    calledUrl,
    `https://nimblelabs.keka.com/careers/api/embedjobs/default/active/${guid}`,
  );
});

test('getEmbedJobs: HTTP error → throws', async () => {
  globalThis.fetch = (async () =>
    new Response('server error', { status: 500 })) as typeof fetch;
  await assert.rejects(() => getEmbedJobs('nimblelabs', 'guid', fakeCtx()), /HTTP 500/);
});

test('getEmbedJobs: malformed envelope (not an array) → throws', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ jobs: [] }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    () => getEmbedJobs('nimblelabs', 'guid', fakeCtx()),
    /invalid embedjobs response/,
  );
});

test('htmlToText: decodes entities then strips tags', () => {
  const text = htmlToText(
    '&lt;p&gt;Own paid acquisition &amp;amp; lifecycle campaigns.&lt;/p&gt;',
  );
  assert.equal(text, 'Own paid acquisition & lifecycle campaigns.');
});

test('htmlToText: null/undefined → empty string', () => {
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});
