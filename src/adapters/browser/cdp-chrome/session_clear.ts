import { join as nodeJoin } from 'node:path';

/**
 * cdp-chrome/session_clear.ts — pre-launch session/tab-restore state
 * clearing. Split out of `launcher.ts` (task 5, 2026-07-28 file-size
 * split plan): `launchChrome` calls `clearSessionState` immediately before
 * spawning (2026-07-25 follow-up) — `buildLaunchArgv`'s
 * --restore-last-session=false etc. cut restored CDP targets from ~97 to
 * 4, but didn't fully suppress restore — command-line flags alone weren't
 * enough, one of the 4 was a LinkedIn tab with a live reCAPTCHA widget.
 * `clearSessionState` deletes the on-disk Sessions/tab-restore state and
 * normalizes Preferences' exit state so Chrome has nothing left to restore
 * from, while leaving cookies/storage/Login Data/the profile dir itself
 * completely untouched.
 */

/** The profile subdirectory Chrome actually opens with the argv above (no
 * `--profile-directory` flag is ever passed) — confirmed against
 * `.chrome-debug/Local State`'s `profile.last_used` / `last_active_profiles`
 * on 2026-07-25, both "Default". `.chrome-debug/` also has a `Profile 1`
 * left over from a one-off manual profile switch in the Chrome UI, but it
 * is never the one this launch argv restores into, so it is deliberately
 * left untouched — clearing profile dirs we don't actually launch into
 * would just be extra blast radius for no benefit. */
export const SESSION_CLEAR_PROFILE_DIR = 'Default';

/** Session/tab-state entries cleared pre-launch, relative to the profile
 * dir above. `Sessions/` (`Session_*`/`Tabs_*`) is the current (M96+)
 * layout confirmed on disk; the four `Current/Last Session/Tabs` files are
 * the pre-M96 layout, kept as a defensive check in case a future Chrome
 * update (or a restored old profile) reintroduces them. None of these
 * carry auth — cookies/storage/passwords live in separate files/dirs
 * (`Cookies`, `Local Storage/`, `Login Data`, etc.) that this list
 * deliberately excludes. */
export const SESSION_STATE_ENTRIES: readonly string[] = [
  'Sessions',
  'Current Session',
  'Current Tabs',
  'Last Session',
  'Last Tabs',
];

/** Chrome drops this file (a symlink, on macOS) at the user-data-dir root
 * for as long as some Chrome process holds the profile open. Its presence
 * means clearing session files right now would race a live Chrome process
 * (ours or the user's) and risk corrupting them — so it gates the whole
 * clear off, not just a subset of it. */
export const SESSION_CLEAR_LOCK_NAME = 'SingletonLock';

/** Env var to opt OUT of the pre-launch session clear (default: on — see
 * this module's doc / the 2026-07-25 incident this fixes). No legitimate
 * caller needs this today; it exists purely as an escape hatch if a future
 * Chrome/profile layout makes the clear itself misbehave. */
export const SESSION_CLEAR_SKIP_ENV = 'JOBBUNNY_SKIP_SESSION_CLEAR';

/** Minimal fs surface clearSessionState needs — injectable so tests always
 * run against a temp fixture directory, never the real `.chrome-debug/`. */
export interface SessionClearFsDeps {
  existsSync: (path: string) => boolean;
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
  readFileSync: (path: string, encoding: 'utf8') => string;
  writeFileSync: (path: string, data: string, encoding: 'utf8') => void;
}

export interface SessionClearResult {
  /** True iff the clear ran (lock absent) — false only means "skipped
   * because Chrome already holds this profile", never an error. */
  attempted: boolean;
  /** Session/tab-state entries actually removed. */
  removedEntries: string[];
  /** Preferences' exit_type/exited_cleanly were normalized. */
  preferencesNormalized: boolean;
  /** Every non-fatal problem hit along the way (missing dir, unreadable
   * file, malformed JSON, ...) — always fail-soft, never thrown. */
  warnings: string[];
}

/** Clears Chrome's session/tab-restore state under `userDataDir` — never
 * touches anything that carries auth (cookies, storage, Login Data, the
 * profile dir itself). Run ONLY immediately before a launch this process
 * OWNS (never on a reuse/attach path — see provider.ts's `ownsProcess`);
 * callers must not invoke this against a Chrome they merely attached to.
 *
 * Fail-soft throughout, per the repo's fail-soft-where-breadth-matters
 * posture (CLAUDE.md): a bloated restored session is a degradation the
 * pipeline can tolerate, so every error here is caught, recorded in
 * `warnings`, and never allowed to abort the launch that follows it.
 *
 * Skips entirely (no removals, no Preferences edit) if `SingletonLock`
 * exists at the user-data-dir root — some Chrome process already holds
 * this profile, and editing session state under a live Chrome can corrupt
 * it (requirement: safe when Chrome is already running).
 */
export function clearSessionState(
  userDataDir: string,
  deps: SessionClearFsDeps,
): SessionClearResult {
  const warnings: string[] = [];
  const result: SessionClearResult = {
    attempted: false,
    removedEntries: [],
    preferencesNormalized: false,
    warnings,
  };

  try {
    if (deps.existsSync(nodeJoin(userDataDir, SESSION_CLEAR_LOCK_NAME))) {
      warnings.push(
        `skipped: ${SESSION_CLEAR_LOCK_NAME} present — a Chrome process already holds ${userDataDir}`,
      );
      return result;
    }
  } catch (err) {
    warnings.push(`skipped: could not check ${SESSION_CLEAR_LOCK_NAME} (${String(err)})`);
    return result;
  }

  result.attempted = true;
  const profileDir = nodeJoin(userDataDir, SESSION_CLEAR_PROFILE_DIR);

  for (const entry of SESSION_STATE_ENTRIES) {
    const entryPath = nodeJoin(profileDir, entry);
    try {
      if (deps.existsSync(entryPath)) {
        deps.rmSync(entryPath, { recursive: true, force: true });
        result.removedEntries.push(entry);
      }
    } catch (err) {
      warnings.push(`could not remove ${entry} (${String(err)})`);
    }
  }

  const preferencesPath = nodeJoin(profileDir, 'Preferences');
  try {
    if (!deps.existsSync(preferencesPath)) {
      warnings.push('Preferences not found — skipping exit-state normalization');
    } else {
      const raw = deps.readFileSync(preferencesPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed == null || typeof parsed !== 'object') {
        warnings.push('Preferences did not parse to an object — leaving it untouched');
      } else {
        const prefs = parsed as Record<string, unknown>;
        const profile =
          prefs.profile != null && typeof prefs.profile === 'object'
            ? (prefs.profile as Record<string, unknown>)
            : {};
        prefs.profile = { ...profile, exit_type: 'Normal', exited_cleanly: true };
        deps.writeFileSync(preferencesPath, JSON.stringify(prefs), 'utf8');
        result.preferencesNormalized = true;
      }
    }
  } catch (err) {
    warnings.push(`could not normalize Preferences (${String(err)}) — left as-is`);
  }

  return result;
}
