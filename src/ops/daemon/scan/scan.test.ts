import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ScanDeps } from './scan.ts';
import { defaultScanDeps, scanProfileSchedules } from './scan.ts';

const PROFILES_DIR = '/fake/profiles';

/** `readProfileJson` mirrors the real `wireDaemonScheduleConfig`'s own
 * `undefined`-on-miss contract — this fake ignores `profilesDir` (the real
 * implementation derives its own path from `root`+`name`, per that
 * function's own doc comment) and looks `name` up in `files` directly. */
function fakeDeps(
  files: Record<string, string>,
  dirs: Record<string, string[]>,
): ScanDeps {
  return {
    readdirSync: (p) => {
      const entries = dirs[p];
      if (!entries) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return entries;
    },
    readProfileJson: async (_profilesDir, name) => files[profileKey(name)],
  };
}

function profileKey(name: string): string {
  return join(PROFILES_DIR, name, 'profile.json');
}

test('scanProfileSchedules: returns only the enabled profile, skipping the disabled one', async () => {
  const deps = fakeDeps(
    {
      [profileKey('harish')]: JSON.stringify({
        connector: 'notion',
        schedule: { times: ['09:00', '14:00'], enabled: true },
      }),
      [profileKey('rajni')]: JSON.stringify({
        connector: 'notion',
        schedule: { times: ['09:00'], enabled: false },
      }),
    },
    { [PROFILES_DIR]: ['harish', 'rajni'] },
  );

  const schedules = await scanProfileSchedules(PROFILES_DIR, deps);
  assert.deepEqual(
    schedules.map((s) => s.profile),
    ['harish'],
  );
  assert.deepEqual(schedules[0]?.times, ['09:00', '14:00']);
  assert.equal(schedules[0]?.graceMinutes, 90);
});

test('scanProfileSchedules: a profile with invalid JSON is skipped, not thrown', async () => {
  const deps = fakeDeps(
    { [profileKey('broken')]: 'not json{{{' },
    { [PROFILES_DIR]: ['broken'] },
  );
  await assert.doesNotReject(() => scanProfileSchedules(PROFILES_DIR, deps));
  assert.deepEqual(await scanProfileSchedules(PROFILES_DIR, deps), []);
});

test('scanProfileSchedules: a profile with no schedule block is skipped', async () => {
  const deps = fakeDeps(
    { [profileKey('noschedule')]: JSON.stringify({ connector: 'notion' }) },
    { [PROFILES_DIR]: ['noschedule'] },
  );
  assert.deepEqual(await scanProfileSchedules(PROFILES_DIR, deps), []);
});

test('scanProfileSchedules: a profile whose readProfileJson resolves undefined (missing db AND missing legacy file, or any other unresolvable case) is skipped, same as today\'s "no profile.json file" case', async () => {
  const deps = fakeDeps({}, { [PROFILES_DIR]: ['ghost'] });
  assert.deepEqual(await scanProfileSchedules(PROFILES_DIR, deps), []);
});

test('scanProfileSchedules: a profile whose readProfileJson comes from a v4-schema-only db (config_docs missing) still yields the schedule once the plumbing reaches SqliteConfigStore\'s own readonly "no such table" tolerance and lifts the legacy file', async () => {
  // This module has no idea a db is even involved — it only sees whatever
  // `readProfileJson` resolves to. This test pins that the plumbing (the
  // `undefined`-or-raw-text contract) is enough: a real `ConfigStore` that
  // internally tolerated a missing `config_docs` table and fell back to a
  // legacy file would surface here identically to a profile with no db at
  // all — both just resolve the raw text.
  const deps = fakeDeps(
    {
      [profileKey('legacy')]: JSON.stringify({
        connector: 'sqlite',
        schedule: { times: ['08:00'], enabled: true },
      }),
    },
    { [PROFILES_DIR]: ['legacy'] },
  );
  const schedules = await scanProfileSchedules(PROFILES_DIR, deps);
  assert.deepEqual(
    schedules.map((s) => s.profile),
    ['legacy'],
  );
});

test('defaultScanDeps: builds a working readdirSync-only shape (readProfileJson has no default — every real caller must supply it via wireDaemonScheduleConfig)', () => {
  const deps = defaultScanDeps();
  assert.equal(typeof deps.readdirSync, 'function');
  assert.ok(!('readProfileJson' in deps));
});
