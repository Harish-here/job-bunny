import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { daemonLogPath } from '../../ops/daemon/logs/index.ts';
import type { AutostartDeps } from './autostart.ts';
import { autostartCommand, renderAutostartPlist } from './autostart.ts';

const HOME = '/fake/home';
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', 'com.jobbunny.autostart.plist');

test('renderAutostartPlist: RunAtLoad true, no StartCalendarInterval, sets WorkingDirectory', () => {
  const xml = renderAutostartPlist(
    '/usr/local/bin/node',
    '/repo/src/cli/main.ts',
    '/Users/tester/.jobbunny',
    '/usr/local/bin:/usr/bin:/bin',
    HOME,
  );
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(xml, /StartCalendarInterval/);
  assert.match(xml, /<string>com\.jobbunny\.autostart<\/string>/);
  assert.match(xml, /<string>serve<\/string>/);
  assert.match(xml, /<string>start<\/string>/);
  // B2: WorkingDirectory must be set to the resolved data home, or launchd
  // runs `serve start` with cwd `/` — wrong pidfile, wrong profilesDir, no
  // .env loaded.
  assert.match(
    xml,
    /<key>WorkingDirectory<\/key>\s*<string>\/Users\/tester\/\.jobbunny<\/string>/,
  );
});

test('renderAutostartPlist: carries the enabling shell PATH in EnvironmentVariables (F1)', () => {
  // Without this, launchd hands the daemon /usr/bin:/bin:/usr/sbin:/sbin,
  // `claude` (in ~/.local/bin) is off PATH, and every scheduled run dies
  // on the run child's own preflight.
  const xml = renderAutostartPlist(
    '/usr/local/bin/node',
    '/repo/src/cli/main.ts',
    '/repo',
    '/Users/rajni/.local/bin:/usr/bin:/bin',
    HOME,
  );
  assert.match(
    xml,
    /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/Users\/rajni\/\.local\/bin:\/usr\/bin:\/bin<\/string>\s*<\/dict>/,
  );
});

test('renderAutostartPlist: escapes the PATH and points both log streams at daemon.log (F4)', () => {
  const xml = renderAutostartPlist(
    '/usr/local/bin/node',
    '/repo/src/cli/main.ts',
    '/repo',
    '/Users/a & b/.local/bin:/usr/bin',
    HOME,
  );
  assert.match(xml, /<string>\/Users\/a &amp; b\/\.local\/bin:\/usr\/bin<\/string>/);
  assert.doesNotMatch(xml, /a & b/);
  // F4: the PARENT `serve start` launchd executes prints its refusals to
  // stdout/stderr; without these keys launchd discards them.
  const logPath = daemonLogPath(HOME);
  assert.ok(xml.includes(`<key>StandardOutPath</key>\n    <string>${logPath}</string>`));
  assert.ok(
    xml.includes(`<key>StandardErrorPath</key>\n    <string>${logPath}</string>`),
  );
});

test('renderAutostartPlist: XML-escapes an interpolated path containing "&"', () => {
  const xml = renderAutostartPlist(
    '/Users/a & b/node',
    '/repo/src/cli/main.ts',
    '/repo',
    '/usr/bin:/bin',
    HOME,
  );
  assert.match(xml, /a &amp; b/);
  assert.doesNotMatch(xml, /a & b/);
});

function fakeDeps(overrides: Partial<AutostartDeps> = {}): {
  deps: AutostartDeps;
  written: Map<string, string>;
  unlinked: string[];
  launchctlCalls: string[][];
  writes: string[];
  errs: string[];
} {
  const written = new Map<string, string>();
  const unlinked: string[] = [];
  const launchctlCalls: string[][] = [];
  const writes: string[] = [];
  const errs: string[] = [];
  const deps: AutostartDeps = {
    platform: 'darwin',
    home: HOME,
    uid: 501,
    root: '/fake/root',
    envPath: '/fake/home/.local/bin:/usr/bin:/bin',
    nodeBin: 'node',
    cliEntry: '/repo/src/cli/main.ts',
    listLaunchAgentFiles: () => [],
    writeFile: async (p, data) => {
      written.set(p, data);
    },
    unlink: async (p) => {
      unlinked.push(p);
    },
    runLaunchctl: async (args) => {
      launchctlCalls.push(args);
      return { exitCode: 0, stdout: '' };
    },
    write: (line) => writes.push(line),
    writeErr: (line) => errs.push(line),
    ...overrides,
  };
  return { deps, written, unlinked, launchctlCalls, writes, errs };
}

test('enable: writes the plist (with WorkingDirectory and PATH) and bootstraps it', async () => {
  const { deps, written, launchctlCalls } = fakeDeps();
  const code = await autostartCommand({ action: 'enable' }, deps);
  assert.equal(code, 0);
  const plist = written.get(PLIST_PATH);
  assert.ok(plist);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/fake\/root<\/string>/);
  // F1: the enable-time PATH really reaches the written file, not just the
  // renderer's own arguments.
  assert.match(plist, /<string>\/fake\/home\/\.local\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.deepEqual(launchctlCalls[0], ['bootstrap', 'gui/501', PLIST_PATH]);
});

test('enable: the plist WorkingDirectory is the injected data home, not the process cwd', async () => {
  const { deps, written } = fakeDeps({
    root: '/Users/tester/.jobbunny',
    home: '/Users/tester',
  });
  const code = await autostartCommand({ action: 'enable' }, deps);
  assert.equal(code, 0);
  const expectedPath = join(
    '/Users/tester',
    'Library',
    'LaunchAgents',
    'com.jobbunny.autostart.plist',
  );
  const plist = written.get(expectedPath);
  assert.ok(plist);
  assert.match(
    plist,
    /<key>WorkingDirectory<\/key>\s*<string>\/Users\/tester\/\.jobbunny<\/string>/,
  );
});

test('enable: refuses when a legacy launchd plist is found, without writing the plist', async () => {
  const { deps, written } = fakeDeps({
    listLaunchAgentFiles: () => ['com.jobbunny.1400.plist'],
  });
  const code = await autostartCommand({ action: 'enable' }, deps);
  assert.equal(code, 1);
  assert.equal(written.size, 0);
});

test('enable/disable: non-darwin exits nonzero naming the manual alternative', async () => {
  const enableDeps = fakeDeps({ platform: 'win32' });
  const enableCode = await autostartCommand({ action: 'enable' }, enableDeps.deps);
  assert.equal(enableCode, 1);
  assert.ok(enableDeps.errs.some((e) => e.includes('serve start')));

  const disableDeps = fakeDeps({ platform: 'linux' });
  const disableCode = await autostartCommand({ action: 'disable' }, disableDeps.deps);
  assert.equal(disableCode, 1);
  assert.ok(disableDeps.errs.some((e) => e.includes('serve start')));
});
