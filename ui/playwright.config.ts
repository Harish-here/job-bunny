import { defineConfig } from '@playwright/test';

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
    url: 'http://127.0.0.1:4199/api/profiles',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
