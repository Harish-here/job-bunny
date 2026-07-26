/**
 * telegram.test.ts — TDD for TelegramNotifier. Always stubs `globalThis.fetch`
 * (restored after each test); never a real network call.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { NotifyEvent } from '../../../ports/notifier.ts';
import { TelegramNotifier, TelegramNotifierSettingsSchema } from './telegram.ts';

const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

function digestEvent(text = 'hello'): NotifyEvent {
  return { kind: 'digest', profile: 'rajni', text };
}

test('constructor: throws when chatId is missing', () => {
  assert.throws(() => new TelegramNotifier({}));
});

test('constructor: throws when chatId is not a number', () => {
  assert.throws(() => new TelegramNotifier({ chatId: 'not-a-number' }));
});

test('TelegramNotifierSettingsSchema: parses a valid settings bag', () => {
  assert.deepEqual(TelegramNotifierSettingsSchema.parse({ chatId: 123 }), {
    chatId: 123,
  });
});

test('name is "telegram"', () => {
  const notifier = new TelegramNotifier({ chatId: 123 });
  assert.equal(notifier.name, 'telegram');
});

test('send: throws a clear error when TELEGRAM_BOT_TOKEN is not set', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  const notifier = new TelegramNotifier({ chatId: 123 });
  await assert.rejects(() => notifier.send(digestEvent()), /TELEGRAM_BOT_TOKEN/);
});

test('send: POSTs to the correct bot endpoint with chat_id and text from settings/event', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  let seenUrl: string | undefined;
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seenUrl = url;
    seenInit = init;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const notifier = new TelegramNotifier({ chatId: 987654321 });
  await notifier.send(digestEvent('digest body'));

  assert.equal(seenUrl, 'https://api.telegram.org/bottest-token/sendMessage');
  assert.equal(seenInit?.method, 'POST');
  const body = JSON.parse(String(seenInit?.body));
  assert.deepEqual(body, { chat_id: 987654321, text: 'digest body' });
});

test('send: a non-2xx response throws, including the status', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  globalThis.fetch = (async () =>
    new Response('bad request', { status: 400 })) as typeof fetch;

  const notifier = new TelegramNotifier({ chatId: 123 });
  await assert.rejects(() => notifier.send(digestEvent()), /400/);
});

test('send: a 200 response resolves without throwing', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  const notifier = new TelegramNotifier({ chatId: 123 });
  await assert.doesNotReject(() => notifier.send(digestEvent()));
});

test('send: passes an AbortSignal so a hung request cannot stall the process forever', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    seenInit = init;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const notifier = new TelegramNotifier({ chatId: 123 });
  await notifier.send(digestEvent());

  assert.ok(seenInit?.signal instanceof AbortSignal, 'fetch must receive an AbortSignal');
  assert.equal(seenInit?.signal?.aborted, false);
});
