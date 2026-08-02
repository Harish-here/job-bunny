import { defineConfig } from '@playwright/test';

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
