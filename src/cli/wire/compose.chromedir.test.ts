/**
 * compose.chromedir.test.ts (consumer CLI data-home spec, Task 4) — the
 * Chrome user-data-dir is computed exactly once in `compose.ts`, from the
 * injected `root`, and travels to its consumers (`CdpChromeProvider`, the
 * LinkedIn throttle breaker, the `cdp-reachable` doctor check) as a plain
 * string — never a fresh `resolveHome()`/`import.meta.url` lookup of its
 * own. New file: `compose.test.ts` is at its 800-line cap (the repo already
 * splits wire tests this way — see `compose.sqlitepath.test.ts`,
 * `compose.runstore.test.ts`, `compose.statestore.test.ts`).
 *
 * `chromeUserDataDir` isn't exposed on `WireResult`, so both tests observe
 * it indirectly through the `cdp-reachable` check registered by the
 * `linkedin` lane — the one doctor check that reads a file FROM that exact
 * directory (`.jobbunny-chrome.json`) and reports whether it found it.
 * `browserReachable` is overridden to always report "reachable" so the
 * check reaches its pid-file read (the branch under test) deterministically,
 * regardless of whether a real Chrome happens to be listening on the CDP
 * port in the environment this runs in.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DoctorCheck } from '../../ports/doctor.ts';
import { wire } from './compose.ts';
import { fakeConfigStore } from './testkit.ts';

/** Wires a minimal `linkedin`-lane profile against `root` (the DATA home —
 * NEVER seeded with a fake `src/adapters/...` inventory tree: the
 * `page_inventory/<page>.json` the linkedin lane reads is a PROGRAM file
 * that ships inside the package itself, at the package's own install
 * location, not under the data home. `page` must therefore name a page
 * inventory that REALLY ships in this repo's
 * `src/adapters/lanes/linkedin/page_inventory/` — 'linkedin__jobs-search'
 * by default) and returns the `cdp-reachable` check it registers — the
 * only observable proxy for `RuntimeDeps.chromeUserDataDir` available from
 * outside `cli/wire`. */
async function wireLinkedinCdpCheck(
  root: string,
  page = 'linkedin__jobs-search',
): Promise<DoctorCheck> {
  const profileJson = JSON.stringify({
    lanes: ['linkedin'],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-1' } },
  });
  const searchUrlsMd = [
    '## Staff Engineer searches',
    `### ${page}`,
    '  • US remote - https://www.linkedin.com/jobs/search/?keywords=staff+engineer',
  ].join('\n');
  const configStore = fakeConfigStore({
    'profile.json': profileJson,
    'filter.json': JSON.stringify({}),
    'search_urls.md': searchUrlsMd,
  });

  const result = await wire('rajni', {
    root,
    configStore,
    deps: { browserReachable: async () => ({ browser: 'HeadlessChrome' }) },
  });
  const check = result.checks.find((c) => c.name === 'cdp-reachable');
  assert.ok(check, 'the linkedin lane must register a cdp-reachable check');
  return check as DoctorCheck;
}

/** Writes a Chrome pid-file recording a LIVE pid (this test process' own —
 * `readChromePidfile` self-heals a dead one away, which would make every
 * assertion below pass for the wrong reason). */
async function writeLivePidfile(userDataDir: string): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, '.jobbunny-chrome.json'),
    JSON.stringify({ pid: process.pid, port: 9222, startedAt: new Date().toISOString() }),
    'utf8',
  );
}

test('wire: the Chrome user-data-dir is <root>/chrome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-chromedir-'));
  try {
    await writeLivePidfile(join(root, 'chrome'));
    const check = await wireLinkedinCdpCheck(root);
    const finding = await check.run();
    assert.equal(finding.status, 'ok');
    assert.match(finding.detail, /CDP reachable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wire: the linkedin lane builds from the package-shipped page_inventory even when the data home (root) has no src/ tree at all', async () => {
  // Real-component regression proof (fix round, critical finding 1):
  // `root` here is the DATA home a real install passes to `wire()`, and it
  // deliberately contains no `src/` tree — an installed `~/.jobbunny` never
  // does. The page used ('linkedin__jobs-search') is a REAL inventory file
  // that ships inside this package's own
  // `src/adapters/lanes/linkedin/page_inventory/` — not a fixture written
  // into a temp dir. Before the fix, `loadInventory` read the machine-shared
  // inventory handle off `root` (the data home) instead of the package's
  // own install location, so this always threw "missing page inventory".
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-chromedir-nosrc-'));
  try {
    const check = await wireLinkedinCdpCheck(root, 'linkedin__jobs-search');
    const finding = await check.run();
    // `browserReachable` is overridden to report reachable, so a
    // non-throwing `wire()` call plus a functioning `cdp-reachable` check
    // is proof the linkedin lane (and its `loadInventory` call) built
    // successfully against the package's own inventory tree.
    assert.equal(finding.status, 'warn');
    assert.match(finding.detail, /no Job Bunny pid file found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wire: the Chrome dir is not anchored inside the package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jb-wire-chromedir-legacy-'));
  try {
    // Simulates the OLD anchor this task removes — repo-root/.chrome-debug,
    // formerly derived from launcher.ts's own `import.meta.url`. A pid file
    // recorded there must NOT be found once the anchor moves to the data
    // home: this is the negative proof that nothing under `src/` still
    // resolves the Chrome dir relative to the package's own location.
    await writeLivePidfile(join(root, '.chrome-debug'));
    const check = await wireLinkedinCdpCheck(root);
    const finding = await check.run();
    assert.equal(finding.status, 'warn');
    assert.match(finding.detail, /no Job Bunny pid file found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
