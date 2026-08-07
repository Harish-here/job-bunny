import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveHome } from './resolve.ts';

test('resolveHome: an absolute JOBBUNNY_HOME is returned unchanged', () => {
  assert.equal(
    resolveHome({ JOBBUNNY_HOME: '/srv/jb' }, () => '/Users/x'),
    resolve('/srv/jb'),
  );
});

test('resolveHome: a relative JOBBUNNY_HOME is resolved to an absolute path against cwd', () => {
  assert.equal(
    resolveHome({ JOBBUNNY_HOME: 'jbhome' }, () => '/Users/x'),
    join(process.cwd(), 'jbhome'),
  );
});

test('resolveHome: with JOBBUNNY_HOME unset it defaults to <homedir>/.jobbunny', () => {
  assert.equal(
    resolveHome({}, () => '/Users/x'),
    join('/Users/x', '.jobbunny'),
  );
});

test('resolveHome: an empty JOBBUNNY_HOME is treated as unset', () => {
  assert.equal(
    resolveHome({ JOBBUNNY_HOME: '' }, () => '/Users/x'),
    join('/Users/x', '.jobbunny'),
  );
});

test('resolveHome: a whitespace-only JOBBUNNY_HOME is treated as unset', () => {
  assert.equal(
    resolveHome({ JOBBUNNY_HOME: '   ' }, () => '/Users/x'),
    join('/Users/x', '.jobbunny'),
  );
});

test('resolveHome: the injected homedir is the only source of the default (no real os.homedir call)', () => {
  const result = resolveHome({}, () => '/fake/home');
  assert.equal(result, join('/fake/home', '.jobbunny'));
});
