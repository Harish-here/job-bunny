# Cross-Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chrome discovery and process ownership cross-platform (Windows/Linux/macOS) and shell-out-free, and validate every future change against all three OSes in CI.

**Architecture:** A pure per-OS candidate table (`discovery/`) replaces the hardcoded macOS-only path list; a three-tier resolution function layers an env-var override and a `profile.json`-configured override on top of it. A JSON pid file (`ownership/`) written at Chrome spawn time replaces `lsof`/`ps` for both liveness and age, closing the recycle-policy loop without shelling out. CI gains a 3-OS matrix wrapped so the branch-protection-required `test` check name never changes.

**Tech Stack:** TypeScript 7 (strict, erasable-syntax-only), Node 24 stdlib (`node:fs`, `node:path`, `node:process`), `node:test` + `node:assert/strict`, GitHub Actions.

## Global Constraints

- Node >= 24, ESM, TypeScript 7 strict with erasable-syntax-only (no enums, no namespaces).
- Runtime dependencies must NOT increase. Current: `@notionhq/client`, `dotenv`, `playwright`, `zod`.
- Two-pair rule: a folder exceeding two implementation files (test pairs and `index.ts` excluded) gets split into subfolders first.
- Every module is a folder with an `index.ts` public surface; internals are not imported across module boundaries.
- Colocated tests: `foo.ts` pairs with `foo.test.ts`.
- Boundary rules enforced by `npm run boundaries`: `core/` imports nothing outward; `adapters/` may not import `pipeline`, `routines`, `ops`, or `cli`; only `cli/wire.ts` imports `src/adapters/**`.
- Tests must be hermetic — no real network, no real Chrome, no real Notion. A 2026-07-27 sweep of all 81 `*.test.ts` files found zero violations; keep it that way.
- `npm run check` (typecheck + lint + boundaries + test) is the gate.
- `AbortSignal` is the deadline mechanism everywhere; no unbounded await in an adapter.

---

## Scope note

This plan implements only §7 (Chrome discovery and process ownership), D11, D12, and D17 of `docs/superpowers/specs/2026-07-27-cross-platform-daemon-design.md`. The daemon (`src/ops/daemon/`), `src/core/schedule/`, `serve`/`autostart` CLI commands, the `launchd` migration/deletion, and the config-schema `enabled`/`weekdays`/`graceMinutes` extension are explicitly out of scope for this plan — they belong to a separate plan covering the rest of the spec.

---

### Task 1: CI matrix over three OSes

**Files:**
- Modify: `/Users/harishamutha/Job-bunny/.github/workflows/test.yml`

**Interfaces:** N/A — this task edits a GitHub Actions workflow, not TypeScript.

**Rationale:** `main`'s branch protection requires a status check literally named `test`. A bare matrix on the existing `test` job would rename it to `test (ubuntu-latest)` etc. and silently orphan that protection rule. So the matrix job is renamed `check`, and a second job named `test` with `needs: [check]` preserves the required check name with zero branch-protection change. A GitHub Actions job with no `steps` is invalid, so the wrapper `test` job carries `run: echo ok`.

This task has no unit test — it is CI configuration, not application code.

