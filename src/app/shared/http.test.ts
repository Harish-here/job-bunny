import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { HttpError, jsonError, readJsonBody } from './http.ts';

test('HttpError carries status, code, message', () => {
  const err = new HttpError(404, 'not_found', 'no such job');
  assert.equal(err.status, 404);
  assert.equal(err.code, 'not_found');
  assert.equal(err.message, 'no such job');
  assert.ok(err instanceof Error);
});

test('jsonError builds the structured envelope', () => {
  const res = jsonError(400, 'bad_request', 'missing field');
  assert.deepEqual(res, {
    status: 400,
    body: { error: { code: 'bad_request', message: 'missing field' } },
  });
});

function fakeRequest(chunks: string[]): import('node:http').IncomingMessage {
  return Readable.from(chunks) as unknown as import('node:http').IncomingMessage;
}

test('readJsonBody resolves parsed JSON for a valid body', async () => {
  const req = fakeRequest(['{"a":', '1}']);
  const body = await readJsonBody(req);
  assert.deepEqual(body, { a: 1 });
});

test('readJsonBody resolves undefined for an empty body', async () => {
  const req = fakeRequest([]);
  const body = await readJsonBody(req);
  assert.equal(body, undefined);
});

test('readJsonBody rejects HttpError(400, bad_json) on parse failure', async () => {
  const req = fakeRequest(['not json']);
  await assert.rejects(
    () => readJsonBody(req),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'bad_json');
      return true;
    },
  );
});

test('readJsonBody rejects HttpError(413, too_large) past the limit', async () => {
  const req = fakeRequest(['x'.repeat(20)]);
  await assert.rejects(
    () => readJsonBody(req, 10),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 413);
      assert.equal(err.code, 'too_large');
      return true;
    },
  );
});

test('readJsonBody respects the default limit of 1_048_576 bytes', async () => {
  const req = fakeRequest(['x'.repeat(1_048_577)]);
  await assert.rejects(
    () => readJsonBody(req),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 413);
      return true;
    },
  );
});
