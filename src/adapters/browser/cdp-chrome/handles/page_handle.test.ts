import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger, RunContext } from '../../../../ports/context.ts';
import type { CdpPage } from '../provider.ts';
import { CdpChromePageHandle } from './page_handle.ts';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(signal: AbortSignal = new AbortController().signal): RunContext {
  return { profile: 'rajni', signal, logger: noopLogger, beat() {} };
}

/** A fake page whose method behavior is fully controlled per-test — either
 * resolves immediately with a value, or hangs forever (never settles) to
 * exercise the deadline race. */
function fakePage(overrides: Partial<CdpPage> = {}): CdpPage {
  return {
    goto: async () => undefined,
    evaluate: async () => undefined as never,
    click: async () => undefined,
    waitForSelector: async () => undefined,
    content: async () => '',
    close: async () => undefined,
    ...overrides,
  };
}

function hang<T>(): () => Promise<T> {
  return () => new Promise<T>(() => {});
}

/** hang(), specialized for CdpPage.evaluate's generic signature. */
const hangEvaluate: CdpPage['evaluate'] = () => new Promise(() => {});

test('PageHandle.evaluate rejects at ~timeoutMs when the underlying playwright call hangs forever', async () => {
  const page = new CdpChromePageHandle(fakePage({ evaluate: hangEvaluate }), fakeCtx());

  const start = Date.now();
  await assert.rejects(() => page.evaluate('1 + 1', { timeoutMs: 40 }), /timed out/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `expected rejection near 40ms, took ${elapsed}ms`);
});

test('PageHandle.goto passes through a resolving playwright call without waiting for the deadline', async () => {
  const page = new CdpChromePageHandle(fakePage(), fakeCtx());

  const start = Date.now();
  await page.goto('https://example.com', { timeoutMs: 5000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `expected near-instant pass-through, took ${elapsed}ms`);
});

test('PageHandle.click rejects at ~timeoutMs when the underlying playwright call hangs forever', async () => {
  const page = new CdpChromePageHandle(fakePage({ click: hang() }), fakeCtx());

  await assert.rejects(
    () => page.click('.job-card', { timeoutMs: 30 }),
    /click\(\.job-card\) timed out/,
  );
});

test('PageHandle.waitFor rejects at ~timeoutMs when the underlying playwright call hangs forever', async () => {
  const page = new CdpChromePageHandle(fakePage({ waitForSelector: hang() }), fakeCtx());

  await assert.rejects(
    () => page.waitFor('#job-details', { timeoutMs: 30 }),
    /timed out/,
  );
});

test('PageHandle.content rejects at ~timeoutMs when the underlying playwright call hangs forever', async () => {
  const page = new CdpChromePageHandle(fakePage({ content: hang() }), fakeCtx());

  await assert.rejects(() => page.content({ timeoutMs: 30 }), /timed out/);
});

test('PageHandle deadline also fires when ctx.signal aborts before opts.timeoutMs', async () => {
  const controller = new AbortController();
  const page = new CdpChromePageHandle(
    fakePage({ evaluate: hangEvaluate }),
    fakeCtx(controller.signal),
  );

  const pending = assert.rejects(
    () => page.evaluate('1', { timeoutMs: 60_000 }),
    /timed out/,
  );
  controller.abort(new Error('run cancelled'));
  await pending;
});

test('PageHandle.close() closes the underlying playwright page directly (no deadline race)', async () => {
  let closed = false;
  const page = new CdpChromePageHandle(
    fakePage({
      close: async () => {
        closed = true;
      },
    }),
    fakeCtx(),
  );
  await page.close();

  assert.equal(closed, true);
});
