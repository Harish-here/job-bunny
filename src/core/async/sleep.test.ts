import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sleep } from './sleep.ts';

test('sleep: resolves after roughly ms elapses when the signal never aborts', async () => {
  const controller = new AbortController();
  const start = Date.now();
  await sleep(20, controller.signal);
  assert.ok(Date.now() - start >= 15, 'should not resolve before the timer fires');
});

test('sleep: an already-aborted signal rejects immediately with signal.reason, never waiting ms', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const start = Date.now();
  await assert.rejects(() => sleep(5_000, controller.signal), /cancelled/);
  assert.ok(
    Date.now() - start < 200,
    'must reject immediately, not after the 5s delay — an aborted run must never sit in this sleep',
  );
});

test('sleep: aborting mid-wait rejects promptly (does not hang until ms elapses)', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const pending = sleep(5_000, controller.signal);
  setTimeout(() => controller.abort(new Error('cancelled mid-wait')), 10);
  await assert.rejects(() => pending, /cancelled mid-wait/);
  assert.ok(Date.now() - start < 500, 'abort mid-wait must not wait out the full delay');
});

test('sleep: an abort with no explicit reason still rejects (falls back to a generic Error)', async () => {
  const controller = new AbortController();
  const pending = sleep(5_000, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(() => pending);
});
