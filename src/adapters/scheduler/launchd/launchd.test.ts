/**
 * launchd.test.ts — TDD for LaunchdScheduler. Every dependency (the
 * `launchctl` command runner AND the filesystem) is injected with an
 * in-memory fake — never a real `launchctl` call, never a real
 * `~/Library/LaunchAgents` write.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LaunchdScheduler } from './launchd.ts';

const ROOT = '/repo';
const HOME = '/Users/tester';
const UID = 501;
const LAUNCH_AGENTS_DIR = `${HOME}/Library/LaunchAgents`;

interface RunCall {
  command: string;
  args: string[];
}

/** In-memory fake filesystem: a flat Map<path, content>, enough for
 * write/read/exists/readdir/unlink/mkdir over one directory tree. */
function makeFakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    existsSync: (path: string) =>
      files.has(path) || [...files.keys()].some((f) => f.startsWith(`${path}/`)),
    mkdirSync: () => {},
    writeFileSync: (path: string, content: string) => {
      files.set(path, content);
    },
    readFileSync: (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readdirSync: (dir: string) =>
      [...files.keys()]
        .filter((f) => f.startsWith(`${dir}/`))
        .map((f) => f.slice(dir.length + 1))
        .filter((f) => !f.includes('/')),
    unlinkSync: (path: string) => {
      files.delete(path);
    },
  };
}

function makeRunner(exitCode = 0) {
  const calls: RunCall[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    return { stdout: '', exitCode };
  };
  return { calls, run };
}

function makeScheduler(
  fs: ReturnType<typeof makeFakeFs>,
  run: ReturnType<typeof makeRunner>['run'],
) {
  return new LaunchdScheduler({ run, fs, root: ROOT, home: HOME, uid: UID });
}

test('install: writes a plist file per distinct time', async () => {
  const fs = makeFakeFs();
  const { run } = makeRunner();
  const scheduler = makeScheduler(fs, run);

  await scheduler.install([
    { profile: 'rajni', time: '09:00' },
    { profile: 'harish', time: '17:30' },
  ]);

  assert.ok(fs.files.has(`${LAUNCH_AGENTS_DIR}/com.jobbunny.0900.plist`));
  assert.ok(fs.files.has(`${LAUNCH_AGENTS_DIR}/com.jobbunny.1730.plist`));
});

test('install: issues bootout then bootstrap for each label, in that order', async () => {
  const fs = makeFakeFs();
  const { run, calls } = makeRunner();
  const scheduler = makeScheduler(fs, run);

  await scheduler.install([{ profile: 'rajni', time: '09:00' }]);

  const relevant = calls.filter((c) =>
    c.args.some((a) => a.includes('com.jobbunny.0900')),
  );
  assert.equal(relevant.length, 2);
  assert.deepEqual(relevant[0]?.args, ['bootout', `gui/${UID}/com.jobbunny.0900`]);
  assert.deepEqual(relevant[1], {
    command: 'launchctl',
    args: ['bootstrap', `gui/${UID}`, `${LAUNCH_AGENTS_DIR}/com.jobbunny.0900.plist`],
  });
});

test('install: tolerates a failing bootout (not-loaded on first install)', async () => {
  const fs = makeFakeFs();
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'bootout') throw new Error('Could not find service (not loaded)');
    return { stdout: '', exitCode: 0 };
  };
  const scheduler = makeScheduler(fs, run);

  await assert.doesNotReject(scheduler.install([{ profile: 'rajni', time: '09:00' }]));
  assert.ok(fs.files.has(`${LAUNCH_AGENTS_DIR}/com.jobbunny.0900.plist`));
});

test('install: throws loudly when bootstrap fails', async () => {
  const fs = makeFakeFs();
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'bootstrap') return { stdout: 'boom', exitCode: 1 };
    return { stdout: '', exitCode: 0 };
  };
  const scheduler = makeScheduler(fs, run);

  await assert.rejects(scheduler.install([{ profile: 'rajni', time: '09:00' }]));
});

test('install: prunes a stale plist not in the desired set', async () => {
  const staleXml = '<plist>jobbunny run --profile old --headless</plist>';
  const fs = makeFakeFs({
    [`${LAUNCH_AGENTS_DIR}/com.jobbunny.0600.plist`]: staleXml,
  });
  const { run, calls } = makeRunner();
  const scheduler = makeScheduler(fs, run);

  await scheduler.install([{ profile: 'rajni', time: '09:00' }]);

  assert.ok(!fs.files.has(`${LAUNCH_AGENTS_DIR}/com.jobbunny.0600.plist`));
  const bootoutStale = calls.find(
    (c) => c.args[0] === 'bootout' && c.args[1] === `gui/${UID}/com.jobbunny.0600`,
  );
  assert.ok(bootoutStale, 'expected a bootout call for the stale label');
});

