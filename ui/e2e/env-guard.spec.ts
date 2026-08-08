/**
 * Regression coverage for the wizard-suite `.env` clobber (fix-round
 * finding: `wizard.spec.ts` was submitting real-looking secret values
 * through Step 5, and `PUT /api/secrets/:key` upserts them straight into
 * the data home's `.env` — which `playwright.config.ts` pins to the REPO
 * ROOT via `JOBBUNNY_HOME`, i.e. the same `.env` a developer's real
 * `NOTION_TOKEN`/`TELEGRAM_BOT_TOKEN` live in).
 *
 * Two tests:
 *  - a pure-fs check of `snapshotEnvFile`/`restoreEnvFile` against a
 *    throwaway temp directory (fast, no server involved);
 *  - a live check that calls the REAL running board server's
 *    `PUT /api/secrets/NOTION_TOKEN` (the exact endpoint
 *    `Step5Extras.tsx`'s `putSecret` calls) against the repo root, proving
 *    the underlying mutation is real, then proving `restoreEnvFile` puts
 *    the repo root's `.env` back byte-for-byte. This is the same
 *    protection `playwright.config.ts`'s `globalSetup`/its returned
 *    teardown gives the whole suite — this test exercises it directly, on
 *    demand, rather than only implicitly at the end of a full run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot, restoreEnvFile, snapshotEnvFile } from './env-guard';

test('snapshotEnvFile + restoreEnvFile round-trip an existing .env byte-for-byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-env-guard-'));
  try {
    const target = path.join(dir, '.env');
    const original = 'NOTION_TOKEN=real_token_do_not_lose_me\n';
    writeFileSync(target, original);

    const snapshot = snapshotEnvFile(dir);
    writeFileSync(target, 'NOTION_TOKEN=clobbered_by_a_test\n');
    expect(readFileSync(target, 'utf8')).not.toBe(original);

    restoreEnvFile(dir, snapshot);
    expect(readFileSync(target, 'utf8')).toBe(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshotEnvFile + restoreEnvFile round-trip "no .env existed before"', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-env-guard-'));
  try {
    const target = path.join(dir, '.env');
    const snapshot = snapshotEnvFile(dir);
    expect(snapshot).toBeNull();

    writeFileSync(target, 'NOTION_TOKEN=should_not_survive\n');
    restoreEnvFile(dir, snapshot);
    expect(existsSync(target)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'a real PUT /api/secrets/NOTION_TOKEN against the repo-root-pinned server really ' +
    'mutates .env, and restoreEnvFile puts it back exactly — proof the guard neutralizes ' +
    'the same real code path the wizard UI calls',
  async ({ page }) => {
    const root = repoRoot();
    const before = snapshotEnvFile(root);

    const res = await page.request.put('/api/secrets/NOTION_TOKEN', {
      data: { value: 'env_guard_probe_do_not_keep_me' },
    });
    expect(res.ok()).toBe(true);

    const afterWrite = snapshotEnvFile(root);
    // Proves the write really happened through the real server code path
    // (`writeSecret`, src/cli/wire/board.ts) — this is the vulnerability the
    // finding reported, reproduced against the real running server, not a
    // synthetic fixture.
    expect(afterWrite?.toString('utf8')).toContain('env_guard_probe_do_not_keep_me');

    restoreEnvFile(root, before);
    const afterRestore = snapshotEnvFile(root);
    const beforeBytes = before === null ? null : before.toString('utf8');
    const afterBytes = afterRestore === null ? null : afterRestore.toString('utf8');
    expect(afterBytes).toBe(beforeBytes);
  },
);
