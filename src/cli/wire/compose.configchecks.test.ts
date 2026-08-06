import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { DoctorCheck } from '../../ports/doctor.ts';
import { profileBuildCommand } from '../commands/profile.ts';
import { wire } from './compose.ts';

/**
 * compose.configchecks.test.ts (fix round, critical finding) — proves,
 * against REAL components (no fakes, no synthetic fixtures the app never
 * produces), that `wire()`'s `coreChecks` — routed through the profile's
 * real `ConfigStore` as of this fix, not a direct-fs read — correctly
 * classifies all three shapes a profile's `profile.json` can be in:
 * present only as a `config_docs` row (a board-created profile —
 * `profileBuildCommand`/`seedProfileDocs`, which never writes a legacy
 * file), present only as a legacy file (never lifted), and neither.
 *
 * Before this fix, `profileParsesCheck`/`filterParsesCheck`/
 * `emptyLanesCheck`/`sqlitePathRetiredCheck` read `profiles/<name>/
 * {profile,filter}.json` directly off disk — a config-docs-only profile
 * (case 1) was reported a false "not found" red by `profile-parses`, and
 * silently, falsely reported "ok — skipped" by `empty-lanes`, the very
 * check written to catch a freshly-built profile's `lanes: []` (P9
 * closure register).
 */

const dirs: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-wire-configchecks-'));
  dirs.push(dir);
  return dir;
}

function writeLegacyProfile(root: string, name: string, contents: unknown): void {
  const profileDir = path.join(root, 'profiles', name);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify(contents));
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

async function findingFor(checks: DoctorCheck[], name: string) {
  const check = checks.find((c) => c.name === name);
  assert.ok(check, `expected a '${name}' doctor check to be wired`);
  return check.run();
}

test('doc-in-db-only: a board-created profile (config_docs rows, zero legacy files) is never falsely reported "not found", and empty-lanes is never falsely skipped', async () => {
  const root = freshRoot();
  const name = 'board-created';

  const lines: string[] = [];
  const code = await profileBuildCommand(
    { profile: name },
    { root, write: (line) => lines.push(line) },
  );
  assert.equal(code, 0);
  // Confirm the repro's own premise: no legacy profile.json file exists —
  // this profile lives ONLY in config_docs.
  assert.equal(existsSync(path.join(root, 'profiles', name, 'profile.json')), false);

  const result = await wire(name, { root });
  result.ctx.runStore.close();

  const profileParses = await findingFor(result.checks, 'profile-parses');
  assert.equal(profileParses.status, 'ok');
  assert.doesNotMatch(profileParses.detail, /not found/);

  // `profileBuildCommand`'s MINIMAL_PIPELINE_CONFIG seeds `lanes: []` —
  // exactly the shape `empty-lanes` exists to catch. Before this fix it
  // would have reported `ok — skipped — profile.json unreadable`, a false
  // silence on a profile the check was written specifically to red.
  const emptyLanes = await findingFor(result.checks, 'empty-lanes');
  assert.equal(emptyLanes.status, 'red');
  assert.match(emptyLanes.detail, /no lanes configured/);
});

test('doc-in-file-only: a legacy-file-only profile (never lifted) is reported ok by profile-parses', async () => {
  const root = freshRoot();
  const name = 'legacy-only';
  writeLegacyProfile(root, name, {
    lanes: [],
    connector: 'sqlite',
    notifiers: [],
    routines: [],
    settings: {},
  });

  const result = await wire(name, { root, configLiftMode: 'readonly' });

  const profileParses = await findingFor(result.checks, 'profile-parses');
  assert.equal(profileParses.status, 'ok');
  // `lanes: []` here too — proving `empty-lanes` still fires red for a
  // legacy-file-only profile, the case it always covered.
  const emptyLanes = await findingFor(result.checks, 'empty-lanes');
  assert.equal(emptyLanes.status, 'red');
});

test('neither: a profile with no config_docs row and no legacy file throws loud at wire() time (unchanged) — profileParsesCheck itself still reports red for this shape', async () => {
  const root = freshRoot();
  await assert.rejects(() => wire('nope-at-all', { root }));
});
