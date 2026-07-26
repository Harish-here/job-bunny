/**
 * schedule.test.ts (P8 Task 4) — TDD for `scheduleCommand`. Every
 * dependency (`scheduler`, `readdir`, `readFile`, `write`) is FAKE — no
 * real `launchctl` shell-out, no real filesystem read, matches
 * `doctor.test.ts`/`run.test.ts`'s posture.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduledJob, Scheduler } from '../../ports/scheduler.ts';
import { collectScheduledJobs, type ScheduleDeps, scheduleCommand } from './schedule.ts';

function fakeScheduler(overrides: Partial<Scheduler> = {}): Scheduler & {
  installedWith: ScheduledJob[][];
  removedWith: string[];
} {
  const installedWith: ScheduledJob[][] = [];
  const removedWith: string[] = [];
  return {
    name: 'fake',
    async install(jobs) {
      installedWith.push(jobs);
    },
    async remove(profile) {
      removedWith.push(profile);
    },
    async list() {
      return [];
    },
    installedWith,
    removedWith,
    ...overrides,
  };
}

function fakeProfiles(
  files: Record<string, string>,
): Pick<ScheduleDeps, 'readdir' | 'readFile'> {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    // /root/profiles/<name>/profile.json — dirs = /root/profiles
    dirs.add(parts.slice(0, -2).join('/'));
  }
  return {
    async readdir(dir: string) {
      if (!dirs.has(dir)) {
        const err = new Error(`ENOENT: ${dir}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const names = new Set<string>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(`${dir}/`)) continue;
        const rest = path.slice(dir.length + 1);
        names.add(rest.split('/')[0] as string);
      }
      return [...names];
    },
    async readFile(path: string) {
      const content = files[path];
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
  };
}

function baseDeps(overrides: Partial<ScheduleDeps> = {}): ScheduleDeps {
  return {
    scheduler: fakeScheduler(),
    root: '/root',
    readdir: async () => [],
    readFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    write: () => {},
    ...overrides,
  };
}

// --- collectScheduledJobs ---

test('collectScheduledJobs: collects one ScheduledJob per schedule.times[] entry, across profiles', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/harish/profile.json': JSON.stringify({
      schedule: { enabled: true, times: ['09:00', '11:30'] },
    }),
    '/root/profiles/rajni/profile.json': JSON.stringify({
      schedule: { enabled: true, times: ['09:00'] },
    }),
  });
  const jobs = await collectScheduledJobs(baseDeps({ readdir, readFile }));
  assert.deepEqual(jobs, [
    { profile: 'harish', time: '09:00' },
    { profile: 'harish', time: '11:30' },
    { profile: 'rajni', time: '09:00' },
  ]);
});

test('collectScheduledJobs: enumerates profiles in deterministic sorted order', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/zeta/profile.json': JSON.stringify({
      schedule: { times: ['09:00'] },
    }),
    '/root/profiles/alpha/profile.json': JSON.stringify({
      schedule: { times: ['09:00'] },
    }),
    '/root/profiles/mid/profile.json': JSON.stringify({
      schedule: { times: ['09:00'] },
    }),
  });
  const jobs = await collectScheduledJobs(baseDeps({ readdir, readFile }));
  assert.deepEqual(
    jobs.map((j) => j.profile),
    ['alpha', 'mid', 'zeta'],
  );
});

test('collectScheduledJobs: skips a profile whose schedule.enabled is false (honors the v0 flag)', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/disabled/profile.json': JSON.stringify({
      schedule: { enabled: false, times: ['09:00'] },
    }),
    '/root/profiles/enabled/profile.json': JSON.stringify({
      schedule: { enabled: true, times: ['10:00'] },
    }),
  });
  const jobs = await collectScheduledJobs(baseDeps({ readdir, readFile }));
  assert.deepEqual(jobs, [{ profile: 'enabled', time: '10:00' }]);
});

test('collectScheduledJobs: a profile with schedule.enabled undefined (v2-native, no v0 flag) is still scheduled', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/v2native/profile.json': JSON.stringify({
      schedule: { times: ['08:00'] },
    }),
  });
  const jobs = await collectScheduledJobs(baseDeps({ readdir, readFile }));
  assert.deepEqual(jobs, [{ profile: 'v2native', time: '08:00' }]);
});

test('collectScheduledJobs: skips a profile with no schedule / empty times, without throwing', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/none/profile.json': JSON.stringify({}),
    '/root/profiles/empty/profile.json': JSON.stringify({ schedule: { times: [] } }),
  });
  const jobs = await collectScheduledJobs(baseDeps({ readdir, readFile }));
  assert.deepEqual(jobs, []);
});

test('collectScheduledJobs: skips a profile whose profile.json is unreadable or malformed, without aborting the rest', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/broken/profile.json': 'not json',
    '/root/profiles/good/profile.json': JSON.stringify({
      schedule: { times: ['09:00'] },
    }),
  });
  const jobs = await collectScheduledJobs(baseDeps({ readdir, readFile }));
  assert.deepEqual(jobs, [{ profile: 'good', time: '09:00' }]);
});

test('collectScheduledJobs: returns [] when the profiles/ dir is entirely absent', async () => {
  const jobs = await collectScheduledJobs(baseDeps());
  assert.deepEqual(jobs, []);
});

// --- scheduleCommand: install ---

test('scheduleCommand install: installs the full cross-profile job set in one call and returns 0', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/harish/profile.json': JSON.stringify({
      schedule: { enabled: true, times: ['09:00', '11:30'] },
    }),
    '/root/profiles/rajni/profile.json': JSON.stringify({
      schedule: { enabled: false, times: ['09:00'] },
    }),
  });
  const scheduler = fakeScheduler();
  const code = await scheduleCommand(
    { action: 'install' },
    { scheduler, readdir, readFile, root: '/root', write: () => {} },
  );
  assert.equal(code, 0);
  assert.equal(scheduler.installedWith.length, 1);
  assert.deepEqual(scheduler.installedWith[0], [
    { profile: 'harish', time: '09:00' },
    { profile: 'harish', time: '11:30' },
  ]);
});

test('scheduleCommand install: profiles sharing one time slot keep deterministic order in the printed summary', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/zeta/profile.json': JSON.stringify({
      schedule: { times: ['09:00'] },
    }),
    '/root/profiles/alpha/profile.json': JSON.stringify({
      schedule: { times: ['09:00'] },
    }),
  });
  const lines: string[] = [];
  const scheduler = fakeScheduler();
  await scheduleCommand(
    { action: 'install' },
    { scheduler, readdir, readFile, root: '/root', write: (l) => lines.push(l) },
  );
  // alpha before zeta — profile enumeration is sorted, so the order fed to
  // install (and echoed back) is deterministic and stable across runs;
  // profiles sharing a slot run STRICTLY SEQUENTIALLY in that order.
  assert.deepEqual(scheduler.installedWith[0], [
    { profile: 'alpha', time: '09:00' },
    { profile: 'zeta', time: '09:00' },
  ]);
  const summaryLine = lines.find((l) => l.includes('09:00'));
  assert.ok(summaryLine, 'expected a summary line for the 09:00 slot');
  assert.ok(summaryLine?.includes('alpha, zeta'));
});

test('scheduleCommand install: prints one line per plist label with time and profiles', async () => {
  const { readdir, readFile } = fakeProfiles({
    '/root/profiles/harish/profile.json': JSON.stringify({
      schedule: { enabled: true, times: ['09:00'] },
    }),
    '/root/profiles/rajni/profile.json': JSON.stringify({
      schedule: { enabled: true, times: ['09:00'] },
    }),
  });
  const lines: string[] = [];
  await scheduleCommand(
    { action: 'install' },
    {
      scheduler: fakeScheduler(),
      readdir,
      readFile,
      root: '/root',
      write: (l) => lines.push(l),
    },
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'com.jobbunny.0900 | 09:00 | harish, rajni');
});

test('scheduleCommand install: no scheduled profiles still installs an empty set and reports it', async () => {
  const lines: string[] = [];
  const scheduler = fakeScheduler();
  const code = await scheduleCommand(
    { action: 'install' },
    { scheduler, root: '/root', readdir: async () => [], write: (l) => lines.push(l) },
  );
  assert.equal(code, 0);
  assert.deepEqual(scheduler.installedWith[0], []);
  assert.ok(lines.some((l) => l.includes('no scheduled profiles')));
});

// --- scheduleCommand: remove ---

test('scheduleCommand remove: delegates to scheduler.remove(profile) and returns 0', async () => {
  const scheduler = fakeScheduler();
  const code = await scheduleCommand(
    { action: 'remove', profile: 'harish' },
    { scheduler, write: () => {} },
  );
  assert.equal(code, 0);
  assert.deepEqual(scheduler.removedWith, ['harish']);
});

test('scheduleCommand remove: missing --profile returns 1 without calling scheduler.remove', async () => {
  const scheduler = fakeScheduler();
  const lines: string[] = [];
  const code = await scheduleCommand(
    { action: 'remove' },
    { scheduler, write: (l) => lines.push(l) },
  );
  assert.equal(code, 1);
  assert.equal(scheduler.removedWith.length, 0);
  assert.ok(lines.some((l) => l.toLowerCase().includes('--profile')));
});

test('scheduleCommand remove: prints a confirmation line naming the profile', async () => {
  const scheduler = fakeScheduler();
  const lines: string[] = [];
  await scheduleCommand(
    { action: 'remove', profile: 'harish' },
    { scheduler, write: (l) => lines.push(l) },
  );
  assert.ok(lines.some((l) => l.includes('harish')));
});