- [ ] **Step 1: Rewrite `.github/workflows/test.yml` with the matrix `check` job plus the wrapper `test` job.**

  Replace the entire file with:

  ```yaml
  name: test

  on:
    pull_request:
    push:
      branches: [main, main-v2]

  jobs:
    check:
      strategy:
        fail-fast: false
        matrix:
          os: [macos-latest, ubuntu-latest, windows-latest]
      runs-on: ${{ matrix.os }}
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 24
        # Tests never launch a browser — skip Playwright's ~300MB browser download.
        - run: npm ci
          env:
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
        - run: npm run typecheck
        - run: npm run lint
        - run: npm run boundaries
        - run: npm test

    test:
      needs: [check]
      runs-on: ubuntu-latest
      steps:
        - run: echo ok
  ```

  Every existing step under `check` (`actions/checkout@v4`, `actions/setup-node@v4` at node 24, `npm ci` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"`, `npm run typecheck`, `npm run lint`, `npm run boundaries`, `npm test`) is copied verbatim from the original `test` job — only the job id, the `strategy`/`runs-on` matrix lines, and the new wrapper job are new.

- [ ] **Step 2: Verify by eye — there is no local YAML-parsing tool in this repo to lean on.**

  This repo has no `yaml`/`js-yaml` dependency (the 3-runtime-dep-plus-`dotenv` cap forbids adding one just for this check), so do not invent a `node -e "require('yaml').parse(...)"` command — it will fail with `Cannot find module 'yaml'`, not because the file is invalid. Instead:

  ```bash
  git diff .github/workflows/test.yml
  ```

  Confirm by eye that the diff matches the fenced block in Step 1 exactly: two top-level jobs (`check`, `test`), `check` carries the `strategy`/`matrix`/`runs-on: ${{ matrix.os }}` lines and all six original steps unchanged, `test` carries `needs: [check]` and a single `run: echo ok` step. This step has no pass/fail exit code — the verification is human inspection against the reference block above.

- [ ] **Step 3: Commit.**

  ```bash
  git add .github/workflows/test.yml
  git commit -m "$(cat <<'EOF'
  ci: run the test gate on a macOS/Linux/Windows matrix

  Renames the existing job to `check` and adds a matrix over the three
  target OSes so `npm run check` is actually proven cross-platform; a
  second `test` job with `needs: [check]` keeps the branch-protection-
  required check name unchanged.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

  **Real verification, deferred to the first push**: this task's actual proof is not local — it is the first push to a branch carrying this change, which must show three `check (macos-latest)` / `check (ubuntu-latest)` / `check (windows-latest)` runs plus one `test` run (`needs: [check]`) in the PR's checks list, and the `test` check must still be the one branch protection is watching.

---

### Task 2: `chromeCandidates` pure per-OS table

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/candidates.ts`
- Create: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/candidates.test.ts`
- Create: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/index.ts`

**Placement rationale:** `src/adapters/browser/cdp-chrome/` already holds three implementation files (`check.ts`, `launcher.ts`, `provider.ts`) — the repo's two-implementation-file cap forces new code into a subfolder rather than a fourth file at the top level (D11). `discovery/` is a new module (folder + `index.ts` public surface) inside the `cdp-chrome` adapter family, so it stays within `adapters-no-cross-family` and `adapters-only-ports-core`.

**Interfaces:**

Consumes: nothing (pure function of its two parameters).

Produces:
```ts
export function chromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[];
```

- [ ] **Step 1: Write the failing test for the Windows table with every candidate env var set.**

  Create `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/candidates.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { chromeCandidates } from './candidates.ts';

  test('chromeCandidates returns the full win32 table when every candidate env var is set', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\rajni\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    };
    const candidates = chromeCandidates('win32', env);
    assert.deepEqual(candidates, [
      'C:\\Users\\rajni\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `candidates.ts` does not exist yet.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  ```

  Expected failure: `Cannot find module '.../discovery/candidates.ts'` (module resolution error, not an assertion failure — the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation for the Windows table.**

  Create `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/candidates.ts`:

  ```ts
  import { win32 as pathWin32 } from 'node:path';

  /**
   * chromeCandidates (D11) — pure per-OS Chrome/Edge candidate path table,
   * built entirely from environment variables (no hardcoded drive letters,
   * no existsSync call inside it). This is what makes Windows/Linux
   * discovery unit-testable from a macOS dev machine: inject `platform` and
   * a fake `env`, assert on the returned string array, with no real
   * filesystem or OS involved. Existence is checked later, by
   * launcher.ts's resolveChromePath — exactly the same split it already
   * keeps today.
   */
  export function chromeCandidates(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
  ): string[] {
    if (platform === 'win32') return win32Candidates(env);
    // Linux and darwin are implemented in later steps of this task; every
    // other platform (including these two, until then) falls through here.
    return [];
  }

  function win32Candidates(env: NodeJS.ProcessEnv): string[] {
    const candidates: string[] = [];
    if (env.LOCALAPPDATA) {
      candidates.push(
        pathWin32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    }
    if (env.PROGRAMFILES) {
      candidates.push(
        pathWin32.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    }
    const programFilesX86 = env['PROGRAMFILES(X86)'];
    if (programFilesX86) {
      candidates.push(
        pathWin32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
      // Last resort — Chromium-based, speaks CDP.
      candidates.push(
        pathWin32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    }
    return candidates;
  }
  ```

  This intermediate version only handles `win32` and the unrecognized-platform fallthrough — Steps 9 and 12 below add the `linux`/`darwin` branches and their helper functions.

- [ ] **Step 4: Run it and see it pass.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  ```

  Expected: `# pass 1`.

- [ ] **Step 5: Write the failing test for a missing `PROGRAMFILES(X86)`.**

  Append to `candidates.test.ts`:

  ```ts
  test('chromeCandidates omits PROGRAMFILES(X86)-rooted entries (Chrome and Edge) when that var is unset', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\rajni\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    };
    const candidates = chromeCandidates('win32', env);
    assert.deepEqual(candidates, [
      'C:\\Users\\rajni\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });
  ```

- [ ] **Step 6: Run it and see it pass immediately** (the Step 3 implementation already skips both Program Files (x86) entries together when the env var is unset, via the single `if (programFilesX86)` guard).

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  ```

  Expected: `# pass 2`.

- [ ] **Step 7: Write the failing test for the fixed Linux table.**

  Append to `candidates.test.ts`:

  ```ts
  test('chromeCandidates returns the fixed Linux table regardless of env', () => {
    const candidates = chromeCandidates('linux', {});
    assert.deepEqual(candidates, [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ]);
  });
  ```

- [ ] **Step 8: Run it and see it fail** — `chromeCandidates('linux', ...)` currently falls through to the final `return []` (Linux branch not implemented yet).

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  ```

  Expected failure: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal` — actual `[]`, expected the six-entry array.

- [ ] **Step 9: Add `LINUX_CANDIDATES` and wire the `linux` branch into `chromeCandidates`, and see it pass.**

  Insert above `win32Candidates` in `candidates.ts`:

  ```ts
  const LINUX_CANDIDATES: readonly string[] = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  ```

  Update `chromeCandidates`'s body:

  ```ts
  export function chromeCandidates(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
  ): string[] {
    if (platform === 'win32') return win32Candidates(env);
    if (platform === 'linux') return LINUX_CANDIDATES.slice();
    // darwin is implemented in a later step of this task; every other
    // platform (including darwin, until then) falls through here.
    return [];
  }
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  ```

  Expected: `# pass 3`.

- [ ] **Step 10: Write the failing tests for the darwin table, both with and without `HOME`.**

  Append to `candidates.test.ts`:

  ```ts
  test('chromeCandidates returns system paths plus HOME-rooted counterparts on darwin when HOME is set', () => {
    const candidates = chromeCandidates('darwin', { HOME: '/Users/rajni' });
    assert.deepEqual(candidates, [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/rajni/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Users/rajni/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Users/rajni/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Users/rajni/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  });

  test('chromeCandidates omits the HOME-rooted entries on darwin when HOME is unset', () => {
    const candidates = chromeCandidates('darwin', {});
    assert.deepEqual(candidates, [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  });
  ```

- [ ] **Step 11: Run and see both fail** — the darwin branch currently falls through to `return []`.

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  ```

  Expected failure: both new tests report `Expected values to be strictly deep-equal` with actual `[]`.

- [ ] **Step 12: Implement `darwinCandidates` and see everything pass.**

  Insert above the final `chromeCandidates` export (or wherever `win32Candidates` sits) in `candidates.ts`:

  ```ts
  const DARWIN_APP_SUFFIXES: readonly string[] = [
    'Google Chrome.app/Contents/MacOS/Google Chrome',
    'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    'Chromium.app/Contents/MacOS/Chromium',
  ];

  function darwinCandidates(env: NodeJS.ProcessEnv): string[] {
    const candidates: string[] = [];
    for (const suffix of DARWIN_APP_SUFFIXES) {
      candidates.push(`/Applications/${suffix}`);
      if (env.HOME) {
        candidates.push(`${env.HOME}/Applications/${suffix}`);
      }
    }
    return candidates;
  }
  ```

  Update `chromeCandidates`'s body to its final form:

  ```ts
  export function chromeCandidates(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
  ): string[] {
    if (platform === 'win32') return win32Candidates(env);
    if (platform === 'linux') return LINUX_CANDIDATES.slice();
    if (platform === 'darwin') return darwinCandidates(env);
    return [];
  }
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  ```

  Expected: `# pass 6`.

- [ ] **Step 13: Write and pass the unrecognized-platform test.**

  Append to `candidates.test.ts`:

  ```ts
  test('chromeCandidates returns an empty array for an unrecognized platform', () => {
    assert.deepEqual(chromeCandidates('freebsd', {}), []);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  ```

  Expected: `# pass 7` (already passes given the final `if`/`if`/`if`/`return []` shape — no implementation change needed).

- [ ] **Step 14: Create the module's public surface.**

  Create `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/index.ts`:

  ```ts
  export { chromeCandidates } from './candidates.ts';
  ```

- [ ] **Step 15: Run typecheck/lint/boundaries on just this new module before committing.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/candidates.test.ts
  npx tsc --noEmit -p tsconfig.json
  npx biome check src/adapters/browser/cdp-chrome/discovery/
  ```

  Expected: all pass; `boundaries` is deferred to the full `npm run check` at the end of Task 7, since dependency-cruiser scans the whole `src/` graph regardless of what changed.

- [ ] **Step 16: Commit.**

  ```bash
  git add src/adapters/browser/cdp-chrome/discovery/candidates.ts src/adapters/browser/cdp-chrome/discovery/candidates.test.ts src/adapters/browser/cdp-chrome/discovery/index.ts
  git commit -m "$(cat <<'EOF'
  feat(cdp-chrome): add a pure per-OS Chrome candidate table

  chromeCandidates(platform, env) builds Windows/Linux/macOS Chrome (and,
  on Windows, Edge as a last resort) install-path candidates from
  environment variables only — no existsSync, no hardcoded drive
  letters — so Windows/Linux discovery is unit-testable from macOS.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: Three-tier resolution wired into the launcher

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/resolve.ts`
- Create: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/resolve.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/index.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.test.ts`

**Interfaces:**

Consumes: `chromeCandidates` from Task 2 (`./candidates.ts` inside `discovery/`, re-exported via `discovery/index.ts`).

Produces:
```ts
export function resolveCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  configured?: readonly string[],
): string[];
```

- [ ] **Step 1: Write the failing regression test — a two-element `configured` array must survive intact.**

  Create `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/resolve.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { resolveCandidates } from './resolve.ts';

  test('resolveCandidates returns the configured array whole and unchanged when JOBBUNNY_CHROME_PATH is unset', () => {
    const configured = ['/opt/chrome-a', '/opt/chrome-b'];
    const candidates = resolveCandidates('darwin', {}, configured);
    assert.deepEqual(candidates, ['/opt/chrome-a', '/opt/chrome-b']);
    assert.notEqual(candidates, configured, 'must return a copy, not a mutable reference');
  });
  ```

- [ ] **Step 2: Run it and see it fail because `resolve.ts` does not exist yet.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/resolve.test.ts
  ```

  Expected failure: `Cannot find module '.../discovery/resolve.ts'`.

- [ ] **Step 3: Write the minimal implementation.**

  Create `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/resolve.ts`:

  ```ts
  import { chromeCandidates } from './candidates.ts';

  /**
   * resolveCandidates (D11, §7.2) — three-tier Chrome candidate resolution.
   * First non-empty tier wins; the winner REPLACES the others, never
   * merges with them:
   *   1. JOBBUNNY_CHROME_PATH env var, if set and non-empty.
   *   2. `configured` (settings['cdp-chrome'].candidates from profile.json),
   *      if present and non-empty — used in full and in order, unchanged.
   *   3. chromeCandidates(platform, env) — the per-OS table.
   */
  export function resolveCandidates(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    configured?: readonly string[],
  ): string[] {
    const override = env.JOBBUNNY_CHROME_PATH;
    if (override) return [override];
    if (configured && configured.length > 0) return configured.slice();
    return chromeCandidates(platform, env);
  }
  ```

- [ ] **Step 4: Run it and see it pass.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/resolve.test.ts
  ```

  Expected: `# pass 1`.

- [ ] **Step 5: Write and pass the remaining resolution-order tests in one batch (env override wins; empty override falls through; empty configured falls through; undefined configured falls through).**

  Append to `resolve.test.ts`:

  ```ts
  test('resolveCandidates returns a single-element array from JOBBUNNY_CHROME_PATH when set, ignoring configured and the platform table', () => {
    const candidates = resolveCandidates(
      'darwin',
      { JOBBUNNY_CHROME_PATH: '/custom/chrome' },
      ['/configured/chrome'],
    );
    assert.deepEqual(candidates, ['/custom/chrome']);
  });

  test('resolveCandidates falls through an empty-string JOBBUNNY_CHROME_PATH to the configured tier', () => {
    const candidates = resolveCandidates(
      'darwin',
      { JOBBUNNY_CHROME_PATH: '' },
      ['/configured/chrome'],
    );
    assert.deepEqual(candidates, ['/configured/chrome']);
  });

  test('resolveCandidates falls through an empty configured array to the per-OS table', () => {
    const candidates = resolveCandidates('linux', {}, []);
    assert.deepEqual(candidates, [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ]);
  });

  test('resolveCandidates falls through to the per-OS table when configured is undefined', () => {
    const candidates = resolveCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\rajni\\AppData\\Local',
    });
    assert.deepEqual(candidates, [
      'C:\\Users\\rajni\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/discovery/resolve.test.ts
  ```

  Expected: `# pass 5` — all pass immediately, the Step 3 implementation already satisfies every case (no further implementation change needed here).

- [ ] **Step 6: Export `resolveCandidates` from the module's public surface.**

  Edit `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/discovery/index.ts`:

  ```ts
  export { chromeCandidates } from './candidates.ts';
  export { resolveCandidates } from './resolve.ts';
  ```

- [ ] **Step 7: Write the failing test in `launcher.test.ts` proving `launchChrome` honors `JOBBUNNY_CHROME_PATH` over its own `candidates` option.**

  Append to `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.test.ts` (after the existing `launchChrome` tests):

  ```ts
  test('launchChrome resolves via JOBBUNNY_CHROME_PATH when set, ignoring the candidates option entirely', () => {
    const spawnCalls: Array<{ command: string }> = [];
    const proc = launchChrome(
      { port: 9222, candidates: ['/configured/chrome'] },
      {
        existsSync: (path) => path === '/from/env/chrome',
        spawn: (command) => {
          spawnCalls.push({ command });
          return { pid: 4242, unref: () => {} };
        },
        env: { JOBBUNNY_CHROME_PATH: '/from/env/chrome' },
      },
    );
    assert.equal(proc.pid, 4242);
    assert.equal(spawnCalls[0]?.command, '/from/env/chrome');
  });
  ```

- [ ] **Step 8: Run it and see it fail** — `launchChrome` currently defaults its `candidates` destructure to `CHROME_PATH_CANDIDATES` and never consults `env.JOBBUNNY_CHROME_PATH`, so it spawns `/configured/chrome` (via `resolveChromePath`'s first-existing-candidate rule, since `existsSync` only returns true for `/from/env/chrome`, this actually throws "no Chrome executable found" instead).

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts
  ```

  Expected failure: `Error: no Chrome executable found (checked: /configured/chrome) — install Google Chrome (or Microsoft Edge on Windows)` (uncaught, since the test doesn't wrap the call in `assert.throws`).

- [ ] **Step 9: Wire `resolveCandidates` into `launchChrome`.**

  In `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.ts`, add the import:

  ```ts
  import { resolveCandidates } from './discovery/index.ts';
  ```

  Change the body of `launchChrome`:

  ```ts
  export function launchChrome(
    options: LaunchChromeOptions,
    deps: LauncherDeps = {},
  ): ChromeProcessHandle {
    const { port, userDataDir = DEFAULT_USER_DATA_DIR, candidates } = options;
    const existsSync = deps.existsSync ?? nodeExistsSync;
    const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
    const env = deps.env ?? process.env;
    if (env[SESSION_CLEAR_SKIP_ENV] !== '1') {
      const sessionClearDeps: SessionClearFsDeps = {
        existsSync,
        rmSync: deps.rmSync ?? nodeRmSync,
        readFileSync: deps.readFileSync ?? nodeReadFileSync,
        writeFileSync: deps.writeFileSync ?? nodeWriteFileSync,
      };
      clearSessionState(userDataDir, sessionClearDeps);
    }
    const resolvedCandidates = resolveCandidates(process.platform, env, candidates);
    const chromePath = resolveChromePath(resolvedCandidates, { existsSync });
    const argv = buildLaunchArgv({ port, userDataDir });
    const child = spawn(chromePath, argv, { detached: true, stdio: 'ignore' });
    child.unref();
    return { pid: child.pid };
  }
  ```

  Note precisely what changed: the `candidates = CHROME_PATH_CANDIDATES` default on the destructure is REMOVED (now just `candidates`, `undefined` when the caller passes none); `resolveChromePath` is now called with `resolvedCandidates` (the output of the three-tier resolution) instead of the raw `candidates` option. `resolveChromePath` itself (its own signature, its own `CHROME_PATH_CANDIDATES` default parameter, its own "checked every path" error message) is UNCHANGED — per this task's brief, only the source of the candidates array passed into it changes.

- [ ] **Step 10: Generalize `resolveChromePath`'s not-found error for Edge on Windows (spec §7.1, tier 3).**

  In `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.ts`, change only the error message's suffix — the prefix (`no Chrome executable found (checked: ${candidates.join(', ')})`) stays BYTE-IDENTICAL:

  ```ts
  throw new Error(
    `no Chrome executable found (checked: ${candidates.join(', ')}) — install Google Chrome (or Microsoft Edge on Windows)`,
  );
  ```

  Update the one launcher test that asserts this message, `resolveChromePath throws a clear error naming every path checked when none exist`, in `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.test.ts`:

  ```ts
  test('resolveChromePath throws a clear error naming every path checked when none exist', () => {
    assert.throws(
      () => resolveChromePath(['/a', '/b'], { existsSync: () => false }),
      /no Chrome executable found \(checked: \/a, \/b\) — install Google Chrome \(or Microsoft Edge on Windows\)/,
    );
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts
  ```

  Expected: all pass.

- [ ] **Step 11: Run the new `JOBBUNNY_CHROME_PATH` test and see it pass.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts
  ```

  Expected: all pass, including the new `JOBBUNNY_CHROME_PATH` test.

- [ ] **Step 12: Run the full existing `launcher.test.ts` suite to confirm no regression** — every pre-existing test that passes an explicit `candidates` array (e.g. `launchChrome resolves the chrome path, builds argv, spawns detached+unref, and returns the pid`, which passes `candidates: ['/only/chrome']` and does not set `env`) must still pass unchanged, because with no `JOBBUNNY_CHROME_PATH` set, tier 2 (`configured` = the explicit `candidates` array) still wins.

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts
  ```

  Expected: `# pass` count equal to the pre-Task-3 count plus 1 (the new test).

- [ ] **Step 13: Commit.**

  ```bash
  git add src/adapters/browser/cdp-chrome/discovery/resolve.ts src/adapters/browser/cdp-chrome/discovery/resolve.test.ts src/adapters/browser/cdp-chrome/discovery/index.ts src/adapters/browser/cdp-chrome/launcher.ts src/adapters/browser/cdp-chrome/launcher.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cdp-chrome): wire three-tier Chrome candidate resolution into launchChrome

  resolveCandidates layers JOBBUNNY_CHROME_PATH (env override) over the
  configured settings['cdp-chrome'].candidates array over the per-OS
  chromeCandidates table — first non-empty tier wins and replaces the
  others rather than merging. A configured array is now guaranteed to
  survive intact, the specific regression this closes.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: Chrome pid file

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/ownership/pidfile.ts`
- Create: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts`
- Create: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/ownership/index.ts`

**Placement rationale:** Same two-implementation-file cap as Task 2 forces this into its own subfolder rather than a fourth top-level file in `cdp-chrome/` (D12). `ownership/` mirrors `ops/scheduling/run_lock.ts`'s injectable-deps shape (`RunLockDeps` → `ChromePidfileDeps`), but is placed under `adapters/browser/cdp-chrome/` rather than `ops/` because it is Chrome-process-specific state co-located with the rest of the Chrome lifecycle code, not general run-scheduling infrastructure — `ops/` code may not be imported by `adapters/` (`adapters-only-ports-core`), so this could not live in `ops/` anyway without breaking the boundary the launcher/provider consume it across.

**Interfaces:**

Consumes: nothing from other tasks.

Produces (exact signatures, per task brief):
```ts
export interface ChromePidfile {
  pid: number;
  port: number;
  startedAt: string; // ISO 8601
}

export interface ChromePidfileDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  unlinkSync(path: string): void;
  pidIsAlive(pid: number): boolean;
  now(): Date;
}

export function chromePidfilePath(userDataDir: string): string;
export function readChromePidfile(userDataDir: string, deps: ChromePidfileDeps): ChromePidfile | undefined;
export function writeChromePidfile(userDataDir: string, info: ChromePidfile, deps: ChromePidfileDeps): void;
export function clearChromePidfile(userDataDir: string, deps: ChromePidfileDeps): void;
export function defaultChromePidfileDeps(): ChromePidfileDeps;
```

- [ ] **Step 1: Write the failing test for `chromePidfilePath`.**

  Create `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { join } from 'node:path';
  import { test } from 'node:test';
  import { chromePidfilePath } from './pidfile.ts';

  // Built via node:path's join (not a forward-slash literal) so the expected
  // value tracks whatever separator the host platform's join() actually
  // produces — chromePidfilePath is implemented with join too, so on the
  // windows-latest CI runner (Task 1) both sides emit backslashes alike.
  const PIDFILE_PATH = join('/repo/.chrome-debug', '.jobbunny-chrome.json');

  test('chromePidfilePath joins userDataDir with the fixed pidfile name', () => {
    assert.equal(chromePidfilePath('/repo/.chrome-debug'), PIDFILE_PATH);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `pidfile.ts` does not exist yet.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected failure: `Cannot find module '.../ownership/pidfile.ts'`.

- [ ] **Step 3: Write the full implementation (all five functions plus the two interfaces at once — they are small and interdependent).**

  Create `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/ownership/pidfile.ts`:

  ```ts
  import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';

  /**
   * Chrome pid file (D12) — `<userDataDir>/.jobbunny-chrome.json`, written
   * at launchChrome's spawn time, read/self-healed by provider.ts's
   * launch() to decide reuse/recycle/launch without shelling out to
   * lsof/ps. Mirrors ops/scheduling/run_lock.ts's injectable-deps shape
   * (RunLockDeps -> ChromePidfileDeps) so every caller — including the
   * real default — supplies fs/process deps explicitly and tests never
   * touch a real filesystem or process table.
   */
  export interface ChromePidfile {
    pid: number;
    port: number;
    startedAt: string; // ISO 8601
  }

  export interface ChromePidfileDeps {
    existsSync(path: string): boolean;
    readFileSync(path: string): string;
    writeFileSync(path: string, data: string): void;
    unlinkSync(path: string): void;
    pidIsAlive(pid: number): boolean;
    now(): Date;
  }

  const PIDFILE_NAME = '.jobbunny-chrome.json';

  export function chromePidfilePath(userDataDir: string): string {
    return join(userDataDir, PIDFILE_NAME);
  }

  function isChromePidfileShape(value: unknown): value is ChromePidfile {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Partial<ChromePidfile>;
    return (
      typeof v.pid === 'number' &&
      typeof v.port === 'number' &&
      typeof v.startedAt === 'string' &&
      Number.isFinite(Date.parse(v.startedAt))
    );
  }

  /**
   * Reads the pid file, self-healing as it goes: a dead recorded pid, or an
   * unparseable file, is deleted and treated as "no pid file" — never left
   * in place for a later reader to trust. A missing file is simply
   * undefined, with no delete attempt (nothing to delete).
   */
  export function readChromePidfile(
    userDataDir: string,
    deps: ChromePidfileDeps,
  ): ChromePidfile | undefined {
    const path = chromePidfilePath(userDataDir);
    if (!deps.existsSync(path)) return undefined;

    let raw: string;
    try {
      raw = deps.readFileSync(path);
    } catch {
      // Unreadable for a reason other than "missing" (e.g. a permission
      // error, or a race with a concurrent writer) — don't guess at
      // whether it's safe to delete; just report "unknown".
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      deps.unlinkSync(path);
      return undefined;
    }

    if (!isChromePidfileShape(parsed)) {
      deps.unlinkSync(path);
      return undefined;
    }

    if (!deps.pidIsAlive(parsed.pid)) {
      deps.unlinkSync(path);
      return undefined;
    }

    return parsed;
  }

  export function writeChromePidfile(
    userDataDir: string,
    info: ChromePidfile,
    deps: ChromePidfileDeps,
  ): void {
    deps.writeFileSync(chromePidfilePath(userDataDir), JSON.stringify(info));
  }

  export function clearChromePidfile(userDataDir: string, deps: ChromePidfileDeps): void {
    const path = chromePidfilePath(userDataDir);
    if (!deps.existsSync(path)) return;
    deps.unlinkSync(path);
  }

  function hasErrorCode(err: unknown, code: string): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === code
    );
  }

  /** Real (non-test) ChromePidfileDeps — node:fs sync calls plus
   * process.kill(pid, 0) for liveness, mirroring
   * run_lock.ts's defaultRunLockDeps.pidIsAlive exactly: ESRCH means dead,
   * EPERM (owned by someone else) still means alive, anything else assumed
   * alive (fail toward not treating a live process as dead). */
  export function defaultChromePidfileDeps(): ChromePidfileDeps {
    return {
      existsSync: (path) => existsSync(path),
      readFileSync: (path) => readFileSync(path, 'utf8'),
      writeFileSync: (path, data) => writeFileSync(path, data, 'utf8'),
      unlinkSync: (path) => unlinkSync(path),
      pidIsAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return !hasErrorCode(err, 'ESRCH');
        }
      },
      now: () => new Date(),
    };
  }
  ```

  Note: age is deliberately NOT computed here — per this task's brief, the caller computes `deps.now().getTime() - Date.parse(info.startedAt)` itself; there is no `chromePidfileAgeMs` or similar exported.

- [ ] **Step 4: Run the Step 1 test and see it pass.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected: `# pass 1`.

- [ ] **Step 5: Write and pass the round-trip write/read test.**

  Append to `pidfile.test.ts`:

  ```ts
  import type { ChromePidfile, ChromePidfileDeps } from './pidfile.ts';
  import {
    clearChromePidfile,
    readChromePidfile,
    writeChromePidfile,
  } from './pidfile.ts';

  function fakeDeps(overrides: Partial<ChromePidfileDeps> = {}): ChromePidfileDeps {
    return {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error('no file');
      },
      writeFileSync: () => {},
      unlinkSync: () => {},
      pidIsAlive: () => true,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      ...overrides,
    };
  }

  test('writeChromePidfile writes the info as JSON to chromePidfilePath', () => {
    const writeCalls: Array<{ path: string; data: string }> = [];
    const deps = fakeDeps({
      writeFileSync: (path, data) => {
        writeCalls.push({ path, data });
      },
    });
    const info: ChromePidfile = {
      pid: 4242,
      port: 9222,
      startedAt: '2026-07-27T12:00:00.000Z',
    };
    writeChromePidfile('/repo/.chrome-debug', info, deps);

    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0]?.path, PIDFILE_PATH);
    assert.deepEqual(JSON.parse(writeCalls[0]?.data ?? '{}'), info);
  });

  test('round-trip: readChromePidfile returns exactly what writeChromePidfile wrote, for a live pid', () => {
    let stored: string | undefined;
    const deps = fakeDeps({
      existsSync: () => stored !== undefined,
      writeFileSync: (_path, data) => {
        stored = data;
      },
      readFileSync: () => {
        if (stored === undefined) throw new Error('no file');
        return stored;
      },
      pidIsAlive: () => true,
    });
    const info: ChromePidfile = {
      pid: 4242,
      port: 9222,
      startedAt: '2026-07-27T12:00:00.000Z',
    };
    writeChromePidfile('/repo/.chrome-debug', info, deps);

    const result = readChromePidfile('/repo/.chrome-debug', deps);
    assert.deepEqual(result, info);
  });
  ```

  (Move the `import type { ChromePidfile, ChromePidfileDeps }` / `import { clearChromePidfile, readChromePidfile, writeChromePidfile }` lines to the top of the file alongside the existing `chromePidfilePath` import, rather than inline mid-file — shown split here only for step-by-step narration.)

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected: `# pass 3`.

- [ ] **Step 6: Write and pass the self-heal-on-dead-pid test.**

  Append to `pidfile.test.ts`:

  ```ts
  test('readChromePidfile self-heals: deletes the file and returns undefined when the recorded pid is dead', () => {
    const unlinkCalls: string[] = [];
    const deps = fakeDeps({
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({ pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' }),
      unlinkSync: (path) => {
        unlinkCalls.push(path);
      },
      pidIsAlive: () => false,
    });

    const result = readChromePidfile('/repo/.chrome-debug', deps);

    assert.equal(result, undefined);
    assert.deepEqual(unlinkCalls, [PIDFILE_PATH]);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected: `# pass 4`.

- [ ] **Step 7: Write and pass the unparseable-JSON test.**

  Append to `pidfile.test.ts`:

  ```ts
  test('readChromePidfile deletes an unparseable file and returns undefined', () => {
    const unlinkCalls: string[] = [];
    const deps = fakeDeps({
      existsSync: () => true,
      readFileSync: () => '{ not valid json',
      unlinkSync: (path) => {
        unlinkCalls.push(path);
      },
    });

    const result = readChromePidfile('/repo/.chrome-debug', deps);

    assert.equal(result, undefined);
    assert.deepEqual(unlinkCalls, [PIDFILE_PATH]);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected: `# pass 5`.

- [ ] **Step 8: Write and pass the unparseable-`startedAt`-guard test — a well-formed-but-for-`startedAt` pid file self-heals the same way as invalid JSON.**

  Append to `pidfile.test.ts`:

  ```ts
  test('readChromePidfile deletes a pid file with an unparseable startedAt and returns undefined', () => {
    const unlinkCalls: string[] = [];
    const deps = fakeDeps({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ pid: 4242, port: 9222, startedAt: 'garbage' }),
      unlinkSync: (path) => {
        unlinkCalls.push(path);
      },
    });

    const result = readChromePidfile('/repo/.chrome-debug', deps);

    assert.equal(result, undefined);
    assert.deepEqual(unlinkCalls, [PIDFILE_PATH]);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected: `# pass 6`.

- [ ] **Step 9: Write and pass the missing-file test — the specific "no `unlinkSync` call" assertion.**

  Append to `pidfile.test.ts`:

  ```ts
  test('readChromePidfile returns undefined without calling unlinkSync when the file is missing', () => {
    const unlinkCalls: string[] = [];
    const deps = fakeDeps({
      existsSync: () => false,
      unlinkSync: (path) => {
        unlinkCalls.push(path);
      },
    });

    const result = readChromePidfile('/repo/.chrome-debug', deps);

    assert.equal(result, undefined);
    assert.deepEqual(unlinkCalls, []);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected: `# pass 7`.

- [ ] **Step 10: Write and pass the `clearChromePidfile` tests.**

  Append to `pidfile.test.ts`:

  ```ts
  test('clearChromePidfile unlinks an existing pidfile', () => {
    const unlinkCalls: string[] = [];
    const deps = fakeDeps({
      existsSync: () => true,
      unlinkSync: (path) => {
        unlinkCalls.push(path);
      },
    });

    clearChromePidfile('/repo/.chrome-debug', deps);

    assert.deepEqual(unlinkCalls, [PIDFILE_PATH]);
  });

  test('clearChromePidfile is a no-op when no pidfile exists', () => {
    const unlinkCalls: string[] = [];
    const deps = fakeDeps({
      existsSync: () => false,
      unlinkSync: (path) => {
        unlinkCalls.push(path);
      },
    });

    clearChromePidfile('/repo/.chrome-debug', deps);

    assert.deepEqual(unlinkCalls, []);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected: `# pass 9`.

- [ ] **Step 11: Write and pass a smoke test for `defaultChromePidfileDeps`.**

  Append to `pidfile.test.ts` (add `defaultChromePidfileDeps` to the existing import from `./pidfile.ts`):

  ```ts
  test('defaultChromePidfileDeps builds working deps against the real fs/process', () => {
    const deps = defaultChromePidfileDeps();
    assert.equal(typeof deps.existsSync, 'function');
    assert.equal(typeof deps.readFileSync, 'function');
    assert.equal(typeof deps.writeFileSync, 'function');
    assert.equal(typeof deps.unlinkSync, 'function');
    assert.equal(deps.pidIsAlive(process.pid), true);
    assert.ok(deps.now() instanceof Date);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  ```

  Expected: `# pass 10`.

- [ ] **Step 12: Create the module's public surface.**

  Create `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/ownership/index.ts`:

  ```ts
  export type { ChromePidfile, ChromePidfileDeps } from './pidfile.ts';
  export {
    chromePidfilePath,
    clearChromePidfile,
    defaultChromePidfileDeps,
    readChromePidfile,
    writeChromePidfile,
  } from './pidfile.ts';
  ```

- [ ] **Step 13: Commit.**

  ```bash
  git add src/adapters/browser/cdp-chrome/ownership/pidfile.ts src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts src/adapters/browser/cdp-chrome/ownership/index.ts
  git commit -m "$(cat <<'EOF'
  feat(cdp-chrome): add a self-healing Chrome pid file

  .chrome-debug/.jobbunny-chrome.json records { pid, port, startedAt } at
  spawn time. readChromePidfile self-heals on read: a dead recorded pid,
  or an unparseable file, is deleted and reported as absent rather than
  trusted. Mirrors run_lock.ts's injectable-deps shape.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: Launcher writes the Chrome pid file

**Files:**
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.test.ts`

**Interfaces:**

Consumes: `ChromePidfile`, `ChromePidfileDeps`, `writeChromePidfile`, `clearChromePidfile`, `defaultChromePidfileDeps` from Task 4 (`./ownership/index.ts`).

Produces: no new exported functions — this task adds an optional `pidfileDeps` field to `LauncherDeps`, optional `userDataDir`/`pidfileDeps` fields to `KillDeps`, and changes the internal behavior of `launchChrome` and `killChrome`. `resolveListenerPid`, `getProcessAgeMs`, `parseEtimeToMs`, and `ProcessProbeDeps` are untouched and remain exported from `launcher.ts` — they are deleted in Task 6, once `provider.ts`'s rewire removes their last caller.

**This task is purely additive by design.** Nothing is deleted here: `launchChrome` and `killChrome` gain pid-file behavior, but `resolveListenerPid`, `getProcessAgeMs`, and `parseEtimeToMs` keep existing — and keep their tests — because `provider.ts` still calls them, and deleting them in this task would leave the repo not compiling. They, and `provider.ts`'s rewire onto the pid file, are Task 6's job, done only once the rewire removes their last caller. This task ends with its own `npm run check`, green, to prove the add-then-remove split actually works: each half independently shippable, not a half-finished deletion.

- [ ] **Step 1: Write the failing test proving `launchChrome` writes the pid file after spawn.**

  Append to `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.test.ts`:

  ```ts
  import type { ChromePidfile, ChromePidfileDeps } from './ownership/index.ts';

  function fakePidfileDepsForLauncher(): {
    deps: ChromePidfileDeps;
    written: ChromePidfile[];
    unlinked: number;
  } {
    const written: ChromePidfile[] = [];
    let unlinked = 0;
    const deps: ChromePidfileDeps = {
      existsSync: () => written.length > 0,
      readFileSync: () => JSON.stringify(written[written.length - 1]),
      writeFileSync: (_path, data) => {
        written.push(JSON.parse(data) as ChromePidfile);
      },
      unlinkSync: () => {
        unlinked += 1;
      },
      pidIsAlive: () => true,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    };
    return { deps, written, unlinked };
  }

  test('launchChrome writes the Chrome pid file immediately after spawn returns a pid', () => {
    const { deps, written } = fakePidfileDepsForLauncher();
    launchChrome(
      { port: 9333, userDataDir: '/repo/.chrome-debug', candidates: ['/only/chrome'] },
      {
        existsSync: (path) => path === '/only/chrome',
        spawn: () => ({ pid: 4242, unref: () => {} }),
        pidfileDeps: deps,
      },
    );
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], {
      pid: 4242,
      port: 9333,
      startedAt: '2026-07-27T12:00:00.000Z',
    });
  });
  ```

- [ ] **Step 2: Run it and see it fail** — `launchChrome` has no `pidfileDeps` option and never writes a pid file yet, so `written.length` is `0`.

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts
  ```

  Expected failure: `AssertionError [ERR_ASSERTION]` on `assert.equal(written.length, 1)` — actual `0`.

- [ ] **Step 3: Add the pid-file write to `launchChrome` and the pid-file clear to `killChrome`.**

  In `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.ts`:

  Add the pid-file import:

  ```ts
  import {
    type ChromePidfileDeps,
    clearChromePidfile,
    defaultChromePidfileDeps,
    writeChromePidfile,
  } from './ownership/index.ts';
  import { resolveCandidates } from './discovery/index.ts';
  ```

  Add `pidfileDeps?: ChromePidfileDeps;` to `LauncherDeps`:

  ```ts
  export interface LauncherDeps {
    existsSync?: FsDeps['existsSync'];
    spawn?: SpawnFn;
    env?: NodeJS.ProcessEnv;
    rmSync?: SessionClearFsDeps['rmSync'];
    readFileSync?: SessionClearFsDeps['readFileSync'];
    writeFileSync?: SessionClearFsDeps['writeFileSync'];
    /** Injectable Chrome pid-file deps — used by launchChrome to write, and
     * by killChrome to clear, .chrome-debug/.jobbunny-chrome.json. Default:
     * defaultChromePidfileDeps(). */
    pidfileDeps?: ChromePidfileDeps;
  }
  ```

  Update `launchChrome` to write the pid file after spawn:

  ```ts
  export function launchChrome(
    options: LaunchChromeOptions,
    deps: LauncherDeps = {},
  ): ChromeProcessHandle {
    const { port, userDataDir = DEFAULT_USER_DATA_DIR, candidates } = options;
    const existsSync = deps.existsSync ?? nodeExistsSync;
    const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
    const env = deps.env ?? process.env;
    if (env[SESSION_CLEAR_SKIP_ENV] !== '1') {
      const sessionClearDeps: SessionClearFsDeps = {
        existsSync,
        rmSync: deps.rmSync ?? nodeRmSync,
        readFileSync: deps.readFileSync ?? nodeReadFileSync,
        writeFileSync: deps.writeFileSync ?? nodeWriteFileSync,
      };
      clearSessionState(userDataDir, sessionClearDeps);
    }
    const resolvedCandidates = resolveCandidates(process.platform, env, candidates);
    const chromePath = resolveChromePath(resolvedCandidates, { existsSync });
    const argv = buildLaunchArgv({ port, userDataDir });
    const child = spawn(chromePath, argv, { detached: true, stdio: 'ignore' });
    child.unref();
    if (child.pid != null) {
      const pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();
      writeChromePidfile(
        userDataDir,
        { pid: child.pid, port, startedAt: pidfileDeps.now().toISOString() },
        pidfileDeps,
      );
    }
    return { pid: child.pid };
  }
  ```

  Update `KillDeps` and `killChrome` to clear the pid file once the process is confirmed dead (both the "already gone on SIGTERM" early-return path and the normal end-of-function path count as confirmed dead):

  ```ts
  export interface KillDeps {
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    env?: NodeJS.ProcessEnv;
    isAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    graceMs?: number;
    pollIntervalMs?: number;
    settleMs?: number;
    /** userDataDir whose Chrome pid file should be cleared once this
     * process is confirmed dead. Default: DEFAULT_USER_DATA_DIR. */
    userDataDir?: string;
    /** Injectable Chrome pid-file deps for the same clear. Default:
     * defaultChromePidfileDeps(). */
    pidfileDeps?: ChromePidfileDeps;
  }

  export async function killChrome(
    pid: number | undefined,
    deps: KillDeps = {},
  ): Promise<boolean> {
    const env = deps.env ?? process.env;
    if (env.JOBBUNNY_KEEP_BROWSER === '1') return false;
    if (pid == null) return false;
    const kill = deps.kill ?? process.kill;
    const isAlive = deps.isAlive ?? defaultIsAlive;
    const sleep = deps.sleep ?? defaultSleep;
    const graceMs = deps.graceMs ?? 5000;
    const pollIntervalMs = deps.pollIntervalMs ?? 250;
    const settleMs = deps.settleMs ?? 500;
    const userDataDir = deps.userDataDir ?? DEFAULT_USER_DATA_DIR;
    const pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();

    try {
      kill(pid, 'SIGTERM');
    } catch {
      clearChromePidfile(userDataDir, pidfileDeps);
      return false; // already gone
    }

    const deadline = Date.now() + graceMs;
    let stillAlive = true;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      if (!isAlive(pid)) {
        stillAlive = false;
        break;
      }
    }

    if (stillAlive) {
      try {
        kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
      await sleep(settleMs);
    }

    clearChromePidfile(userDataDir, pidfileDeps);
    return true;
  }
  ```

- [ ] **Step 4: Run the Step 1 test and see it pass.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts
  ```

  Expected: the new pid-file-write test passes. Every other pre-existing test in the file — including the `resolveListenerPid`/`getProcessAgeMs`/`parseEtimeToMs` tests — continues to pass unchanged; nothing was deleted in this task.

- [ ] **Step 5: Add the pid-file-clear-on-kill test, then run the full suite.**

  Append to `launcher.test.ts`:

  ```ts
  test('killChrome clears the Chrome pid file once the process is confirmed dead', async () => {
    const { deps, written } = fakePidfileDepsForLauncher();
    written.push({ pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' });
    let unlinked = 0;
    const clearingDeps: ChromePidfileDeps = {
      ...deps,
      unlinkSync: () => {
        unlinked += 1;
      },
    };
    await killChrome(4242, {
      env: {},
      kill: () => {},
      isAlive: () => false,
      sleep: instantSleep,
      pidfileDeps: clearingDeps,
    });
    assert.equal(unlinked, 1);
  });
  ```

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts
  ```

  Expected: `# fail 0` — every existing test in the file continues to pass (the `resolveListenerPid`/`getProcessAgeMs`/`parseEtimeToMs` tests included, untouched by this task), plus the two new pid-file tests: write-on-launch (Step 1) and clear-on-kill (here).

- [ ] **Step 6: Commit.**

  ```bash
  git add src/adapters/browser/cdp-chrome/launcher.ts src/adapters/browser/cdp-chrome/launcher.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cdp-chrome): launcher writes the Chrome pid file at spawn time

  launchChrome writes .jobbunny-chrome.json ({ pid, port, startedAt })
  immediately after spawn() returns a pid; killChrome clears it once the
  process is confirmed dead. Purely additive — resolveListenerPid,
  getProcessAgeMs, and parseEtimeToMs are untouched here; provider.ts is
  rewired onto the pid file and the shell-outs are deleted in a
  follow-up commit, once their last caller is gone.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 7: Run the full gate.**

  ```bash
  node -v   # confirm >= 24; if not: source ~/.nvm/nvm.sh && nvm use 24
  npm run check
  ```

  Expected: `typecheck`, `lint`, `boundaries`, and `test` all pass with zero failures — proving this task is independently shippable even though `resolveListenerPid`/`getProcessAgeMs`/`parseEtimeToMs` and `provider.ts`'s lsof/ps-based ownership check are still in place, untouched, alongside the new pid-file writes.

---

### Task 6: Provider reads ownership from the pid file; delete the shell-outs

**Files:**
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/provider.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/provider.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/index.ts`

**Interfaces:**

Consumes: the pid-file-writing `launchChrome`, the pid-file-clearing `killChrome`, and `KillDeps`'s `userDataDir`/`pidfileDeps` fields, all from Task 5 (`./launcher.ts`); `ChromePidfile`, `ChromePidfileDeps`, `readChromePidfile`, `defaultChromePidfileDeps` from Task 4 (`./ownership/index.ts`).

Produces: no new exported functions — this task deletes `resolveListenerPid`, `getProcessAgeMs`, `parseEtimeToMs`, and the now-unused `ProcessProbeDeps` interface from `launcher.ts`, and changes the internal shape of `CdpChromeProviderDeps`, `CdpChromeProvider.launch`/`close`.

**Structural note, not just a behavior change.** This task also contains a deliberate refactor: `provider.ts`'s `launch()` is restructured to extract a shared private `spawnAndConnect(cdpUrl, ctx)` helper, so the "unreachable → launch" and "recycle" branches stop each carrying their own copy of the spawn/connect/kill-on-failure sequence. This is intentional — two copies of a kill-on-failure path drift apart over time — and a reviewer should expect a structural change here in addition to the behavior change (ownership now read from the pid file instead of `lsof`/`ps`).

CRITICAL ordering constraint: the provider rewire (Steps 1–6 below) lands BEFORE the deletions (Steps 7–9) — `provider.ts` currently calls `resolveListenerPid` and `getProcessAgeMs`, so deleting them first would leave the repo not compiling.

- [ ] **Step 1: Rewrite `provider.ts`'s imports, `CdpChromeProviderDeps`, `decideChromeAction` call site, and `launch()`/`close()` to consult the pid file instead of `lsof`/`ps`.**

  In `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/provider.ts`:

  Replace the top import block:

  ```ts
  import { chromium } from 'playwright';
  import { sleep } from '../../../core/async/index.ts';
  import type {
    BrowserHandle,
    BrowserProvider,
    PageHandle,
  } from '../../../ports/browser.ts';
  import type { RunContext } from '../../../ports/context.ts';
  import type { ChromeProcessHandle, KillDeps, LauncherDeps } from './launcher.ts';
  import {
    CHROME_MAX_AGE_MS,
    DEFAULT_CDP_PORT,
    DEFAULT_USER_DATA_DIR,
    killChrome as defaultKillChrome,
    launchChrome as defaultLaunchChrome,
  } from './launcher.ts';
  import {
    type ChromePidfileDeps,
    defaultChromePidfileDeps,
    readChromePidfile,
  } from './ownership/index.ts';
  ```

  Update the class-level doc comment's ownership paragraph (replace the `resolveListenerPid`/`getProcessAgeMs`/lsof description):

  ```ts
  /**
   * CdpChromeProvider — BrowserProvider implementation over a real, locally
   * spawned Chrome attached via CDP (playwright's connectOverCDP). Every
   * PageHandle method is deadline-bound: a hanging playwright call rejects at
   * opts.timeoutMs even if playwright itself never honors the abort signal
   * (2026-07-17 lesson — see src/pipeline/runner/guard.ts for the same race
   * pattern, replicated locally here since adapters must not import pipeline/).
   *
   * Chrome lifecycle mirrors scripts/lib/browser.js's proven, hard-won
   * ensureChrome pattern, now sourced from a pid file rather than lsof/ps
   * (D12):
   *  - launch() ALWAYS probes CDP reachability (bounded fetch of
   *    `${cdpUrl}/json/version`) before spawning. Unreachable => spawn fresh
   *    (action 'launch'). Reachable + no live pid file (.chrome-debug/
   *    .jobbunny-chrome.json) => this Chrome was not spawned by this
   *    codebase — attach (reuse), never recycle, never kill; this check
   *    happens BEFORE decideChromeAction is consulted at all. Reachable +
   *    live pid file => age is Date.now() - pidfile.startedAt, fed into
   *    decideChromeAction exactly as before: 'reuse' if <= maxAgeMs,
   *    'recycle' (kill via the pid file's pid, then respawn) if older.
   *  - The pid file is written by launchChrome itself, from the pid
   *    spawn() returned — never re-resolved via an OS tool. close() kills
   *    exactly that pid (the one this run spawned, recorded at handle
   *    construction time), not a freshly re-resolved "whoever is listening
   *    on the port now".
   *  - NEVER call browser.close() on a CDP-attached connection (a
   *    live-incident lesson there: closing the Browser object over CDP can
   *    take the whole Chrome process down with it, an unreliable way to end a
   *    session) — release the playwright-side reference and separately kill
   *    the OS process by its recorded pid (killChrome), unless
   *    JOBBUNNY_KEEP_BROWSER=1.
   *  - close() only ever kills a Chrome process THIS run spawned (action
   *    launch, or recycle's kill-then-respawn). A reused instance (action
   *    reuse, or a stale-but-not-recycled one) is the user's own persistent
   *    session — close() drops the CDP connection reference and leaves it
   *    running (2026-07-25 incident: a reuse run's close() killed the user's
   *    logged-in Chrome mid-session).
   */
  ```

  Replace `CdpChromeProviderDeps`'s `resolveListenerPid`/`getProcessAgeMs` fields with `pidfileDeps`:

  ```ts
  export interface CdpChromeProviderDeps {
    connect?: ConnectFn;
    launchChrome?: (
      options: { port: number; userDataDir?: string; candidates?: readonly string[] },
      deps?: LauncherDeps,
    ) => ChromeProcessHandle;
    killChrome?: (pid: number | undefined, deps?: KillDeps) => boolean | Promise<boolean>;
    port?: number;
    userDataDir?: string;
    candidates?: readonly string[];
    launcherFsDeps?: LauncherDeps;
    killEnv?: NodeJS.ProcessEnv;
    connectRetryMs?: number;
    connectMaxWaitMs?: number;
    cdpReachable?: CdpReachableFn;
    /** Injectable Chrome pid-file deps (D12) — used to read
     * .chrome-debug/.jobbunny-chrome.json when deciding reuse/recycle/launch,
     * and passed through to killChrome so close()/recycle clear it after a
     * kill. Injectable so tests never touch the real filesystem or process
     * table. Default: defaultChromePidfileDeps(). */
    pidfileDeps?: ChromePidfileDeps;
    maxAgeMs?: number;
    recycleIfOld?: boolean;
    reachabilityTimeoutMs?: number;
  }
  ```

  Update the class fields/constructor — remove `resolveListenerPidFn`/`getProcessAgeMsFn`, add `pidfileDeps`:

  ```ts
  export class CdpChromeProvider implements BrowserProvider {
    readonly name = 'cdp-chrome';

    private readonly connect: ConnectFn;
    private readonly launchChromeFn: NonNullable<CdpChromeProviderDeps['launchChrome']>;
    private readonly killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>;
    private readonly port: number;
    private readonly userDataDir: string;
    private readonly candidates: readonly string[] | undefined;
    private readonly launcherFsDeps: LauncherDeps | undefined;
    private readonly killEnv: NodeJS.ProcessEnv | undefined;
    private readonly connectRetryMs: number;
    private readonly connectMaxWaitMs: number;
    private readonly cdpReachableFn: CdpReachableFn;
    private readonly pidfileDeps: ChromePidfileDeps;
    private readonly maxAgeMs: number;
    private readonly recycleIfOld: boolean;
    private readonly reachabilityTimeoutMs: number;

    constructor(deps: CdpChromeProviderDeps = {}) {
      this.connect = deps.connect ?? defaultConnect;
      this.launchChromeFn = deps.launchChrome ?? defaultLaunchChrome;
      this.killChromeFn = deps.killChrome ?? defaultKillChrome;
      this.port = deps.port ?? DEFAULT_CDP_PORT;
      this.userDataDir = deps.userDataDir ?? DEFAULT_USER_DATA_DIR;
      this.candidates = deps.candidates;
      this.launcherFsDeps = deps.launcherFsDeps;
      this.killEnv = deps.killEnv;
      this.connectRetryMs = deps.connectRetryMs ?? 250;
      this.connectMaxWaitMs = deps.connectMaxWaitMs ?? 10_000;
      this.cdpReachableFn = deps.cdpReachable ?? defaultCdpReachable;
      this.pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();
      this.maxAgeMs = deps.maxAgeMs ?? CHROME_MAX_AGE_MS;
      this.recycleIfOld = deps.recycleIfOld ?? true;
      this.reachabilityTimeoutMs = deps.reachabilityTimeoutMs ?? 2000;
    }
  ```

  (Note `userDataDir`'s field type narrows from `string | undefined` to `string` — it was always assigned `deps.userDataDir ?? DEFAULT_USER_DATA_DIR` even before this task, so this is a type-only tidy-up alongside the larger change, made so `launch()`/`close()` below don't need a repeated `?? DEFAULT_USER_DATA_DIR` fallback.)

  Rewrite `launch()`:

  ```ts
    async launch(ctx: RunContext): Promise<BrowserHandle> {
      const cdpUrl = `http://127.0.0.1:${this.port}`;
      const version = await this.cdpReachableFn(cdpUrl, {
        timeoutMs: this.reachabilityTimeoutMs,
      });

      if (!version) {
        return this.spawnAndConnect(cdpUrl, ctx);
      }

      const pidfile = readChromePidfile(this.userDataDir, this.pidfileDeps);
      if (!pidfile) {
        // Reachable, no live pid file: not ours — attach, never recycle,
        // never kill (D12/§7.4's "strengthens ownsProcess" branch, applied
        // BEFORE decideChromeAction is consulted at all).
        const browser = await this.connectWithRetry(cdpUrl, ctx);
        return new CdpChromeBrowserHandle(
          cdpUrl,
          browser,
          ctx,
          undefined,
          this.killChromeFn,
          this.killEnv,
          this.userDataDir,
          this.pidfileDeps,
          false,
        );
      }

      const ageMs = Date.now() - Date.parse(pidfile.startedAt);
      const action = decideChromeAction({ reachable: true, ageMs, maxAgeMs: this.maxAgeMs });

      if (action === 'reuse' || !this.recycleIfOld) {
        const browser = await this.connectWithRetry(cdpUrl, ctx);
        return new CdpChromeBrowserHandle(
          cdpUrl,
          browser,
          ctx,
          undefined,
          this.killChromeFn,
          this.killEnv,
          this.userDataDir,
          this.pidfileDeps,
          false,
        );
      }

      // action === 'recycle' && recycleIfOld.
      ctx.logger.info('cdp-chrome: recycling a reachable-but-stale Chrome instance', {
        ageMs,
        maxAgeMs: this.maxAgeMs,
        port: this.port,
      });
      await this.killChromeFn(pidfile.pid, {
        env: this.killEnv,
        userDataDir: this.userDataDir,
        pidfileDeps: this.pidfileDeps,
      });
      return this.spawnAndConnect(cdpUrl, ctx);
    }

    /** Spawns a fresh Chrome, connects, and — on connect failure — kills the
     * freshly-spawned pid before rethrowing (never leaks the spawned
     * process). Shared by the unreachable branch and the recycle branch of
     * launch(). */
    private async spawnAndConnect(cdpUrl: string, ctx: RunContext): Promise<BrowserHandle> {
      const proc = this.launchChromeFn(
        { port: this.port, userDataDir: this.userDataDir, candidates: this.candidates },
        this.launcherFsDeps,
      );
      let browser: CdpBrowser;
      try {
        browser = await this.connectWithRetry(cdpUrl, ctx);
      } catch (err) {
        await this.killChromeFn(proc.pid, {
          env: this.killEnv,
          userDataDir: this.userDataDir,
          pidfileDeps: this.pidfileDeps,
        });
        throw err;
      }
      return new CdpChromeBrowserHandle(
        cdpUrl,
        browser,
        ctx,
        proc.pid,
        this.killChromeFn,
        this.killEnv,
        this.userDataDir,
        this.pidfileDeps,
        // This process just spawned (or recycled-then-spawned) the Chrome
        // instance behind proc.pid — it owns the process and close() must
        // kill it.
        true,
      );
    }
  ```

  Rewrite `CdpChromeBrowserHandle` — `close()` now kills the pid recorded at construction time, never re-resolves via any OS tool:

  ```ts
  class CdpChromeBrowserHandle implements BrowserHandle {
    readonly cdpUrl: string;
    private readonly browser: CdpBrowser;
    private readonly ctx: RunContext;
    /** The pid this run spawned (undefined when it merely attached to an
     * already-running, unowned Chrome — ownsProcess is false in that case,
     * so close() never reads this field). */
    private readonly pid: number | undefined;
    private readonly killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>;
    private readonly killEnv: NodeJS.ProcessEnv | undefined;
    private readonly userDataDir: string;
    private readonly pidfileDeps: ChromePidfileDeps;
    /** True only when THIS process spawned the Chrome instance behind this
     * handle (launch, or recycle's kill-then-respawn) — false when it merely
     * attached to one already running (reuse, or a recycle-eligible instance
     * kept alive because recycleIfOld is false). close() must only ever kill
     * a process this run is responsible for; killing a reused Chrome tore
     * down the user's own logged-in session out from under them
     * (2026-07-25 incident). */
    private readonly ownsProcess: boolean;

    constructor(
      cdpUrl: string,
      browser: CdpBrowser,
      ctx: RunContext,
      pid: number | undefined,
      killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>,
      killEnv: NodeJS.ProcessEnv | undefined,
      userDataDir: string,
      pidfileDeps: ChromePidfileDeps,
      ownsProcess: boolean,
    ) {
      this.cdpUrl = cdpUrl;
      this.browser = browser;
      this.ctx = ctx;
      this.pid = pid;
      this.killChromeFn = killChromeFn;
      this.killEnv = killEnv;
      this.userDataDir = userDataDir;
      this.pidfileDeps = pidfileDeps;
      this.ownsProcess = ownsProcess;
    }

    async newPage(): Promise<PageHandle> {
      const page = await this.openPage();
      return new CdpChromePageHandle(page, this.ctx);
    }

    private async openPage(): Promise<CdpPage> {
      const existing = this.browser.contexts?.()[0];
      if (existing) return existing.newPage();
      if (this.browser.newContext) {
        const created = await this.browser.newContext();
        return created.newPage();
      }
      return this.browser.newPage();
    }

    async close(): Promise<void> {
      // Deliberately NOT calling browser.close() here — see the class-level
      // doc comment / scripts/lib/browser.js's disconnect() for why. Only the
      // OS-level process kill actually ends the session.
      if (!this.ownsProcess) return;
      await this.killChromeFn(this.pid, {
        env: this.killEnv,
        userDataDir: this.userDataDir,
        pidfileDeps: this.pidfileDeps,
      });
    }
  }
  ```

  Leave `CdpChromePageHandle`, `raceWithTimeout`, `withDeadline`, `toAbortError`, `connectWithRetry`, `defaultConnect`, `defaultCdpReachable`, and `decideChromeAction` unchanged — none of them touch pid resolution.

- [ ] **Step 2: Run typecheck to confirm `provider.ts` now compiles.**

  ```bash
  npx tsc --noEmit -p tsconfig.json
  ```

  Expected: `provider.ts` compiles clean; remaining errors (if any) are all in `provider.test.ts`, fixed next.

- [ ] **Step 3: Rewrite `provider.test.ts`'s `resolveListenerPid`/`getProcessAgeMs`-based tests to use a fake `pidfileDeps`, covering the five brief-mandated scenarios.**

  Add a `fakePidfileDeps` helper near the top of `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/provider.test.ts` (after the existing `fakeLauncher` helper), and add `import type { ChromePidfileDeps } from './ownership/index.ts';`:

  ```ts
  /** Builds a ChromePidfileDeps fake. `exists: false` (or omitting `pid`)
   * models "no live pid file" (the reachable-but-unowned case); otherwise
   * `pid`/`ageMs` model a live pid file recorded `ageMs` ago relative to a
   * fixed `now`. */
  function fakePidfileDeps(
    overrides: { pid?: number; ageMs?: number; exists?: boolean } = {},
  ): ChromePidfileDeps {
    const exists = overrides.exists ?? overrides.pid !== undefined;
    const pid = overrides.pid ?? 0;
    const ageMs = overrides.ageMs ?? 0;
    const now = new Date('2026-07-27T12:00:00.000Z');
    const startedAt = new Date(now.getTime() - ageMs).toISOString();
    return {
      existsSync: () => exists,
      readFileSync: () => JSON.stringify({ pid, port: 9222, startedAt }),
      writeFileSync: () => {},
      unlinkSync: () => {},
      pidIsAlive: () => true,
      now: () => now,
    };
  }
  ```

  Replace the test `'launch() reuses an already-reachable, fresh Chrome instead of spawning'` with:

  ```ts
  test('launch() reuses a reachable Chrome whose pid-file-recorded age is under maxAgeMs', async () => {
    const launcher = fakeLauncher(4242);
    const connectUrls: string[] = [];
    const provider = new CdpChromeProvider({
      launchChrome: launcher.launchChrome,
      cdpReachable: async () => ({ Browser: 'Chrome/999' }),
      pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 60_000 }), // 1 minute old
      connect: async (url) => {
        connectUrls.push(url);
        return { newPage: async () => fakePage() } satisfies CdpBrowser;
      },
    });

    const handle = await provider.launch(fakeCtx());

    assert.equal(
      launcher.calls.length,
      0,
      'expected no spawn when Chrome is already reachable and fresh',
    );
    assert.deepEqual(connectUrls, ['http://127.0.0.1:9222']);
    assert.equal(handle.cdpUrl, 'http://127.0.0.1:9222');
  });
  ```

  Replace the test `'launch() spawns Chrome when the port is not reachable'` with:

  ```ts
  test('launch() spawns Chrome when the port is not reachable, consulting no pid file', async () => {
    const launcher = fakeLauncher(4242);
    let pidfileReadAttempted = false;
    const provider = new CdpChromeProvider({
      launchChrome: launcher.launchChrome,
      cdpReachable: async () => null,
      pidfileDeps: {
        ...fakePidfileDeps(),
        existsSync: () => {
          pidfileReadAttempted = true;
          return false;
        },
      },
      connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
    });

    await provider.launch(fakeCtx());

    assert.equal(launcher.calls.length, 1, 'expected a spawn when nothing is reachable');
    assert.equal(
      pidfileReadAttempted,
      false,
      'expected the pid file never to be consulted when unreachable',
    );
  });
  ```

  Replace the test `'launch() recycles (kills, then spawns) a reachable Chrome older than maxAgeMs'` with:

  ```ts
  test('launch() recycles a reachable Chrome whose pid-file-recorded age is over maxAgeMs', async () => {
    const launcher = fakeLauncher(7777);
    const killCalls: Array<number | undefined> = [];
    const provider = new CdpChromeProvider({
      launchChrome: launcher.launchChrome,
      cdpReachable: async () => ({ Browser: 'Chrome/999' }),
      pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 25 * 60 * 60 * 1000 }), // 25h
      killChrome: (pid) => {
        killCalls.push(pid);
        return true;
      },
      connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
    });

    const handle = await provider.launch(fakeCtx());

    assert.deepEqual(killCalls, [5555]);
    assert.equal(launcher.calls.length, 1, 'expected a fresh spawn after recycling');
    assert.equal(handle.cdpUrl, 'http://127.0.0.1:9222');
  });
  ```

  Replace the test `'launch() reuses a stale Chrome without recycling when recycleIfOld is false'` with:

  ```ts
  test('launch() reuses a stale-pid-file Chrome without recycling when recycleIfOld is false', async () => {
    const launcher = fakeLauncher(7777);
    const killCalls: Array<number | undefined> = [];
    const provider = new CdpChromeProvider({
      launchChrome: launcher.launchChrome,
      cdpReachable: async () => ({ Browser: 'Chrome/999' }),
      pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 25 * 60 * 60 * 1000 }),
      recycleIfOld: false,
      killChrome: (pid) => {
        killCalls.push(pid);
        return true;
      },
      connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
    });

    await provider.launch(fakeCtx());

    assert.deepEqual(killCalls, []);
    assert.equal(launcher.calls.length, 0, 'expected no spawn when recycling is disabled');
  });
  ```

  DELETE these two now-obsolete tests entirely (they assert lsof-hand-off-stub behavior and unresolvable-listener-pid behavior that no longer exists in the pid-file model — the pid file records exactly the pid `spawn()` returned, so there is no "stub pid vs real listener pid" distinction left to test):
  - `test('close() kills the ACTUAL pid listening on the port, not the spawned hand-off-stub pid', ...)`
  - `test('launch() treats an unresolvable age (resolveListenerPid returns undefined) as fresh — reuse, not recycle', ...)`

- [ ] **Step 4: Add the two brief-mandated new tests: reachable-with-no-pid-file (`ownsProcess === false`), and the close()-kills-the-fresh-spawn-not-the-old-pid recycle regression.**

  Append to `provider.test.ts`:

  ```ts
  test('launch() attaches (reuse) to a reachable Chrome with no live pid file, and close() never kills it (ownsProcess === false)', async () => {
    const launcher = fakeLauncher(4242);
    const killCalls: unknown[] = [];
    const provider = new CdpChromeProvider({
      launchChrome: launcher.launchChrome,
      cdpReachable: async () => ({ Browser: 'Chrome/999' }),
      pidfileDeps: fakePidfileDeps({ exists: false }),
      killChrome: (pid) => {
        killCalls.push(pid);
        return true;
      },
      connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
    });

    const handle = await provider.launch(fakeCtx());
    await handle.close();

    assert.equal(launcher.calls.length, 0, 'expected no spawn — Chrome is already reachable');
    assert.deepEqual(killCalls, [], 'expected close() never to kill an unowned Chrome');
  });

  test('close() kills the freshly-respawned Chrome pid after a recycle — this run owns the new process, not the old one', async () => {
    const launcher = fakeLauncher(8888);
    const killCalls: unknown[] = [];
    const provider = new CdpChromeProvider({
      launchChrome: launcher.launchChrome,
      cdpReachable: async () => ({ Browser: 'Chrome/999' }),
      pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 25 * 60 * 60 * 1000 }), // stale -> recycle
      killChrome: (pid) => {
        killCalls.push(pid);
        return true;
      },
      connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
    });

    const handle = await provider.launch(fakeCtx());
    killCalls.length = 0; // clear the recycle-time kill (pre-spawn, pid 5555); isolate close()'s own kill
    await handle.close();

    assert.deepEqual(
      killCalls,
      [8888],
      'expected close() to kill the freshly-spawned pid this run owns, not the old listener pid',
    );
  });
  ```

- [ ] **Step 5: Convert every remaining pre-existing test that still references `resolveListenerPid`/`getProcessAgeMs` using the same mechanical substitution — `resolveListenerPid: () => X` + `getProcessAgeMs: () => Y` becomes `pidfileDeps: fakePidfileDeps({ pid: X, ageMs: Y })` (or `fakePidfileDeps({ exists: false })` when the old fake returned `undefined`).**

  Apply this exact substitution to the remaining tests still using the old fields (`close() kills the spawned Chrome pid by default`, `close() respects JOBBUNNY_KEEP_BROWSER=1 by delegating the decision to killChrome`, `close() never calls a browser.close()-style API`, `launch() kills the spawned Chrome pid when connect gives up`, `close() is a no-op for a reused Chrome`, `close() is a no-op for a stale-but-kept Chrome when recycleIfOld is false`, `close() kills a fresh spawn (action launch)`, `close() respects JOBBUNNY_KEEP_BROWSER=1 after a recycle-then-spawn`, `newPage() opens the page in the existing persistent context, not a fresh one`, `newPage() falls back to newContext() when the browser reports no contexts`). Worked example — before/after for `'close() kills the spawned Chrome pid by default (JOBBUNNY_KEEP_BROWSER unset)'`:

  Before:
  ```ts
  test('close() kills the spawned Chrome pid by default (JOBBUNNY_KEEP_BROWSER unset)', async () => {
    const killCalls: Array<{ pid: number | undefined; deps: KillDeps | undefined }> = [];
    const provider = new CdpChromeProvider({
      launchChrome: fakeLauncher(4242).launchChrome,
      cdpReachable: async () => null,
      resolveListenerPid: () => undefined,
      connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
      killChrome: (pid, deps) => {
        killCalls.push({ pid, deps });
        return true;
      },
      killEnv: {},
    });

    const handle = await provider.launch(fakeCtx());
    await handle.close();

    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0]?.pid, 4242);
    assert.deepEqual(killCalls[0]?.deps, { env: {} });
  });
  ```

  After (`cdpReachable` stays `async () => null` — this is the "not reachable" branch, so `pidfileDeps` is never consulted and the field can be dropped entirely; `killCalls[0]?.deps` now also carries `userDataDir`/`pidfileDeps`, so assert only the fields under test):

  ```ts
  test('close() kills the spawned Chrome pid by default (JOBBUNNY_KEEP_BROWSER unset)', async () => {
    const killCalls: Array<{ pid: number | undefined; deps: KillDeps | undefined }> = [];
    const provider = new CdpChromeProvider({
      launchChrome: fakeLauncher(4242).launchChrome,
      cdpReachable: async () => null,
      connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
      killChrome: (pid, deps) => {
        killCalls.push({ pid, deps });
        return true;
      },
      killEnv: {},
    });

    const handle = await provider.launch(fakeCtx());
    await handle.close();

    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0]?.pid, 4242);
    assert.deepEqual(killCalls[0]?.deps?.env, {});
  });
  ```

  For every test in the "reachable" branch of the list above (i.e. `cdpReachable: async () => ({ Browser: 'Chrome/999' })`), add `pidfileDeps: fakePidfileDeps({ pid: <old resolveListenerPid return value>, ageMs: <old getProcessAgeMs return value> })` (or `fakePidfileDeps({ exists: false })` where the old fake had `resolveListenerPid: () => undefined`), and delete the `resolveListenerPid`/`getProcessAgeMs` lines. For every test in the "not reachable" branch (`cdpReachable: async () => null`), simply delete the `resolveListenerPid`/`getProcessAgeMs` lines with no replacement — the pid file is never consulted on that path.

- [ ] **Step 6: Run the full `provider.test.ts` suite and fix any remaining compile/assertion errors from the mechanical conversion.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/provider.test.ts
  ```

  Expected: `# fail 0`.

