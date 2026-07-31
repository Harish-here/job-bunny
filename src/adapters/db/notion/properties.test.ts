import assert from 'node:assert/strict';
import { test } from 'node:test';
import { propDateStart, propSelectName, propText, propUrl } from './properties.ts';

test('propText: joins multiple title parts into one string', () => {
  const value = { title: [{ plain_text: 'Staff ' }, { plain_text: 'Engineer' }] };
  assert.equal(propText(value), 'Staff Engineer');
});

test("propText: prefers title over rich_text, and returns '' for neither", () => {
  const withBoth = {
    title: [{ plain_text: 'Title Wins' }],
    rich_text: [{ plain_text: 'Ignored' }],
  };
  assert.equal(propText(withBoth), 'Title Wins');
  assert.equal(propText({}), '');
  assert.equal(propText(undefined), '');
});

test('propSelectName / propDateStart: null when the property is absent', () => {
  assert.equal(propSelectName(undefined), null);
  assert.equal(propSelectName({}), null);
  assert.equal(propDateStart(undefined), null);
  assert.equal(propDateStart({}), null);
});

test('propUrl: passes the raw url value through unchanged', () => {
  assert.equal(propUrl({ url: 'https://example.com/job' }), 'https://example.com/job');
  assert.equal(propUrl({ url: null }), null);
  assert.equal(propUrl(undefined), null);
});
