import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Repo root, resolved from this config file's own location (not
// process.cwd(), which varies by how `ui:e2e` is invoked) — `ui/` sits one
// level below the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Port 4199 is deliberate (not ephemeral): the seeded board server and
// baseURL must agree cross-platform, and CI runs one suite at a time. If
// it's busy locally, free it or override with PW_PORT if you add that
// plumbing later.

// These spec files read-modify-write the SAME shared `profiles/rajni`
// config docs (`profile.json`/`filter.json`) through the board API and
// each restores its own captured `original` in a `finally` — at default
// parallelism two of these files' workers interleave their writes and one
// file's restore clobbers another's in-flight edit (QA B11). Grepped via
// `grep -rl "request.put(\`/api/profiles/rajni/config"` /
// `grep -rl "request.put('/api/profiles/rajni/config"` over `ui/e2e/*.spec.ts`
// — `settings-landing.spec.ts` and `settings-rule-preview.spec.ts` only
// read/stub and are correctly excluded; `wizard.spec.ts` and
// `profile-lifecycle.spec.ts` write to their own throwaway profiles, not
// the shared `rajni` docs, and are also excluded. The `shared-docs`
// project below runs these serially (`fullyParallel: false`) and the
// `ui:e2e` script additionally pins it to one worker, so no two of these
// files ever run concurrently; every other spec file keeps the default
// parallel project.
const SHARED_DOC_SPECS = [
  'operate.spec.ts',
  'settings.spec.ts',
  'settings-delivery.spec.ts',
  'settings-fetching.spec.ts',
  'settings-housekeeping.spec.ts',
  'settings-roles-companies.spec.ts',
  'settings-save-model.spec.ts',
  'settings-where-you-work.spec.ts',
];

export default defineConfig({
  testDir: './e2e',
  // `env-guard.ts` runs alongside the DB seeder and snapshots the repo
  // root's `.env` before the suite, restoring it byte-for-byte afterward
  // via the teardown function it returns (Playwright's own convention) —
  // see that file's doc comment for why.
  globalSetup: ['./e2e/seed.ts', './e2e/env-guard.ts'],
  use: { baseURL: 'http://127.0.0.1:4199' },
  webServer: {
    command: 'node src/cli/main.ts board --port 4199',
    cwd: '..',
    // JOBBUNNY_HOME must point at the repo root so the board server finds
    // the committed profiles/rajni fixture — without it the spawned
    // process falls back to the real OS home, which has no jobbunny home
    // at all in CI (Playwright merges this into process.env, it doesn't
    // replace it).
    env: { JOBBUNNY_HOME: repoRoot },
    url: 'http://127.0.0.1:4199/api/profiles',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'shared-docs',
      testMatch: SHARED_DOC_SPECS,
      fullyParallel: false,
      use: { browserName: 'chromium' },
    },
    {
      name: 'default',
      testIgnore: SHARED_DOC_SPECS,
      use: { browserName: 'chromium' },
    },
  ],
});
