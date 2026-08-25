import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeToken } from './index.ts';

test('normalizeToken folds case, hyphens, spaces and punctuation', () => {
  assert.equal(normalizeToken('Front-End'), 'frontend');
  assert.equal(normalizeToken('  Full Stack '), 'fullstack');
  assert.equal(normalizeToken('UI/UX'), 'uiux');
  assert.equal(normalizeToken('Node.js'), 'nodejs');
});
