import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companyKey, normalizeToken } from './normalize.ts';

test('normalizeToken folds case, hyphens, spaces and punctuation', () => {
  assert.equal(normalizeToken('Front-End'), 'frontend');
  assert.equal(normalizeToken('  Full Stack '), 'fullstack');
  assert.equal(normalizeToken('UI/UX'), 'uiux');
  assert.equal(normalizeToken('Node.js'), 'nodejs');
});

test('companyKey drops legal suffixes and hyphenates', () => {
  assert.equal(companyKey('Acme Corp Pvt Ltd'), 'acme-corp');
  assert.equal(companyKey('Groww'), 'groww');
  assert.equal(companyKey('Stripe, Inc.'), 'stripe');
  assert.equal(companyKey('Bosch GmbH'), 'bosch');
});

test('companyKey never strips a single-word name', () => {
  assert.equal(companyKey('Ltd'), 'ltd');
});
