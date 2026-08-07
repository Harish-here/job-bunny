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

function validInventoryJson(page: string): string {
  return JSON.stringify({
    page,
    pageType: 'details-page',
    generatedAt: '2026-01-01',
    selectors: {
      cardList: '.jobs-list',
      card: '.job-card',
      cardTitle: '.job-title',
      cardCompany: '.job-company',
      cardLocation: '.job-location',
      cardLink: 'a.job-link',
      jdRoot: '.jd-root',
    },
    behaviors: {},
  });
}

/** Wires a minimal `linkedin`-lane profile against `root` (real temp dir —
 * the linkedin lane's live construction reads a real page-inventory file
 * off `FsStorage(root)`) and returns the `cdp-reachable` check it
 * registers — the only observable proxy for `RuntimeDeps.chromeUserDataDir`
 * available from outside `cli/wire`. */
async function wireLinkedinCdpCheck(root: string): Promise<DoctorCheck> {
  const inventoryDir = join(
    root,
    'src',
    'adapters',
    'lanes',
    'linkedin',
    'page_inventory',
  );
  await mkdir(inventoryDir, { recursive: true });
  await writeFile(
    join(inventoryDir, 'staff-eng.json'),
    validInventoryJson('staff-eng'),
    'utf8',
  );

  const profileJson = JSON.stringify({
    lanes: ['linkedin'],
    connector: 'notion',
    notifiers: [],
    routines: [],
    settings: { notion: { dbId: 'db-1' } },
  });
  const searchUrlsMd = [
    '## Staff Engineer searches',
    '### staff-eng',
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
