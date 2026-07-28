import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ScanDeps } from './scan.ts';
import { defaultScanDeps, scanProfileSchedules, scanRunHistory } from './scan.ts';

const PROFILES_DIR = '/fake/profiles';

function fakeDeps(
  files: Record<string, string>,
  dirs: Record<string, string[]>,
): ScanDeps {
  return {
    existsSync: (p) => p in files || p in dirs,
    readdirSync: (p) => {
      const entries = dirs[p];
      if (!entries) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return entries;
    },
    readFileSync: (p) => {
      const content = files[p];
      if (content === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
  };
}

function profilePath(name: string): string {
  return join(PROFILES_DIR, name, 'profile.json');
}

test('scanProfileSchedules: returns only the enabled profile, skipping the disabled one', () => {
  const deps = fakeDeps(
    {
      [profilePath('harish')]: JSON.stringify({
        connector: 'notion',
        schedule: { times: ['09:00', '14:00'], enabled: true },
      }),
      [profilePath('rajni')]: JSON.stringify({
        connector: 'notion',
        schedule: { times: ['09:00'], enabled: false },
      }),
    },
    { [PROFILES_DIR]: ['harish', 'rajni'] },
  );

  const schedules = scanProfileSchedules(PROFILES_DIR, deps);
  assert.deepEqual(
    schedules.map((s) => s.profile),
    ['harish'],
  );
  assert.deepEqual(schedules[0]?.times, ['09:00', '14:00']);
  assert.equal(schedules[0]?.graceMinutes, 90);
});

test('scanProfileSchedules: a profile with invalid JSON is skipped, not thrown', () => {
  const deps = fakeDeps(
    { [profilePath('broken')]: 'not json{{{' },
    { [PROFILES_DIR]: ['broken'] },
  );
  assert.doesNotThrow(() => scanProfileSchedules(PROFILES_DIR, deps));
  assert.deepEqual(scanProfileSchedules(PROFILES_DIR, deps), []);
});

test('scanProfileSchedules: a profile with no schedule block is skipped', () => {
  const deps = fakeDeps(
    { [profilePath('noschedule')]: JSON.stringify({ connector: 'notion' }) },
    { [PROFILES_DIR]: ['noschedule'] },
  );
  assert.deepEqual(scanProfileSchedules(PROFILES_DIR, deps), []);
});

test('scanRunHistory: parses run-folder names, including a collision-suffixed one', () => {
  const runsDir = join(PROFILES_DIR, 'harish', 'data', 'runs', '2026-07-27');
  const deps = fakeDeps(
    {},
    { [runsDir]: ['09-00', '14-04', '14-04-2', 'sync_dryrun.json'] },
  );
  const history = scanRunHistory(PROFILES_DIR, ['harish'], '2026-07-27', deps);
  assert.deepEqual(history.map((r) => r.startedAt).sort(), ['09:00', '14:04', '14:04']);
  assert.ok(history.every((r) => r.profile === 'harish' && r.date === '2026-07-27'));
});

test('scanRunHistory: a missing runs directory yields []', () => {
  const deps = fakeDeps({}, {});
  const history = scanRunHistory(PROFILES_DIR, ['harish'], '2026-07-27', deps);
  assert.deepEqual(history, []);
});

test('defaultScanDeps: builds a working real-fs deps object shape', () => {
  const deps = defaultScanDeps();
  assert.equal(typeof deps.existsSync, 'function');
  assert.equal(typeof deps.readdirSync, 'function');
  assert.equal(typeof deps.readFileSync, 'function');
});
