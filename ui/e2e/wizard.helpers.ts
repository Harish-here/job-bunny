/**
 * e2e safety helpers for the wizard suite (design ledger's "e2e safety
 * rule", phase 3 tasks 4 and 9). Every spec in `wizard.spec.ts` that
 * creates a profile uses `uniqueProfileName` to pick its name and
 * `removeProfileDir` to clean it up in `afterAll` — never a hand-rolled
 * name or a hand-rolled `rm`.
 *
 * This is correct — genuinely safe to run against a developer's real
 * machine — ONLY because `ui/playwright.config.ts`'s `webServer.env`
 * pins the spawned board server's `JOBBUNNY_HOME` to the repo root.
 * `wireBoard()` resolves its data home via `resolveHome()`, which
 * honours only `JOBBUNNY_HOME` and otherwise falls back to `~/.jobbunny`
 * — the user's REAL, shared data home, holding real profiles. Without
 * that env pin, a spec that creates a profile through this suite would
 * write into real user data, and this file's cleanup (scoped to the
 * repo root by construction) would never find it to delete it.
 * `wizard.spec.ts`'s Step 0 verifies the pin is present before any test
 * in this suite runs; this file does not re-verify it.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const THROWAWAY_NAME_RE = /^wiz-[0-9a-f]{8}$/;

/**
 * Returns `wiz-` plus 8 lowercase-hex characters. Lowercase specifically:
 * the server's profile-name schema is `/^[a-z0-9_-]+$/`
 * (`CreateProfileBodySchema`, `src/app/features/config/routes.ts`), so an
 * uppercase hex digit would 400 the very first `POST /api/profiles` of
 * any test using it. Lowercase is also exactly what `removeProfileDir`'s
 * guard below requires — the two functions are a matched pair, and a
 * mismatch between them would leave every created profile un-cleanable.
 */
export function uniqueProfileName(): string {
  const hex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8);
  return `wiz-${hex}`;
}

/**
 * Removes `profiles/<name>/` from the repo root, resolved from THIS
 * module's own location (`new URL('../..', import.meta.url)`), never
 * from `process.cwd()` — matches `smoke.spec.ts`'s own `REPO_ROOT`
 * pattern. Refuses any name that does not match
 * `/^wiz-[0-9a-f]{8}$/` and refuses the literal `rajni` (the committed
 * fixture every other e2e spec in this repo depends on) BEFORE ever
 * building a filesystem path or calling `rmSync` — belt-and-braces,
 * mirroring `smoke.spec.ts`'s `test.afterAll` guard. Uses `node:path`'s
 * `join`, never a hardcoded `/` separator, because CI runs Windows.
 *
 * Never throws the suite red: an invalid name is a silent no-op (this
 * is a shared teardown helper called from eight independent `afterAll`
 * bodies — one guard tripping must never crash the other seven's
 * cleanup), and the removal itself is wrapped in try/catch so a
 * filesystem hiccup (e.g. an EBUSY on Windows from a handle the board
 * server hasn't released yet) degrades to "left behind for a human to
 * clean up" rather than failing the run.
 */
export function removeProfileDir(name: string): void {
  if (!THROWAWAY_NAME_RE.test(name) || name === 'rajni') {
    return;
  }
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const target = join(repoRoot, 'profiles', name);
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // best-effort cleanup — never throw the suite red
  }
}

/**
 * Pins the active profile to `rajni` before the wizard's own first-boot
 * redirect logic (`Shell.tsx`: navigate to onboarding when
 * `profiles.length === 0`) can race the suite's own navigation — the
 * dev machine running these tests may hold zero or many real profiles.
 * Mirrors `smoke.spec.ts` and `shell.spec.ts`'s own `pinProfile`
 * EXACTLY in scope: it touches `jobbunny.profile` and nothing else. It
 * must never also clear a `jobbunny.wizard.*` key — `addInitScript`
 * re-fires on every navigation this suite makes, including
 * `page.reload()`, and test 5 relies on that reload NOT wiping the
 * wizard's own draft (see `wizard.spec.ts`'s test 5 and this task's
 * brief for why).
 */
export async function pinProfile(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('jobbunny.profile', 'rajni');
  });
}
