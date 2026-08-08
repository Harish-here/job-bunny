/**
 * Snapshot/restore guard for the repo root's `.env` — belt-and-braces
 * protection for the e2e suite (see `wizard.spec.ts`'s "happy path"
 * comment and `env-guard.spec.ts`). `playwright.config.ts` pins the
 * spawned board server's `JOBBUNNY_HOME` to the repo root, so ANY spec
 * that calls the real `PUT /api/secrets/:key` endpoint (`writeSecret`,
 * `src/cli/wire/board.ts`) upserts into the SAME `.env` a developer's real
 * `NOTION_TOKEN`/`TELEGRAM_BOT_TOKEN` live in. `wizard.spec.ts`'s
 * happy-path test no longer submits real secret values (see its own
 * comment) — this module is the second, independent line of defense: it
 * runs as one of `playwright.config.ts`'s `globalSetup` entries, snapshots
 * `.env` once before the whole suite, and its RETURNED function (Playwright's
 * documented "globalSetup may return a teardown" convention — the same
 * idiom `seed.ts` could use but doesn't need to) restores it byte-for-byte
 * once every test has finished, whether or not any test wrote to it.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** This module lives at `ui/e2e/env-guard.ts`, two levels below the repo
 * root — resolved from its own location, never `process.cwd()` (matches
 * `wizard.helpers.ts`'s `removeProfileDir` and `seed.ts`'s own `root`). */
export function repoRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function envPath(root: string): string {
  return path.join(root, '.env');
}

/** The file's raw bytes, or `null` when no `.env` exists at `root` yet —
 * `null` is itself meaningful (see `restoreEnvFile`), not just "empty". */
export function snapshotEnvFile(root: string): Buffer | null {
  const target = envPath(root);
  return existsSync(target) ? readFileSync(target) : null;
}

/** Restores `.env` under `root` to exactly `snapshot`: deletes the file
 * when `snapshot` is `null` (there was no `.env` before), otherwise writes
 * the original bytes back byte-for-byte — never a re-serialization that
 * could normalize line endings or drop a comment. */
export function restoreEnvFile(root: string, snapshot: Buffer | null): void {
  const target = envPath(root);
  if (snapshot === null) {
    rmSync(target, { force: true });
  } else {
    writeFileSync(target, snapshot);
  }
}

export default function globalSetup(): () => void {
  const root = repoRoot();
  const snapshot = snapshotEnvFile(root);
  return () => restoreEnvFile(root, snapshot);
}
