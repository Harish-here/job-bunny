import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DoctorCheck, DoctorFinding } from '../../ports/doctor.ts';
import type { DaemonPidfileDeps } from '../daemon/index.ts';
import { acquireDaemonPidfile } from '../daemon/index.ts';
import {
  claudeOnPathCheck,
  configLegacyDivergenceCheck,
  coreChecks,
  daemonLivenessCheck,
  envTokensCheck,
  runChecks,
} from './aggregate.ts';

function fakeDaemonPidfileDeps(nowMs: number): DaemonPidfileDeps {
  const files = new Map<string, string>();
  const notFound = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p) ?? notFound(),
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    writeFileSyncExclusive: (p, data) => {
      if (files.has(p)) return false;
      files.set(p, data);
      return true;
    },
    renameSync: (from, to) => {
      const content = files.get(from) ?? notFound();
      files.delete(from);
      files.set(to, content);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    pidIsAlive: () => true,
    now: () => new Date(nowMs),
  };
}

test('daemonLivenessCheck: a fresh heartbeat on a live pid is ok', async () => {
  const now = Date.parse('2026-07-27T14:04:00.000Z');
  const daemonPidfile = fakeDaemonPidfileDeps(now);
  acquireDaemonPidfile('/fake/root', 1000, daemonPidfile);
  const finding = await daemonLivenessCheck({
    profileName: 'harish',
    root: '/fake/root',
    daemonPidfile,
  }).run();
  assert.equal(finding.status, 'ok');
});

test('daemonLivenessCheck: a six-minute-old heartbeat on a live pid warns "wedged"', async () => {
  const started = Date.parse('2026-07-27T14:04:00.000Z');
  const daemonPidfile = fakeDaemonPidfileDeps(started);
  acquireDaemonPidfile('/fake/root', 1000, daemonPidfile);
  daemonPidfile.now = () => new Date(started + 6 * 60_000);
  const finding = await daemonLivenessCheck({
    profileName: 'harish',
    root: '/fake/root',
    daemonPidfile,
  }).run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /wedged/);
});

// aggregate.ts composes each check's file path with `path.join(root, ...)`,
// so a POSIX-literal fixture key misses on windows-latest (backslash-joined
// paths) — same pattern as wire.test.ts/release.test.ts.
const REPO_ROOT = '/repo';

function fakeCheck(name: string, status: DoctorFinding['status']): DoctorCheck {
  return {
    name,
    async run(): Promise<DoctorFinding> {
      return { check: name, status, detail: `${name} says ${status}` };
    },
  };
}

// --- envTokensCheck ---

