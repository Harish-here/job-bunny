import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  emptyLanesCheck,
  filterParsesCheck,
  profileParsesCheck,
} from './config_checks.ts';

const VALID_PROFILE_JSON = JSON.stringify({
  lanes: ['linkedin'],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: [],
  settings: {},
});

const VALID_FILTER_JSON = JSON.stringify({
  title: { domain: { match: ['frontend'], reject: [], severity: 'hard' } },
  locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
});

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(
    `ENOENT: no such file or directory, open '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function fakeReadFile(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    if (Object.hasOwn(files, path)) return files[path] as string;
    throw enoent(path);
  };
}

// config_checks.ts composes each check's file path with `path.join(root,
// ...)`, so a POSIX-literal fixture key misses on windows-latest
// (backslash-joined paths) — same pattern as wire.test.ts/release.test.ts.
const REPO_ROOT = '/repo';
function profilePath(name: string): string {
  return join(REPO_ROOT, 'profiles', name, 'profile.json');
}
function filterPath(name: string): string {
  return join(REPO_ROOT, 'profiles', name, 'filter.json');
}

// --- profileParsesCheck ---

test('profileParsesCheck: ok on valid profile.json matching the schema', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({ [profilePath('rajni')]: VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('profileParsesCheck: red on missing profile.json', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /profile\.json/);
});

test('profileParsesCheck: red on malformed JSON', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({ [profilePath('rajni')]: '{ not json' }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('profileParsesCheck: red on schema-mismatch', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({
      [profilePath('rajni')]: JSON.stringify({ lanes: 'not-an-array' }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('profileParsesCheck: never throws', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: async () => {
      throw new Error('disk on fire');
    },
  });
  await assert.doesNotReject(() => check.run());
});

// --- filterParsesCheck ---

test('filterParsesCheck: ok on valid filter.json matching the schema', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({
      [filterPath('rajni')]: VALID_FILTER_JSON,
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('filterParsesCheck: warn on missing filter.json (optional)', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
});

test('filterParsesCheck: red on malformed JSON', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({ [filterPath('rajni')]: '{ nope' }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('filterParsesCheck: red on schema-mismatch', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({
      [filterPath('rajni')]: JSON.stringify({
        locations: [{ city: 'X', workTypes: ['not-a-worktype'] }],
      }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

// --- emptyLanesCheck ---

test('emptyLanesCheck: red when profile.json has no lanes configured', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({
      [profilePath('rajni')]: JSON.stringify({
        lanes: [],
        connector: 'notion',
        notifiers: [],
        routines: [],
        settings: {},
      }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /no lanes configured/);
});

test('emptyLanesCheck: ok when at least one lane is configured', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({ [profilePath('rajni')]: VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('emptyLanesCheck: stays ok (silent) when profile.json is missing — profileParsesCheck already reports that red', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('emptyLanesCheck: stays ok (silent) when profile.json fails schema validation — profileParsesCheck already reports that red', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    root: REPO_ROOT,
    readFile: fakeReadFile({ [profilePath('rajni')]: JSON.stringify({ nope: true }) }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});