test('install: prunes a stranded v0 com.jobbunny.run.HHMM plist', async () => {
  // v0 labeled its agents com.jobbunny.run.<HHMM> and pointed them at the
  // now-deleted scripts/ops/run_scheduled.sh — they must be reaped too.
  const legacyXml = '<plist>bash /repo/scripts/ops/run_scheduled.sh</plist>';
  const fs = makeFakeFs({
    [`${LAUNCH_AGENTS_DIR}/com.jobbunny.run.0900.plist`]: legacyXml,
  });
  const { run, calls } = makeRunner();
  const scheduler = makeScheduler(fs, run);

  await scheduler.install([{ profile: 'rajni', time: '09:00' }]);

  assert.ok(!fs.files.has(`${LAUNCH_AGENTS_DIR}/com.jobbunny.run.0900.plist`));
  const bootoutLegacy = calls.find(
    (c) => c.args[0] === 'bootout' && c.args[1] === `gui/${UID}/com.jobbunny.run.0900`,
  );
  assert.ok(bootoutLegacy, 'expected a bootout call for the legacy v0 label');
});

test('list: ignores legacy v0 plists (no profile info to recover)', async () => {
  const fs = makeFakeFs({
    [`${LAUNCH_AGENTS_DIR}/com.jobbunny.run.0900.plist`]:
      '<plist>bash /repo/scripts/ops/run_scheduled.sh</plist>',
  });
  const { run } = makeRunner();
  const scheduler = makeScheduler(fs, run);
  assert.deepEqual(await scheduler.list(), []);
});

test('install: does not touch a plist that is still desired', async () => {
  const { run } = makeRunner();
  const fs = makeFakeFs();
  const scheduler = makeScheduler(fs, run);
  await scheduler.install([{ profile: 'rajni', time: '09:00' }]);
  const firstWrite = fs.files.get(`${LAUNCH_AGENTS_DIR}/com.jobbunny.0900.plist`);
  assert.ok(firstWrite);

  await scheduler.install([{ profile: 'rajni', time: '09:00' }]);
  assert.ok(fs.files.has(`${LAUNCH_AGENTS_DIR}/com.jobbunny.0900.plist`));
});

test('list: round-trips profiles and times recovered from on-disk plists', async () => {
  const fs = makeFakeFs();
  const { run } = makeRunner();
  const scheduler = makeScheduler(fs, run);

  await scheduler.install([
    { profile: 'rajni', time: '09:00' },
    { profile: 'harish', time: '09:00' },
    { profile: 'rajni', time: '17:30' },
  ]);

  const listed = await scheduler.list();
  const sorted = [...listed].sort(
    (a, b) => a.time.localeCompare(b.time) || a.profile.localeCompare(b.profile),
  );
  assert.deepEqual(sorted, [
    { profile: 'harish', time: '09:00' },
    { profile: 'rajni', time: '09:00' },
    { profile: 'rajni', time: '17:30' },
  ]);
});

test('list: returns an empty array when no jobbunny plists exist', async () => {
  const fs = makeFakeFs();
  const { run } = makeRunner();
  const scheduler = makeScheduler(fs, run);
  assert.deepEqual(await scheduler.list(), []);
});

test('remove: drops one profile from a shared time slot, keeping the other', async () => {
  const fs = makeFakeFs();
  const { run } = makeRunner();
  const scheduler = makeScheduler(fs, run);

  await scheduler.install([
    { profile: 'rajni', time: '09:00' },
    { profile: 'harish', time: '09:00' },
  ]);

  await scheduler.remove('rajni');

  const listed = await scheduler.list();
  assert.deepEqual(listed, [{ profile: 'harish', time: '09:00' }]);
});

test('remove: booting out and deleting the plist for a time slot that becomes empty', async () => {
  const fs = makeFakeFs();
  const { run, calls } = makeRunner();
  const scheduler = makeScheduler(fs, run);

  await scheduler.install([{ profile: 'rajni', time: '09:00' }]);
  calls.length = 0; // only care about calls made during remove()

  await scheduler.remove('rajni');

  assert.ok(!fs.files.has(`${LAUNCH_AGENTS_DIR}/com.jobbunny.0900.plist`));
  const bootoutCall = calls.find(
    (c) => c.args[0] === 'bootout' && c.args[1] === `gui/${UID}/com.jobbunny.0900`,
  );
  assert.ok(bootoutCall, 'expected a bootout call for the now-empty slot');
  const listed = await scheduler.list();
  assert.deepEqual(listed, []);
});

test('remove: a no-op profile leaves the schedule unchanged', async () => {
  const fs = makeFakeFs();
  const { run } = makeRunner();
  const scheduler = makeScheduler(fs, run);

  await scheduler.install([{ profile: 'rajni', time: '09:00' }]);
  await scheduler.remove('nonexistent');

  const listed = await scheduler.list();
  assert.deepEqual(listed, [{ profile: 'rajni', time: '09:00' }]);
});

test('name is "launchd"', () => {
  const fs = makeFakeFs();
  const { run } = makeRunner();
  const scheduler = makeScheduler(fs, run);
  assert.equal(scheduler.name, 'launchd');
});
