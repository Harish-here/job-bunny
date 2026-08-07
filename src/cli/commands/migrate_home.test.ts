/**
 * migrate_home.test.ts (Task 5) — TDD for `migrateHomeCommand`, the
 * one-shot `jobbunny migrate-home` bridge. Every dep is a fake object
 * literal (matching `migrate.test.ts`/`profile.test.ts`'s style): no real
 * filesystem, no real process table. `pidfile` fakes exercise the real
 * `readDaemonPidfile` (imported from `ops/daemon/index.ts`, not
 * reimplemented here) by controlling only its `readFileSync`/`pidIsAlive`
 * primitives — proof that the daemon check really is `serve status`'s own
 * mechanism, just pointed at the migration source.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DaemonPidfileDeps } from '../../ops/daemon/index.ts';
import { type MigrateHomeDeps, migrateHomeCommand } from './migrate_home.ts';

function noPidfileDeps(): DaemonPidfileDeps {
  return {
    existsSync: () => false,
    readFileSync: () => {
      const err = new Error('no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
    writeFileSync: () => {},
    writeFileSyncExclusive: () => true,
    renameSync: () => {},
    unlinkSync: () => {},
    pidIsAlive: () => false,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
}

function alivePidfileDeps(pid: number): DaemonPidfileDeps {
  const raw = JSON.stringify({
    pid,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastTickAt: '2026-01-01T00:00:00.000Z',
    attempts: [],
  });
  return { ...noPidfileDeps(), readFileSync: () => raw, pidIsAlive: (p) => p === pid };
}

function stalePidfileDeps(pid: number): DaemonPidfileDeps {
  return { ...alivePidfileDeps(pid), pidIsAlive: () => false };
}

function baseDeps(overrides: Partial<MigrateHomeDeps> = {}): {
  deps: MigrateHomeDeps;
  lines: string[];
  errLines: string[];
  renameCalls: Array<[string, string]>;
} {
  const lines: string[] = [];
  const errLines: string[] = [];
  const renameCalls: Array<[string, string]> = [];
  const deps: MigrateHomeDeps = {
    home: '/home',
    source: '/legacy',
    existsSync: () => false,
    readdirSync: () => [],
    mkdirSync: () => {},
    renameSync: (from, to) => {
      renameCalls.push([from, to]);
    },
    pidfile: noPidfileDeps(),
    write: (l) => lines.push(l),
    writeErr: (l) => errLines.push(l),
    ...overrides,
  };
  return { deps, lines, errLines, renameCalls };
}

test('migrate-home: a source with no profiles/ is refused', async () => {
  const { deps, errLines } = baseDeps({ existsSync: () => false });
  const code = await migrateHomeCommand({ apply: false }, deps);
  assert.equal(code, 1);
  assert.deepEqual(errLines, [
    'migrate-home: /legacy does not look like a Job Bunny install (no profiles/ directory) — pass --from <path>',
  ]);
});

test('migrate-home: a running daemon in the source is refused, naming serve stop', async () => {
  const { deps, errLines } = baseDeps({
    existsSync: (p) => p === join('/legacy', 'profiles'),
    pidfile: alivePidfileDeps(4242),
  });
  const code = await migrateHomeCommand({ apply: false }, deps);
  assert.equal(code, 1);
  assert.deepEqual(errLines, [
    "migrate-home: the daemon is running (pid 4242) — run 'jobbunny serve stop' first",
  ]);
});

test('migrate-home: a stale pidfile in the source does not block', async () => {
  const { deps, lines } = baseDeps({
    existsSync: (p) => p === join('/legacy', 'profiles'),
    readdirSync: () => ['alice'],
    pidfile: stalePidfileDeps(4242),
  });
  const code = await migrateHomeCommand({ apply: false }, deps);
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes('alice')));
});

test('migrate-home: dry-run lists every move and touches nothing', async () => {
  const { deps, lines, renameCalls } = baseDeps({
    existsSync: (p) => p === join('/legacy', 'profiles') || p === join('/legacy', '.env'),
    readdirSync: () => ['alice'],
  });
  const code = await migrateHomeCommand({ apply: false }, deps);
  assert.equal(code, 0);
  assert.equal(renameCalls.length, 0);
  assert.equal(lines[0], 'migrate-home: /legacy → /home');
  assert.ok(
    lines.includes(
      `  ${join('/legacy', 'profiles', 'alice')} → ${join('/home', 'profiles', 'alice')}`,
    ),
  );
  assert.ok(lines.includes(`  ${join('/legacy', '.env')} → ${join('/home', '.env')}`));
  assert.equal(
    lines[lines.length - 1],
    'migrate-home: dry-run — nothing was moved. Re-run with --apply to move.',
  );
});

test('migrate-home: rajni is excluded and reported as skipped', async () => {
  const { deps, lines } = baseDeps({
    existsSync: (p) => p === join('/legacy', 'profiles'),
    readdirSync: () => ['alice', 'rajni'],
  });
  const code = await migrateHomeCommand({ apply: false }, deps);
  assert.equal(code, 0);
  assert.ok(!lines.some((l) => l.includes(join('profiles', 'rajni')) && l.includes('→')));
  assert.ok(
    lines.includes('  skipped profiles/rajni (committed fixture — stays in the repo)'),
  );
});

test('migrate-home: an existing destination is refused, not merged', async () => {
  const { deps, errLines, renameCalls } = baseDeps({
    existsSync: (p) =>
      p === join('/legacy', 'profiles') || p === join('/home', 'profiles', 'alice'),
    readdirSync: () => ['alice'],
  });
  const code = await migrateHomeCommand({ apply: true }, deps);
  assert.equal(code, 1);
  assert.deepEqual(errLines, [
    `migrate-home: ${join('/home', 'profiles', 'alice')} already exists — refusing to overwrite`,
  ]);
  assert.equal(renameCalls.length, 0);
});

test('migrate-home: --apply renames profiles, .env, and .chrome-debug → chrome, in that order', async () => {
  const { deps, lines, renameCalls } = baseDeps({
    existsSync: (p) =>
      p === join('/legacy', 'profiles') ||
      p === join('/legacy', '.env') ||
      p === join('/legacy', '.chrome-debug'),
    readdirSync: () => ['alice'],
  });
  const code = await migrateHomeCommand({ apply: true }, deps);
  assert.equal(code, 0);
  assert.deepEqual(renameCalls, [
    [join('/legacy', 'profiles', 'alice'), join('/home', 'profiles', 'alice')],
    [join('/legacy', '.env'), join('/home', '.env')],
    [join('/legacy', '.chrome-debug'), join('/home', 'chrome')],
  ]);
  assert.ok(lines.includes('migrate-home: moved 3 item(s) into /home'));
});

test('migrate-home: an EXDEV rename reports a hand-move instruction and stops', async () => {
  const { deps, errLines } = baseDeps({
    existsSync: (p) => p === join('/legacy', 'profiles'),
    readdirSync: () => ['alice'],
    renameSync: () => {
      const err = new Error('cross-device link') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    },
  });
  const code = await migrateHomeCommand({ apply: true }, deps);
  assert.equal(code, 1);
  assert.deepEqual(errLines, [
    `migrate-home: cannot move ${join('/legacy', 'profiles', 'alice')} across filesystems — move it by hand, then re-run`,
  ]);
});

test('migrate-home: an empty plan is reported and returns non-zero', async () => {
  const { deps, lines } = baseDeps({
    existsSync: (p) => p === join('/legacy', 'profiles'),
    readdirSync: () => ['rajni'],
  });
  const code = await migrateHomeCommand({ apply: false }, deps);
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'migrate-home: nothing to move — /legacy has no profiles (other than rajni), no .env, and no .chrome-debug/',
  ]);
});

test('migrate-home: source equal to home is refused', async () => {
  const { deps, lines } = baseDeps({ home: '/same', source: '/same' });
  const code = await migrateHomeCommand({ apply: false }, deps);
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'migrate-home: source and destination are the same directory (/same) — nothing to do',
  ]);
});
