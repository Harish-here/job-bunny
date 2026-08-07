import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasEnvValue, upsertEnvLine } from './env_file.ts';

// --- hasEnvValue ---

test('hasEnvValue: a plain assignment is present', () => {
  assert.equal(hasEnvValue('NOTION_TOKEN=abc123\n', 'NOTION_TOKEN'), true);
});

test('hasEnvValue: an empty value is absent', () => {
  assert.equal(hasEnvValue('NOTION_TOKEN=\n', 'NOTION_TOKEN'), false);
});

test('hasEnvValue: a whitespace-only value is absent', () => {
  assert.equal(hasEnvValue('NOTION_TOKEN=   \n', 'NOTION_TOKEN'), false);
});

test('hasEnvValue: quoted values are present and the quotes are not counted', () => {
  assert.equal(hasEnvValue('NOTION_TOKEN="abc"\n', 'NOTION_TOKEN'), true);
  assert.equal(hasEnvValue("NOTION_TOKEN='abc'\n", 'NOTION_TOKEN'), true);
});

test('hasEnvValue: a commented-out assignment is absent', () => {
  assert.equal(hasEnvValue('# NOTION_TOKEN=abc\n', 'NOTION_TOKEN'), false);
});

test('hasEnvValue: an export-prefixed assignment is present', () => {
  assert.equal(hasEnvValue('export NOTION_TOKEN=abc\n', 'NOTION_TOKEN'), true);
});

test('hasEnvValue: a key that is a prefix of another key does not match it', () => {
  assert.equal(hasEnvValue('NOTION_TOKEN_OLD=abc\n', 'NOTION_TOKEN'), false);
});

// --- upsertEnvLine ---

test('upsertEnvLine: appends to an empty file and ends with one newline', () => {
  assert.equal(upsertEnvLine('', 'NOTION_TOKEN', 'abc'), 'NOTION_TOKEN=abc\n');
});

test('upsertEnvLine: appends to a file with no trailing newline without joining lines', () => {
  assert.equal(
    upsertEnvLine('FOO=bar', 'NOTION_TOKEN', 'abc'),
    'FOO=bar\nNOTION_TOKEN=abc\n',
  );
});

test('upsertEnvLine: replaces the first existing assignment and preserves every other line byte-for-byte', () => {
  const before = '# hand written\nNOTION_TOKEN=old\nUNRELATED=keep-me\n';
  const after = upsertEnvLine(before, 'NOTION_TOKEN', 'new');
  assert.equal(after, '# hand written\nNOTION_TOKEN=new\nUNRELATED=keep-me\n');
});

test('upsertEnvLine: replaces an export-prefixed line with a plain assignment', () => {
  const before = 'export NOTION_TOKEN=old\n';
  const after = upsertEnvLine(before, 'NOTION_TOKEN', 'new');
  assert.equal(after, 'NOTION_TOKEN=new\n');
});

test('upsertEnvLine: leaves a commented-out assignment alone and appends a real one', () => {
  const before = '# NOTION_TOKEN=xxx\n';
  const after = upsertEnvLine(before, 'NOTION_TOKEN', 'abc');
  assert.equal(after, '# NOTION_TOKEN=xxx\nNOTION_TOKEN=abc\n');
});
