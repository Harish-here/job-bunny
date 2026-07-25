import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botTokenCheck } from './check.ts';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

test('botTokenCheck: red when TELEGRAM_BOT_TOKEN is absent', async () => {
  const check = botTokenCheck({ env: {} });
  const finding = await check.run();
  assert.equal(check.name, 'telegram-bot-token');
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /TELEGRAM_BOT_TOKEN not set/);
});

test('botTokenCheck: red when TELEGRAM_BOT_TOKEN is an empty string', async () => {
  const check = botTokenCheck({ env: { TELEGRAM_BOT_TOKEN: '' } });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('botTokenCheck: ok on a 200 with { ok: true }', async () => {
  const check = botTokenCheck({
    env: { TELEGRAM_BOT_TOKEN: 'good-token' },
    fetchFn: fakeFetch(200, { ok: true, result: { id: 1 } }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('botTokenCheck: red on a 401 auth failure', async () => {
  const check = botTokenCheck({
    env: { TELEGRAM_BOT_TOKEN: 'bad-token' },
    fetchFn: fakeFetch(401, { ok: false, error_code: 401 }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /rejected by Telegram/);
});

test('botTokenCheck: red on a 403 auth failure', async () => {
  const check = botTokenCheck({
    env: { TELEGRAM_BOT_TOKEN: 'bad-token' },
    fetchFn: fakeFetch(403, { ok: false }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('botTokenCheck: red on a 200 body with ok:false', async () => {
  const check = botTokenCheck({
    env: { TELEGRAM_BOT_TOKEN: 'bad-token' },
    fetchFn: fakeFetch(200, { ok: false }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('botTokenCheck: warn when fetch throws (network error)', async () => {
  const check = botTokenCheck({
    env: { TELEGRAM_BOT_TOKEN: 'some-token' },
    fetchFn: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /could not reach Telegram/);
});

test('botTokenCheck: never throws even on unexpected input', async () => {
  const check = botTokenCheck({
    env: { TELEGRAM_BOT_TOKEN: 'some-token' },
    fetchFn: fakeFetch(500, 'not json body wrapped anyway'),
  });
  await assert.doesNotReject(() => check.run());
});
