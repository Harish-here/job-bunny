import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSoftError, SoftError } from './soft_error.ts';

test('SoftError carries scope, message, cause and name', () => {
  const cause = new Error('boom');
  const err = new SoftError('url', 'card harvest failed', { cause });
  assert.equal(err.scope, 'url');
  assert.equal(err.message, 'card harvest failed');
  assert.equal(err.name, 'SoftError');
  assert.equal(err.cause, cause);
  assert.ok(err instanceof Error);
});

test('isSoftError narrows only SoftError instances', () => {
  assert.equal(isSoftError(new SoftError('board', 'x')), true);
  assert.equal(isSoftError(new Error('x')), false);
  assert.equal(isSoftError('x'), false);
  assert.equal(isSoftError(undefined), false);
});
