/**
 * board_doctor.test.ts (fix round) — `runBoardDoctor` against a REAL
 * temporary home, same posture as `board.test.ts`: no fakes for `wire()`
 * itself, only a minimal on-disk profile fixture.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { runBoardDoctor } from './board_doctor.ts';

let root: string;

function profileDir(name: string): string {
  return path.join(root, 'profiles', name);
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-doctor-wire-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('a valid profile returns a real DoctorReport (findings present, status derived)', async () => {
  mkdirSync(profileDir('a'), { recursive: true });
  writeFileSync(
    path.join(profileDir('a'), 'profile.json'),
    JSON.stringify({ connector: 'sqlite' }),
  );
  mkdirSync(path.join(profileDir('a'), 'data'), { recursive: true });
  writeFileSync(path.join(profileDir('a'), 'data', 'jobbunny.db'), '');

  const report = await runBoardDoctor('a', root);
  assert.ok(report.findings.length > 0);
  assert.ok(['ok', 'warn', 'red'].includes(report.status));
});

test('a profile whose profile.json is missing degrades to a red report carrying a wire-failure finding, never throws', async () => {
  // No profile.json at all under this directory — `wire()` throws
  // "profile.json not found", which `runBoardDoctor` must catch and turn
  // into a synthesized red finding, exactly like the CLI's own
  // `doctorCommand` degrade path (`commands/doctor.ts`).
  mkdirSync(profileDir('no-config'), { recursive: true });

  const report = await runBoardDoctor('no-config', root);
  assert.equal(report.status, 'red');
  assert.ok(
    report.findings.some((f) => f.check === 'wire' && f.status === 'red'),
    `expected a synthesized 'wire' red finding, got: ${JSON.stringify(report.findings)}`,
  );
});
