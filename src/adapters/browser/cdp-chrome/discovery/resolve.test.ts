import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCandidates } from './resolve.ts';

test('resolveCandidates returns the configured array whole and unchanged when JOBBUNNY_CHROME_PATH is unset', () => {
  const configured = ['/opt/chrome-a', '/opt/chrome-b'];
  const candidates = resolveCandidates('darwin', {}, configured);
  assert.deepEqual(candidates, ['/opt/chrome-a', '/opt/chrome-b']);
  assert.notEqual(candidates, configured, 'must return a copy, not a mutable reference');
});

test('resolveCandidates returns a single-element array from JOBBUNNY_CHROME_PATH when set, ignoring configured and the platform table', () => {
  const candidates = resolveCandidates(
    'darwin',
    { JOBBUNNY_CHROME_PATH: '/custom/chrome' },
    ['/configured/chrome'],
  );
  assert.deepEqual(candidates, ['/custom/chrome']);
});

test('resolveCandidates falls through an empty-string JOBBUNNY_CHROME_PATH to the configured tier', () => {
  const candidates = resolveCandidates('darwin', { JOBBUNNY_CHROME_PATH: '' }, [
    '/configured/chrome',
  ]);
  assert.deepEqual(candidates, ['/configured/chrome']);
});

test('resolveCandidates falls through an empty configured array to the per-OS table', () => {
  const candidates = resolveCandidates('linux', {}, []);
  assert.deepEqual(candidates, [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]);
});

test('resolveCandidates falls through to the per-OS table when configured is undefined', () => {
  const candidates = resolveCandidates('win32', {
    LOCALAPPDATA: 'C:\\Users\\rajni\\AppData\\Local',
  });
  assert.deepEqual(candidates, [
    'C:\\Users\\rajni\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ]);
});
