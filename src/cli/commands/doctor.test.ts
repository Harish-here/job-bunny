/**
 * doctor.test.ts (P8) — TDD for `doctorCommand`. `wire` is injected (FAKE
 * checks only, no real adapter), and the table output goes to an injected
 * sink instead of `console.log`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DoctorCheck, DoctorFinding } from '../../ports/doctor.ts';
import { doctorCommand } from './doctor.ts';

function fakeCheck(name: string, finding: DoctorFinding): DoctorCheck {
  return { name, run: async () => finding };
}

test('doctorCommand: any red finding returns 1', async () => {
  const checks = [
    fakeCheck('a', { check: 'a', status: 'ok', detail: 'fine' }),
    fakeCheck('b', { check: 'b', status: 'red', detail: 'broken' }),
  ];
  const code = await doctorCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx: {} as never, stages: [], routines: [], checks }),
      write: () => {},
    },
  );
  assert.equal(code, 1);
});

test('doctorCommand: only ok/warn findings return 0', async () => {
  const checks = [
    fakeCheck('a', { check: 'a', status: 'ok', detail: 'fine' }),
    fakeCheck('b', { check: 'b', status: 'warn', detail: 'meh' }),
  ];
  const code = await doctorCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx: {} as never, stages: [], routines: [], checks }),
      write: () => {},
    },
  );
  assert.equal(code, 0);
});

test('doctorCommand: no checks at all returns 0', async () => {
  const code = await doctorCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx: {} as never, stages: [], routines: [], checks: [] }),
      write: () => {},
    },
  );
  assert.equal(code, 0);
});

test('doctorCommand: a throwing wire() (e.g. a retired settings.sqlite.path, or a missing profile.json) degrades to a synthesized red "wire" finding PLUS the other config checks — never aborts the whole diagnostic', async () => {
  const lines: string[] = [];
  const degraded: DoctorFinding[] = [
    { check: 'profile-parses', status: 'ok', detail: 'profile.json parses' },
    {
      check: 'filter-parses',
      status: 'warn',
      detail: 'filter.json not found (optional)',
    },
    { check: 'empty-lanes', status: 'ok', detail: '2 lane(s) configured' },
    {
      check: 'sqlite-path-retired',
      status: 'red',
      detail: 'settings.sqlite.path is set',
    },
    { check: 'config-legacy-divergence', status: 'ok', detail: 'no divergence' },
  ];
  const code = await doctorCommand(
    { profile: 'broken' },
    {
      wire: async () => {
        throw new Error(
          'settings.sqlite.path is no longer supported — the database always lives at ' +
            'profiles/broken/data/jobbunny.db; move the file there and delete the setting',
        );
      },
      write: (line: string) => lines.push(line),
      runDegradedConfigChecks: async (profileName) => {
        assert.equal(profileName, 'broken');
        return degraded;
      },
    },
  );
  assert.equal(code, 1);
  assert.equal(lines.length, 2 + degraded.length);
  assert.match(lines[0] as string, /^home \| ok \| /);
  assert.match(lines[1] as string, /wire/);
  assert.match(lines[1] as string, /red/);
  assert.match(lines[1] as string, /settings\.sqlite\.path is no longer supported/);
  // Every degraded config check's finding is printed too, not swallowed.
  assert.ok(lines.some((l) => l.includes('profile-parses') && l.includes('ok')));
  assert.ok(lines.some((l) => l.includes('filter-parses') && l.includes('warn')));
  assert.ok(lines.some((l) => l.includes('empty-lanes') && l.includes('ok')));
  assert.ok(lines.some((l) => l.includes('sqlite-path-retired') && l.includes('red')));
  assert.ok(
    lines.some((l) => l.includes('config-legacy-divergence') && l.includes('ok')),
  );
});

test('doctorCommand: the default runDegradedConfigChecks opens a real readonly ConfigStore for the named profile and returns findings for all five config checks', async () => {
  const lines: string[] = [];
  const code = await doctorCommand(
    { profile: 'rajni' },
    {
      wire: async () => {
        throw new Error('boom');
      },
      write: (line: string) => lines.push(line),
    },
  );
  assert.equal(code, 1);
  // home finding + wire finding + the five config checks, no fake injected
  // this time.
  assert.equal(lines.length, 7);
  const checks = lines.map((l) => (l.split(' | ')[0] as string).trim());
  assert.deepEqual(checks, [
    'home',
    'wire',
    'profile-parses',
    'filter-parses',
    'empty-lanes',
    'sqlite-path-retired',
    'config-legacy-divergence',
  ]);
});

test('doctorCommand: writes a plain-text table of check | status | detail to the injected sink', async () => {
  const checks = [
    fakeCheck('notion.reachable', {
      check: 'notion.reachable',
      status: 'ok',
      detail: 'db ok',
    }),
    fakeCheck('cdp.reachable', {
      check: 'cdp.reachable',
      status: 'red',
      detail: 'chrome not reachable',
    }),
  ];
  const lines: string[] = [];
  const code = await doctorCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx: {} as never, stages: [], routines: [], checks }),
      write: (line: string) => lines.push(line),
    },
  );
  assert.equal(code, 1);
  const output = lines.join('\n');
  assert.match(output, /notion\.reachable/);
  assert.match(output, /ok/);
  assert.match(output, /db ok/);
  assert.match(output, /cdp\.reachable/);
  assert.match(output, /red/);
  assert.match(output, /chrome not reachable/);
});

test('doctorCommand: prints the resolved home first, on the success path', async () => {
  const lines: string[] = [];
  const code = await doctorCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx: {} as never, stages: [], routines: [], checks: [] }),
      write: (line: string) => lines.push(line),
    },
  );
  assert.equal(code, 0);
  assert.match(lines[0] as string, /^home \| ok \| /);
});

test('doctorCommand: prints the resolved home first, on the wire()-failure degraded path too', async () => {
  const lines: string[] = [];
  const code = await doctorCommand(
    { profile: 'broken' },
    {
      wire: async () => {
        throw new Error('boom');
      },
      write: (line: string) => lines.push(line),
      runDegradedConfigChecks: async () => [],
    },
  );
  assert.equal(code, 1);
  assert.match(lines[0] as string, /^home \| ok \| /);
});
