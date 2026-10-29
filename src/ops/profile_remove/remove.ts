/**
 * ops/profile_remove — the ONE way a profile directory is deleted, shared
 * by the board (`cli/wire/board.ts` `removeProfile`) and the CLI
 * (`profile remove --force`).
 *
 * Why not a bare `rm(profiles/<name>, { recursive })`: `rm` is a chain of
 * async fs hops (readdir -> unlink children -> rmdir) and the profile stays
 * *listed and openable* for the whole chain. A concurrent board request
 * (membership check passes on the half-deleted dir, then a READONLY sqlite
 * probe recreates `jobbunny.db-shm`/`-wal`, which a readonly connection can
 * never remove) lands between the hops, and the final `rmdir(data)` fails
 * ENOTEMPTY — leaving a half-deleted profile that is still listed.
 *
 * So the profile is first moved with ONE atomic `rename` to a tombstone
 * OUTSIDE `<root>/profiles/` (`<root>/.profile-removing-<name>-<ts>`; the
 * profile listing only reads `<root>/profiles`, and a leading dot can never
 * match a profile name `^[a-z0-9_-]+$`). From that instant nothing that
 * resolves `profiles/<name>/…` can see or write into the doomed tree, and
 * the slow recursive delete runs on a path no request knows about. If the
 * rename cannot be done the profile is untouched and still fully intact — a
 * half-deleted, still-listed profile is never produced.
 *
 * Windows: `rename` (and `rm`) of a tree containing a just-closed sqlite
 * handle can fail EPERM/EBUSY/EACCES transiently, so the rename gets a short
 * bounded retry before giving up with a clear message.
 */
import { rename as fsRename, rm as fsRm } from 'node:fs/promises';
import path from 'node:path';

export type RemoveProfileDirResult =
  | { ok: true }
  | { ok: false; message: string; leftover?: string };

export interface RemoveProfileDirDeps {
  rename: (from: string, to: string) => Promise<void>;
  rm: (target: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 50; // 50,100,150,200,250 -> ~750ms worst case
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function defaultDeps(): RemoveProfileDirDeps {
  return {
    rename: (from, to) => fsRename(from, to),
    // maxRetries: belt-and-braces for transient EBUSY/ENOTEMPTY/EPERM while
    // deleting the (already unreachable) tombstone.
    rm: (target) =>
      fsRm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Where `profileDir` (= `<root>/profiles/<name>`) is moved to before it is
 * deleted. Outside `<root>/profiles`, same filesystem as `profileDir`. */
export function tombstonePath(profileDir: string, nowMs: number): string {
  const root = path.dirname(path.dirname(profileDir));
  return path.join(root, `.profile-removing-${path.basename(profileDir)}-${nowMs}`);
}

/** Removes `profileDir` (= `<root>/profiles/<name>`): atomic rename to a
 * tombstone, then recursive delete. An already-missing directory counts as
 * removed (a concurrent double delete is not an error). Never throws for
 * fs failures — returns `{ ok: false, message }`. */
export async function removeProfileDir(
  profileDir: string,
  overrides: Partial<RemoveProfileDirDeps> = {},
): Promise<RemoveProfileDirResult> {
  const deps: RemoveProfileDirDeps = { ...defaultDeps(), ...overrides };
  const tomb = tombstonePath(profileDir, deps.now());

  let renamed = false;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS && !renamed; attempt++) {
    try {
      await deps.rename(profileDir, tomb);
      renamed = true;
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return { ok: true }; // already gone
      lastErr = err;
      if (!TRANSIENT_CODES.has(codeOf(err) ?? '') || attempt === RENAME_ATTEMPTS) break;
      await deps.sleep(RENAME_BACKOFF_MS * attempt);
    }
  }
  if (!renamed) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    return {
      ok: false,
      message: `could not remove ${path.basename(profileDir)}: it is still in use (${reason}). Nothing was deleted; try again.`,
    };
  }

  try {
    await deps.rm(tomb);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      leftover: tomb,
      message: `profile ${path.basename(profileDir)} was unregistered but its files could not be fully deleted; remove ${tomb} by hand (${reason})`,
    };
  }
  return { ok: true };
}
