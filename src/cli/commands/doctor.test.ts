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
