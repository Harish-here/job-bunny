import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DoctorCheck, DoctorFinding } from '../../ports/doctor.ts';
import {
  coreChecks,
  emptyLanesCheck,
  envTokensCheck,
  filterParsesCheck,
  profileParsesCheck,
  runChecks,
} from './aggregate.ts';

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

function fakeCheck(name: string, status: DoctorFinding['status']): DoctorCheck {
  return {
    name,
    async run(): Promise<DoctorFinding> {
      return { check: name, status, detail: `${name} says ${status}` };
    },
  };
}

// --- profileParsesCheck ---

test('profileParsesCheck: ok on valid profile.json matching the schema', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({ '/repo/profiles/rajni/profile.json': VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('profileParsesCheck: red on missing profile.json', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /profile\.json/);
});

test('profileParsesCheck: red on malformed JSON', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({ '/repo/profiles/rajni/profile.json': '{ not json' }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('profileParsesCheck: red on schema-mismatch', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({
      '/repo/profiles/rajni/profile.json': JSON.stringify({ lanes: 'not-an-array' }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('profileParsesCheck: never throws', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    root: '/repo',
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
    root: '/repo',
    readFile: fakeReadFile({
      '/repo/profiles/rajni/filter.json': VALID_FILTER_JSON,
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('filterParsesCheck: warn on missing filter.json (optional)', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
});

test('filterParsesCheck: red on malformed JSON', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({ '/repo/profiles/rajni/filter.json': '{ nope' }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('filterParsesCheck: red on schema-mismatch', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({
      '/repo/profiles/rajni/filter.json': JSON.stringify({
        locations: [{ city: 'X', workTypes: ['not-a-worktype'] }],
      }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

// --- envTokensCheck ---

test('envTokensCheck: ok when both tokens are present', async () => {
  const check = envTokensCheck({
    profileName: 'rajni',
    env: { NOTION_TOKEN: 'secret-n', TELEGRAM_BOT_TOKEN: 'secret-t' },
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('envTokensCheck: red when NOTION_TOKEN is missing', async () => {
  const check = envTokensCheck({
    profileName: 'rajni',
    env: { TELEGRAM_BOT_TOKEN: 'secret-t' },
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /NOTION_TOKEN/);
});

test('envTokensCheck: warn when only TELEGRAM_BOT_TOKEN is missing', async () => {
  const check = envTokensCheck({
    profileName: 'rajni',
    env: { NOTION_TOKEN: 'secret-n' },
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /TELEGRAM_BOT_TOKEN/);
});

test('envTokensCheck: red (worst) when both tokens are missing, listing both', async () => {
  const check = envTokensCheck({
    profileName: 'rajni',
    env: {},
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /NOTION_TOKEN/);
  assert.match(finding.detail, /TELEGRAM_BOT_TOKEN/);
});

test('envTokensCheck: red when NOTION_TOKEN is an empty string', async () => {
  const check = envTokensCheck({
    profileName: 'rajni',
    env: { NOTION_TOKEN: '', TELEGRAM_BOT_TOKEN: 'secret-t' },
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

// --- emptyLanesCheck ---

test('emptyLanesCheck: red when profile.json has no lanes configured', async () => {
  const path = '/repo/profiles/rajni/profile.json';
  const check = emptyLanesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({
      [path]: JSON.stringify({
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
  const path = '/repo/profiles/rajni/profile.json';
  const check = emptyLanesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({ [path]: VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('emptyLanesCheck: stays ok (silent) when profile.json is missing — profileParsesCheck already reports that red', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('emptyLanesCheck: stays ok (silent) when profile.json fails schema validation — profileParsesCheck already reports that red', async () => {
  const path = '/repo/profiles/rajni/profile.json';
  const check = emptyLanesCheck({
    profileName: 'rajni',
    root: '/repo',
    readFile: fakeReadFile({ [path]: JSON.stringify({ nope: true }) }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

// --- coreChecks ---

test('coreChecks: returns the four core checks', () => {
  const checks = coreChecks({
    profileName: 'rajni',
    root: '/repo',
    env: { NOTION_TOKEN: 't', TELEGRAM_BOT_TOKEN: 't' },
    readFile: fakeReadFile({}),
  });
  assert.equal(checks.length, 4);
  const names = checks.map((c) => c.name);
  assert.equal(new Set(names).size, 4);
});

// --- runChecks ---

test('runChecks: empty input yields ok status and no findings', async () => {
  const report = await runChecks([]);
  assert.deepEqual(report, { findings: [], status: 'ok' });
});

test('runChecks: overall status is the worst across ok/warn/red', async () => {
  const report = await runChecks([
    fakeCheck('a', 'ok'),
    fakeCheck('b', 'warn'),
    fakeCheck('c', 'ok'),
  ]);
  assert.equal(report.status, 'warn');
});

test('runChecks: red outranks warn and ok', async () => {
  const report = await runChecks([
    fakeCheck('a', 'ok'),
    fakeCheck('b', 'warn'),
    fakeCheck('c', 'red'),
  ]);
  assert.equal(report.status, 'red');
});

test('runChecks: preserves input ordering of findings', async () => {
  const report = await runChecks([
    fakeCheck('third', 'ok'),
    fakeCheck('first', 'red'),
    fakeCheck('second', 'warn'),
  ]);
  assert.deepEqual(
    report.findings.map((f) => f.check),
    ['third', 'first', 'second'],
  );
});

test('runChecks: a throwing check yields a synthesized red finding, others still run', async () => {
  const throwing: DoctorCheck = {
    name: 'boom',
    async run(): Promise<DoctorFinding> {
      throw new Error('kaboom');
    },
  };
  const report = await runChecks([fakeCheck('a', 'ok'), throwing, fakeCheck('c', 'ok')]);
  assert.equal(report.status, 'red');
  assert.equal(report.findings.length, 3);
  const boomFinding = report.findings[1];
  assert.equal(boomFinding?.check, 'boom');
  assert.equal(boomFinding?.status, 'red');
  assert.match(boomFinding?.detail ?? '', /kaboom/);
});