test('envTokensCheck: ok when both tokens are present', async () => {
  const check = envTokensCheck({
    profileName: 'rajni',
    connector: 'notion',
    env: { NOTION_TOKEN: 'secret-n', TELEGRAM_BOT_TOKEN: 'secret-t' },
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

const optsWithoutNotionToken = {
  profileName: 'rajni',
  env: { TELEGRAM_BOT_TOKEN: 'secret-t' },
};

test('envTokensCheck: red when NOTION_TOKEN is missing', async () => {
  const check = envTokensCheck({ ...optsWithoutNotionToken, connector: 'notion' });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /NOTION_TOKEN/);
});

test('envTokensCheck: warn when only TELEGRAM_BOT_TOKEN is missing', async () => {
  const check = envTokensCheck({
    profileName: 'rajni',
    connector: 'notion',
    env: { NOTION_TOKEN: 'secret-n' },
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /TELEGRAM_BOT_TOKEN/);
});

test('envTokensCheck: red (worst) when both tokens are missing, listing both', async () => {
  const check = envTokensCheck({
    profileName: 'rajni',
    connector: 'notion',
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
    connector: 'notion',
    env: { NOTION_TOKEN: '', TELEGRAM_BOT_TOKEN: 'secret-t' },
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('envTokensCheck: missing NOTION_TOKEN is only a warn for a non-notion connector', async () => {
  const finding = await envTokensCheck({
    ...optsWithoutNotionToken,
    connector: 'sqlite',
  }).run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /only needed for the notion connector/);
});

test('envTokensCheck: connector omitted behaves like non-notion (warn)', async () => {
  const finding = await envTokensCheck(optsWithoutNotionToken).run();
  assert.equal(finding.status, 'warn');
});

test('envTokensCheck: sqlite + mirror enabled + missing token warns with mirror-specific detail', async () => {
  const finding = await envTokensCheck({
    ...optsWithoutNotionToken,
    connector: 'sqlite',
    notionMirror: true,
  }).run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /mirror is enabled/);
});

test('envTokensCheck: sqlite + mirror flag absent keeps the existing generic detail', async () => {
  const finding = await envTokensCheck({
    ...optsWithoutNotionToken,
    connector: 'sqlite',
  }).run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /only needed for the notion connector/);
});

// --- coreChecks ---

test('daemonLivenessCheck: a missing pidfile warns', async () => {
  const daemonPidfile = fakeDaemonPidfileDeps(Date.now());
  const finding = await daemonLivenessCheck({
    profileName: 'harish',
    root: '/fake/root',
    daemonPidfile,
  }).run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /no daemon pidfile found/);
});

test('claudeOnPathCheck: present ⇒ ok, absent ⇒ red', async () => {
  const present = await claudeOnPathCheck({
    profileName: 'harish',
    commandExists: async () => true,
  }).run();
  assert.equal(present.status, 'ok');

  const absent = await claudeOnPathCheck({
    profileName: 'harish',
    commandExists: async () => false,
  }).run();
  assert.equal(absent.status, 'red');
  assert.match(absent.detail, /not found on PATH/);
});

// --- configLegacyDivergenceCheck (fix round, config→db Phase 4) ---

test('configLegacyDivergenceCheck: ok when the legacy file matches the store (or there is no legacy file)', async () => {
  const finding = await configLegacyDivergenceCheck({
    profileName: 'rajni',
    readDoc: async (key) => (key === 'filter.json' ? '{"a":1}' : undefined),
    readLegacyFile: async (key) => (key === 'filter.json' ? '{"a":1}' : undefined),
  }).run();
  assert.equal(finding.status, 'ok');
});

test('configLegacyDivergenceCheck: warn when the legacy file has drifted from the lifted row, naming the re-sync command', async () => {
  const finding = await configLegacyDivergenceCheck({
    profileName: 'rajni',
    readDoc: async (key) => (key === 'filter.json' ? '{"a":1}' : undefined),
    readLegacyFile: async (key) => (key === 'filter.json' ? '{"a":2}' : undefined),
  }).run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /filter\.json/);
  assert.match(finding.detail, /jobbunny config import --dir profiles\/rajni/);
});

test('configLegacyDivergenceCheck: names every diverged doc, not just the first', async () => {
  const finding = await configLegacyDivergenceCheck({
    profileName: 'rajni',
    readDoc: async (key) => `${key}-db`,
    readLegacyFile: async (key) => `${key}-file`,
  }).run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /profile\.json/);
  assert.match(finding.detail, /filter\.json/);
  assert.match(finding.detail, /resume\.json/);
  assert.match(finding.detail, /search_urls\.md/);
});

test('configLegacyDivergenceCheck: never throws — a readLegacyFile or readDoc throw for one key is skipped, not fatal', async () => {
  const finding = await configLegacyDivergenceCheck({
    profileName: 'rajni',
    readDoc: async (key) => {
      if (key === 'filter.json') throw new Error('malformed row');
      return undefined;
    },
    readLegacyFile: async (key) => (key === 'filter.json' ? '{"a":1}' : undefined),
  }).run();
  assert.equal(finding.status, 'ok');
});

test('coreChecks: returns the eight core checks (fix round adds config-legacy-divergence)', () => {
  const checks = coreChecks({
    profileName: 'rajni',
    root: REPO_ROOT,
    env: { NOTION_TOKEN: 't', TELEGRAM_BOT_TOKEN: 't' },
    readDoc: async () => undefined,
  });
  assert.equal(checks.length, 8);
  const names = checks.map((c) => c.name);
  assert.equal(new Set(names).size, 8);
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
