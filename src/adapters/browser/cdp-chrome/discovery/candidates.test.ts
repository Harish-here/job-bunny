import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromeCandidates } from './candidates.ts';

test('chromeCandidates returns the full win32 table when every candidate env var is set', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\rajni\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  };
  const candidates = chromeCandidates('win32', env);
  assert.deepEqual(candidates, [
    'C:\\Users\\rajni\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]);
});

test('chromeCandidates omits PROGRAMFILES(X86)-rooted entries (Chrome and Edge) when that var is unset', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\rajni\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
  };
  const candidates = chromeCandidates('win32', env);
  assert.deepEqual(candidates, [
    'C:\\Users\\rajni\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ]);
});

test('chromeCandidates returns the fixed Linux table regardless of env', () => {
  const candidates = chromeCandidates('linux', {});
  assert.deepEqual(candidates, [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]);
});

test('chromeCandidates returns system paths plus HOME-rooted counterparts on darwin when HOME is set', () => {
  const candidates = chromeCandidates('darwin', { HOME: '/Users/rajni' });
  assert.deepEqual(candidates, [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/rajni/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Users/rajni/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Users/rajni/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Users/rajni/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]);
});

test('chromeCandidates omits the HOME-rooted entries on darwin when HOME is unset', () => {
  const candidates = chromeCandidates('darwin', {});
  assert.deepEqual(candidates, [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]);
});

test('chromeCandidates returns an empty array for an unrecognized platform', () => {
  assert.deepEqual(chromeCandidates('freebsd', {}), []);
});
