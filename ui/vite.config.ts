/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Dev server proxies API calls to a locally running `jobbunny board`
// (default port 4646). Production build is served BY that server from
// ui/dist, same origin — no proxy involved.
// NOTE: this file sits outside tsconfig's include on purpose — the
// vitest/config reference helps editors only; Vite loads it with its own
// pipeline, and svelte-check never validates it. Don't "fix" the include.
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:4646' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
