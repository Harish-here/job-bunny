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
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/seed.ts',
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
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
