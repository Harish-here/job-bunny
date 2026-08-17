import assert from 'node:assert/strict';
import { test } from 'node:test';
import { raceWithTimeout } from './race_with_timeout.ts';

test('raceWithTimeout resolves with the task result when it settles before the timeout', async () => {
  const result = await raceWithTimeout(Promise.resolve('ok'), 1000);
  assert.equal(result, 'ok');
});

test('raceWithTimeout rejects once ms elapses, naming the exceeded budget', async () => {
  const hung = new Promise<never>(() => {
    // never settles
  });
  await assert.rejects(raceWithTimeout(hung, 5), /connect attempt exceeded 5ms/);
});

test('raceWithTimeout propagates the task rejection when the task fails before the timeout', async () => {
  await assert.rejects(
    raceWithTimeout(Promise.reject(new Error('task failed')), 1000),
    /task failed/,
  );
});

test('raceWithTimeout clamps a negative ms to 0 rather than throwing', async () => {
  const hung = new Promise<never>(() => {
    // never settles
  });
  await assert.rejects(raceWithTimeout(hung, -5), /connect attempt exceeded 0ms/);
});