- [ ] **Step 7: Delete `resolveListenerPid`, `getProcessAgeMs`, `parseEtimeToMs`, and `ProcessProbeDeps` from `launcher.ts` — safe now that `provider.ts` (Steps 1–6 above) no longer calls them.**

  In `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/launcher.ts`:

  Remove these blocks entirely (they have no remaining caller once `getProcessAgeMs` is gone, per this task's brief):
  - `export interface ProcessProbeDeps { ... }`
  - `export function resolveListenerPid(...) { ... }`
  - `export function parseEtimeToMs(etime: string): number { ... }`
  - `export function getProcessAgeMs(...) { ... }`

  Remove the now-unused `execFileSync as nodeExecFileSync` from the top `node:child_process` import (only `spawn as nodeSpawn` remains).

  Update the module's top doc comment — replace the `lsof`/`ps` description with the pid-file model:

  ```ts
  /**
   * Chrome-over-CDP process lifecycle: find the local Chrome binary, build its
   * launch argv, spawn/probe/age/kill it. Ported from scripts/lib/browser.js's
   * know-how (CHROME_BIN, CDP_PORT flag, .chrome-debug/ user-data-dir,
   * always-kill-unless-JOBBUNNY_KEEP_BROWSER, SIGTERM-then-poll-then-SIGKILL).
   * fs/spawn/kill/sleep are all injectable so tests never touch a real
   * filesystem, process, or timer.
   *
   * Ownership (D12): launchChrome writes `.jobbunny-chrome.json` (see
   * ownership/pidfile.ts) into userDataDir immediately after spawn() returns
   * a pid — { pid, port, startedAt }. killChrome clears that file once the
   * process is confirmed dead. This is the pid liveness/age is now decided
   * from, replacing the old lsof/ps-based resolveListenerPid/getProcessAgeMs
   * (deleted): the pid file records exactly the pid THIS codebase spawned,
   * so ownership is "is that exact pid alive and recorded", not "whoever the
   * OS reports is listening on the port right now".
   *
   * launchChrome also runs clearSessionState immediately before spawning
   * (2026-07-25 follow-up): buildLaunchArgv's --restore-last-session=false
   * etc. cut restored CDP targets from ~97 to 4, but didn't fully suppress
   * restore — command-line flags alone weren't enough, one of the 4 was a
   * LinkedIn tab with a live reCAPTCHA widget. clearSessionState deletes the
   * on-disk Sessions/tab-restore state and normalizes Preferences' exit
   * state so Chrome has nothing left to restore from, while leaving
   * cookies/storage/Login Data/the profile dir itself completely untouched —
   * see its own doc comment for the full auth-vs-session split.
   */
  ```

- [ ] **Step 8: Delete the now-obsolete `resolveListenerPid`/`parseEtimeToMs`/`getProcessAgeMs` tests from `launcher.test.ts`, then run the full suite.**

  Remove the import of `getProcessAgeMs`, `parseEtimeToMs`, `resolveListenerPid` from the top `import { ... } from './launcher.ts';` block, and delete these test blocks entirely:
  - `test('resolveListenerPid returns the pid lsof reports listening on the port', ...)`
  - `test('resolveListenerPid returns undefined when nothing is listening (lsof throws)', ...)`
  - `test('resolveListenerPid returns undefined on blank lsof output', ...)`
  - `test('parseEtimeToMs parses MM:SS', ...)`
  - `test('parseEtimeToMs parses HH:MM:SS', ...)`
  - `test('parseEtimeToMs parses DD-HH:MM:SS', ...)`
  - `test('parseEtimeToMs parses bare SS', ...)`
  - `test('getProcessAgeMs converts ps etime output to milliseconds', ...)`
  - `test('getProcessAgeMs returns null when the pid cannot be inspected', ...)`

  Add `import type { ChromePidfile, ChromePidfileDeps } from './ownership/index.ts';` and the `fakePidfileDepsForLauncher` helper (added in Task 5) plus its pid-file test permanently into the file (they're already there from Task 5 — this step is only about REMOVING the nine obsolete tests above, not re-adding anything).

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts
  ```

  Expected: `# fail 0` — the pid-file-write test and the pid-file-clear-on-kill test (both added in Task 5) still pass; the nine deleted tests no longer run.

- [ ] **Step 9: Delete `resolveListenerPid`/`getProcessAgeMs` from the `cdp-chrome/index.ts` public surface, add the pid-file re-exports needed for external typing.**

  Edit `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/index.ts`:

  ```ts
  export { type CdpReachableCheckDeps, cdpReachableCheck } from './check.ts';
  export type {
    ChromeProcessHandle,
    FsDeps,
    KillDeps,
    LaunchArgvOptions,
    LaunchChromeOptions,
    LauncherDeps,
    SpawnFn,
  } from './launcher.ts';
  export {
    buildLaunchArgv,
    CHROME_MAX_AGE_MS,
    CHROME_PATH_CANDIDATES,
    DEFAULT_CDP_PORT,
    DEFAULT_USER_DATA_DIR,
    killChrome,
    launchChrome,
    resolveChromePath,
  } from './launcher.ts';
  export type {
    CdpBrowser,
    CdpChromeProviderDeps,
    CdpPage,
    CdpReachableFn,
    ChromeLaunchAction,
    ConnectFn,
  } from './provider.ts';
  export {
    CdpChromeProvider,
    decideChromeAction,
    defaultCdpReachable,
  } from './provider.ts';
  export type { ChromePidfile, ChromePidfileDeps } from './ownership/index.ts';
  export { defaultChromePidfileDeps } from './ownership/index.ts';
  export { chromeCandidates, resolveCandidates } from './discovery/index.ts';
  ```

  Note: `ProcessProbeDeps` is removed from the launcher re-export list — it no longer exists after Step 7's deletion. `KillDeps` was already re-exported from `index.ts` before this task and stays in the list unchanged.

- [ ] **Step 10: Run the full `launcher.test.ts` + `provider.test.ts` + `discovery` + `ownership` suites together, then confirm the shell-out grep is clean.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/launcher.test.ts src/adapters/browser/cdp-chrome/provider.test.ts src/adapters/browser/cdp-chrome/discovery/candidates.test.ts src/adapters/browser/cdp-chrome/discovery/resolve.test.ts src/adapters/browser/cdp-chrome/ownership/pidfile.test.ts
  grep -rn "lsof\|-o etime\|resolveListenerPid\|getProcessAgeMs\|parseEtimeToMs" src/adapters/browser/cdp-chrome/
  ```

  Expected: all tests pass; the `grep` returns nothing (empty output, exit code 1).

- [ ] **Step 11: Commit.**

  ```bash
  git add src/adapters/browser/cdp-chrome/launcher.ts src/adapters/browser/cdp-chrome/launcher.test.ts src/adapters/browser/cdp-chrome/provider.ts src/adapters/browser/cdp-chrome/provider.test.ts src/adapters/browser/cdp-chrome/index.ts
  git commit -m "$(cat <<'EOF'
  refactor(cdp-chrome): read ownership from the pid file; delete the shell-outs

  provider.ts's launch() now short-circuits to reuse-without-recycling
  BEFORE decideChromeAction is consulted when a reachable Chrome has no
  live pid file — we can only recycle what we have a record of spawning.
  Extracts a shared spawnAndConnect(cdpUrl, ctx) helper so the
  unreachable-launch and recycle branches stop carrying separate copies
  of the spawn/connect/kill-on-failure sequence. resolveListenerPid,
  getProcessAgeMs, and parseEtimeToMs (no remaining caller) are deleted.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

  Residual risk, stated explicitly (D12/§7.6): if the pid file is lost while its Chrome keeps running, that Chrome is permanently in the "reachable, no pid file" bucket — attached to, never recycled, potentially accumulating memory. This is the same posture as the pre-existing `ownsProcess` guard's `false` case (a reused Chrome, kept alive on purpose): the pipeline never kills something it can't prove it owns. This STRENGTHENS the existing guard rather than weakening it.

- [ ] **Step 12: Run the full gate.**

  ```bash
  node -v   # confirm >= 24; if not: source ~/.nvm/nvm.sh && nvm use 24
  npm run check
  ```

  Expected: `typecheck`, `lint`, `boundaries`, and `test` all pass with zero failures — proving this task is independently shippable on its own.

---

### Task 7: Doctor check for an unowned Chrome

**Files:**
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/check.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/check.test.ts`

**Interfaces:**

Consumes: `readChromePidfile`, `defaultChromePidfileDeps`, `ChromePidfileDeps` from Task 4 (`./ownership/index.ts`); `DEFAULT_USER_DATA_DIR` from `./launcher.ts` (already exported, unchanged).

Produces: no new exported function — `cdpReachableCheck`'s `CdpReachableCheckDeps` gains two new optional fields (`userDataDir`, `pidfileDeps`); its `run()` behavior gains a new warning branch.

- [ ] **Step 1: Write the failing test for the new warn-on-unowned-Chrome branch.**

  Append to `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/check.test.ts`:

  ```ts
  import type { ChromePidfileDeps } from './ownership/index.ts';

  function fakePidfileDeps(hasPidfile: boolean): ChromePidfileDeps {
    return {
      existsSync: () => hasPidfile,
      readFileSync: () =>
        JSON.stringify({ pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' }),
      writeFileSync: () => {},
      unlinkSync: () => {},
      pidIsAlive: () => true,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    };
  }

  test('cdpReachableCheck: warn (not red) when reachable but no live pid file exists — names the accumulation risk', async () => {
    const check = cdpReachableCheck({
      reachable: async () => ({ Browser: 'Chrome' }),
      port: 9222,
      pidfileDeps: fakePidfileDeps(false),
    });
    const finding = await check.run();
    assert.equal(finding.status, 'warn');
    assert.match(finding.detail, /never recycle/);
    assert.match(finding.detail, /accumulate memory/);
  });
  ```

- [ ] **Step 2: Run it and see it fail.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/check.test.ts
  ```

  Expected failure: `TS2353: Object literal may only specify known properties, and 'pidfileDeps' does not exist in type 'CdpReachableCheckDeps'` (or, if run without a typecheck gate, an assertion failure — `finding.status` is `'ok'`, not `'warn'`, because today's `run()` never checks a pid file at all).

- [ ] **Step 3: Extend `CdpReachableCheckDeps` and `run()` to consult the pid file when reachable.**

  Rewrite `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/check.ts`:

  ```ts
  import type { DoctorCheck, DoctorFinding } from '../../../ports/doctor.ts';
  import { DEFAULT_CDP_PORT, DEFAULT_USER_DATA_DIR } from './launcher.ts';
  import {
    type ChromePidfileDeps,
    defaultChromePidfileDeps,
    readChromePidfile,
  } from './ownership/index.ts';
  import type { CdpReachableFn } from './provider.ts';

  /**
   * cdpReachableCheck (P8, extended D12/§7.5) — DoctorCheck probing whether a
   * Chrome instance is already listening on the CDP port, and — if so —
   * whether Job Bunny recorded a pid file for it. Mirrors
   * `adapters/lanes/linkedin/inventory.ts`'s factory-returns-`{ name, run() }`
   * shape; `run()` never throws.
   *
   * Reuses `provider.ts`'s existing `CdpReachableFn` (cdpUrl in, parsed
   * `/json/version` body or null out) rather than inventing a new signature.
   * Status is `warn`, never `red`, in every non-ok case: `launch()` spawns
   * Chrome on demand when it's unreachable, so an idle-time miss isn't a
   * run-blocking failure — and a reachable-but-unowned Chrome isn't broken
   * either, it's just outside the recycle policy (D12/§7.6's accepted
   * residual risk).
   */
  export interface CdpReachableCheckDeps {
    reachable: CdpReachableFn;
    port?: number;
    /** userDataDir whose Chrome pid file is consulted once CDP is found
     * reachable. Default: DEFAULT_USER_DATA_DIR. */
    userDataDir?: string;
    /** Injectable Chrome pid-file deps. Default: defaultChromePidfileDeps(). */
    pidfileDeps?: ChromePidfileDeps;
  }

  export function cdpReachableCheck(deps: CdpReachableCheckDeps): DoctorCheck {
    const name = 'cdp-reachable';
    const port = deps.port ?? DEFAULT_CDP_PORT;
    const userDataDir = deps.userDataDir ?? DEFAULT_USER_DATA_DIR;
    const pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();
    return {
      name,
      async run(): Promise<DoctorFinding> {
        try {
          const version = await deps.reachable(`http://127.0.0.1:${port}`);
          if (!version) {
            return {
              check: name,
              status: 'warn',
              detail: `Chrome CDP not reachable on :${port} — will be launched on demand`,
            };
          }
          const pidfile = readChromePidfile(userDataDir, pidfileDeps);
          if (!pidfile) {
            return {
              check: name,
              status: 'warn',
              detail: `Chrome CDP reachable on :${port} but no Job Bunny pid file found — Job Bunny will attach to but never recycle this browser, and a Chrome it did not start may accumulate memory`,
            };
          }
          return { check: name, status: 'ok', detail: `CDP reachable on :${port}` };
        } catch {
          return {
            check: name,
            status: 'warn',
            detail: `Chrome CDP not reachable on :${port} — will be launched on demand`,
          };
        }
      },
    };
  }
  ```

- [ ] **Step 4: Run the Step 1 test and see it pass.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/check.test.ts
  ```

  Expected: the new warn-on-unowned test passes. Every PRE-EXISTING test that asserts `status === 'ok'` now FAILS, because `defaultChromePidfileDeps()` reads the real (nonexistent-in-CI, and in this sandbox) `.chrome-debug/.jobbunny-chrome.json` and reports no pid file, downgrading `'ok'` to `'warn'`.

- [ ] **Step 5: Update the pre-existing tests to inject a live-pid-file `pidfileDeps` so the `'ok'` case stays `'ok'`.**

  Rewrite `/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/check.test.ts` in full:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import type { ChromePidfileDeps } from './ownership/index.ts';
  import { cdpReachableCheck } from './check.ts';

  function fakePidfileDeps(hasPidfile: boolean): ChromePidfileDeps {
    return {
      existsSync: () => hasPidfile,
      readFileSync: () =>
        JSON.stringify({ pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' }),
      writeFileSync: () => {},
      unlinkSync: () => {},
      pidIsAlive: () => true,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    };
  }

  test('cdpReachableCheck: ok when reachable resolves truthy and a live pid file exists', async () => {
    const check = cdpReachableCheck({
      reachable: async () => ({ Browser: 'Chrome' }),
      port: 9222,
      pidfileDeps: fakePidfileDeps(true),
    });
    const finding = await check.run();
    assert.equal(check.name, 'cdp-reachable');
    assert.equal(finding.status, 'ok');
    assert.match(finding.detail, /:9222/);
  });

  test('cdpReachableCheck: warn when reachable resolves null', async () => {
    const check = cdpReachableCheck({
      reachable: async () => null,
      port: 9222,
      pidfileDeps: fakePidfileDeps(true),
    });
    const finding = await check.run();
    assert.equal(finding.status, 'warn');
    assert.match(finding.detail, /will be launched on demand/);
  });

  test('cdpReachableCheck: warn when reachable throws', async () => {
    const check = cdpReachableCheck({
      reachable: async () => {
        throw new Error('boom');
      },
      pidfileDeps: fakePidfileDeps(true),
    });
    const finding = await check.run();
    assert.equal(finding.status, 'warn');
  });

  test('cdpReachableCheck: defaults to DEFAULT_CDP_PORT when no port is injected', async () => {
    const check = cdpReachableCheck({
      reachable: async () => ({ Browser: 'Chrome' }),
      pidfileDeps: fakePidfileDeps(true),
    });
    const finding = await check.run();
    assert.match(finding.detail, /:9222/);
  });

  test('cdpReachableCheck: never throws even when reachable rejects', async () => {
    const check = cdpReachableCheck({
      reachable: async () => {
        throw new Error('boom');
      },
      pidfileDeps: fakePidfileDeps(true),
    });
    await assert.doesNotReject(() => check.run());
  });

  test('cdpReachableCheck: warn (not red) when reachable but no live pid file exists — names the accumulation risk', async () => {
    const check = cdpReachableCheck({
      reachable: async () => ({ Browser: 'Chrome' }),
      port: 9222,
      pidfileDeps: fakePidfileDeps(false),
    });
    const finding = await check.run();
    assert.equal(finding.status, 'warn');
    assert.match(finding.detail, /never recycle/);
    assert.match(finding.detail, /accumulate memory/);
  });
  ```

- [ ] **Step 6: Run the full suite and see it pass.**

  ```bash
  node --test src/adapters/browser/cdp-chrome/check.test.ts
  ```

  Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 7: Commit.**

  ```bash
  git add src/adapters/browser/cdp-chrome/check.ts src/adapters/browser/cdp-chrome/check.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cdp-chrome): warn in doctor when CDP is reachable but unowned

  cdpReachableCheck now consults the Chrome pid file once CDP is found
  reachable: a live pid file is ok, a missing one is a warn (not red)
  naming the accepted D12 residual risk — Job Bunny will attach to but
  never recycle a Chrome it did not start.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 8: Run the full gate.**

  ```bash
  node -v   # confirm >= 24; if not: source ~/.nvm/nvm.sh && nvm use 24
  npm run check
  ```

  Expected: `typecheck`, `lint`, `boundaries`, and `test` all pass with zero failures. This is the same gate CI's `test` (now `check` + `test`) workflow runs.

---

## Self-review (performed while drafting this plan)

1. **Coverage check** — D11 (three-tier resolution, per-OS table) is covered by Tasks 2–3; D12 (pid file replacing `lsof`/`ps`, self-heal, recycle-only-what-we-own, doctor warning) is covered by Tasks 4–7; D17 (CI matrix, hermetic tests) is covered by Task 1, with Tasks 2–7 each keeping every new/modified test on the existing injectable-deps pattern so the hermetic property holds. §7 of the spec maps 1:1 onto Tasks 2 (§7.2), 3 (§7.1/§7.2 resolution order), 4 (§7.3), 5–6 (§7.4), 7 (§7.5/§7.6). No gap found.
2. **Placeholder scan** — searched this plan for "TBD", "TODO", "appropriate", "as needed", "similar to". Found and fixed: an early draft of Task 6 Step 5 used "apply the same conversion to the rest" without a worked example — replaced with a full before/after code diff plus the exact substitution rule and the explicit list of test names it applies to. No other hits remain.
3. **Type consistency** — `chromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[]`, `resolveCandidates(platform, env, configured?): string[]`, `ChromePidfile { pid, port, startedAt }`, `ChromePidfileDeps { existsSync, readFileSync, writeFileSync, unlinkSync, pidIsAlive, now }`, `readChromePidfile`, `writeChromePidfile`, `clearChromePidfile`, `chromePidfilePath`, `defaultChromePidfileDeps` are spelled and typed identically in every task that references them (Tasks 2–7), matching the "Produces exactly" blocks given in the brief verbatim.

## Definition of done

- `npm run check` (typecheck + lint + boundaries + test) is green locally.
- The CI matrix from Task 1 is green on all three OSes (`check (macos-latest)`, `check (ubuntu-latest)`, `check (windows-latest)`, plus the wrapper `test` job) on the first push carrying this plan's commits.
- `grep -rn "lsof\|-o etime" src/` returns nothing.
- `package.json`'s `dependencies` block is unchanged — still exactly `@notionhq/client`, `dotenv`, `playwright`, `zod`.
- Spec §12/D23 documentation updates ship with the scheduling-daemon plan's Task 13, not this plan.
