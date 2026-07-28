import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearSessionState, SESSION_CLEAR_PROFILE_DIR } from './session_clear.ts';

/** Real fs, pointed only at a throwaway temp dir this file creates and
 * removes — clearSessionState's own tests deliberately exercise the real
 * implementation (not mocked fs calls) so the auth-preservation guarantee
 * is proven against actual files, never against `.chrome-debug/` itself. */
const realFsDeps = { existsSync, rmSync, readFileSync, writeFileSync };

/** Builds `<tmp>/Default/...` with a Sessions dir, a Preferences file, and
 * a handful of auth-bearing files/dirs — the same shape confirmed on disk
 * under the real `.chrome-debug/Default/` (2026-07-25). */
function makeProfileFixture(): { userDataDir: string; profileDir: string } {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jobbunny-chrome-fixture-'));
  const profileDir = join(userDataDir, SESSION_CLEAR_PROFILE_DIR);
  mkdirSync(profileDir, { recursive: true });

  // Session/tab state — expected to be cleared.
  const sessionsDir = join(profileDir, 'Sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'Session_123'), 'fake-session-bytes');
  writeFileSync(join(sessionsDir, 'Tabs_123'), 'fake-tabs-bytes');

  writeFileSync(
    join(profileDir, 'Preferences'),
    JSON.stringify({
      profile: {
        exit_type: 'Crashed',
        name: 'Person 1',
        unrelated_nested: { deeply: { nested: [1, 2, 3], flag: true } },
      },
      some_other_top_level_key: { untouched: true },
    }),
    'utf8',
  );

  // Auth-bearing state — MUST survive untouched.
  writeFileSync(join(profileDir, 'Cookies'), 'fake-cookie-db-bytes');
  writeFileSync(join(profileDir, 'Login Data'), 'fake-login-data-bytes');
  const localStorageDir = join(profileDir, 'Local Storage');
  mkdirSync(localStorageDir, { recursive: true });
  writeFileSync(join(localStorageDir, 'leveldb-file.ldb'), 'fake-local-storage-bytes');

  return { userDataDir, profileDir };
}

test('clearSessionState removes Sessions/tab-restore files from a temp fixture', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.attempted, true);
    assert.ok(result.removedEntries.includes('Sessions'));
    assert.equal(existsSync(join(profileDir, 'Sessions')), false);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState normalizes Preferences exit_type/exited_cleanly while preserving every other key byte-for-byte', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    const before = JSON.parse(readFileSync(join(profileDir, 'Preferences'), 'utf8'));
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.preferencesNormalized, true);

    const after = JSON.parse(readFileSync(join(profileDir, 'Preferences'), 'utf8'));
    assert.equal(after.profile.exit_type, 'Normal');
    assert.equal(after.profile.exited_cleanly, true);

    // Everything else — including deeply nested unrelated keys and
    // sibling top-level keys — must be untouched.
    assert.equal(after.profile.name, before.profile.name);
    assert.deepEqual(after.profile.unrelated_nested, before.profile.unrelated_nested);
    assert.deepEqual(after.some_other_top_level_key, before.some_other_top_level_key);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState never touches auth-bearing files (Cookies, Login Data, Local Storage/)', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    const cookiesBefore = readFileSync(join(profileDir, 'Cookies'), 'utf8');
    const loginDataBefore = readFileSync(join(profileDir, 'Login Data'), 'utf8');
    const localStorageFile = join(profileDir, 'Local Storage', 'leveldb-file.ldb');
    const localStorageBefore = readFileSync(localStorageFile, 'utf8');

    clearSessionState(userDataDir, realFsDeps);

    assert.equal(existsSync(join(profileDir, 'Cookies')), true);
    assert.equal(readFileSync(join(profileDir, 'Cookies'), 'utf8'), cookiesBefore);
    assert.equal(existsSync(join(profileDir, 'Login Data')), true);
    assert.equal(readFileSync(join(profileDir, 'Login Data'), 'utf8'), loginDataBefore);
    assert.equal(existsSync(localStorageFile), true);
    assert.equal(readFileSync(localStorageFile, 'utf8'), localStorageBefore);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState is a no-op (fail-soft) when the Sessions dir is missing', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jobbunny-chrome-fixture-'));
  try {
    mkdirSync(join(userDataDir, SESSION_CLEAR_PROFILE_DIR), { recursive: true });
    assert.doesNotThrow(() => clearSessionState(userDataDir, realFsDeps));
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.attempted, true);
    assert.deepEqual(result.removedEntries, []);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState is a no-op (fail-soft) when Preferences is malformed JSON', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    writeFileSync(join(profileDir, 'Preferences'), '{ not valid json', 'utf8');
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.preferencesNormalized, false);
    assert.ok(result.warnings.length > 0);
    // Left completely untouched, not rewritten.
    assert.equal(
      readFileSync(join(profileDir, 'Preferences'), 'utf8'),
      '{ not valid json',
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState skips entirely when SingletonLock is present (Chrome already running)', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    writeFileSync(join(userDataDir, 'SingletonLock'), 'lock');
    const sessionsBefore = existsSync(join(profileDir, 'Sessions'));
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.attempted, false);
    assert.ok(result.warnings.some((w) => w.includes('SingletonLock')));
    // Nothing removed, Preferences untouched.
    assert.equal(existsSync(join(profileDir, 'Sessions')), sessionsBefore);
    assert.equal(result.preferencesNormalized, false);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
