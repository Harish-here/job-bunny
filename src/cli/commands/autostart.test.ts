import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AutostartDeps } from './autostart.ts';
import { autostartCommand, renderAutostartPlist } from './autostart.ts';

test('renderAutostartPlist: RunAtLoad true, no StartCalendarInterval, sets WorkingDirectory', () => {
  const xml = renderAutostartPlist(
    '/usr/local/bin/node',
    '/repo/src/cli/main.ts',
    '/repo',
  );
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(xml, /StartCalendarInterval/);
  assert.match(xml, /<string>com\.jobbunny\.autostart<\/string>/);
  assert.match(xml, /<string>serve<\/string>/);
  assert.match(xml, /<string>start<\/string>/);
  // B2: WorkingDirectory must be set, or launchd runs `serve start` with
  // cwd `/` — wrong pidfile, wrong profilesDir, no .env loaded.
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/repo<\/string>/);
});

test('renderAutostartPlist: XML-escapes an interpolated path containing "&"', () => {
  const xml = renderAutostartPlist('/Users/a & b/node', '/repo/src/cli/main.ts', '/repo');
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
    home: '/fake/home',
    uid: 501,
    root: '/fake/root',
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

test('enable: writes the plist (with WorkingDirectory) and bootstraps it', async () => {
  const { deps, written, launchctlCalls } = fakeDeps();
  const code = await autostartCommand({ action: 'enable' }, deps);
  assert.equal(code, 0);
  const plist = written.get(
    '/fake/home/Library/LaunchAgents/com.jobbunny.autostart.plist',
  );
  assert.ok(plist);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/fake\/root<\/string>/);
  assert.deepEqual(launchctlCalls[0], [
    'bootstrap',
    'gui/501',
    '/fake/home/Library/LaunchAgents/com.jobbunny.autostart.plist',
  ]);
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
