import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disposeWhenSettled } from './dispose_when_settled.ts';

test('closes the browser when the losing attempt resolves later', async () => {
  let closed = 0;
  let resolve!: (b: { close(): Promise<void> }) => void;
  const task = new Promise<{ close(): Promise<void> }>((r) => {
    resolve = r;
  });
  disposeWhenSettled(task);
  assert.equal(closed, 0);
  resolve({
    close: async () => {
      closed += 1;
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, 1);
});

test('swallows a rejected attempt and a failing close()', async () => {
  disposeWhenSettled(Promise.reject(new Error('connect failed')));
  disposeWhenSettled(
    Promise.resolve({
      close: async () => {
        throw new Error('close failed');
      },
    }),
  );
  await new Promise((r) => setImmediate(r));
  // reaching here without an unhandled rejection is the assertion
  assert.ok(true);
});
