/**
 * cli/wire/board_remove.ts — `BoardSource.removeProfile`'s real
 * implementation, split out of `board.ts` for the file-size cap (same
 * precedent as `board_doctor.ts`/`board_daemon.ts`). Imports no adapter:
 * every store access arrives through `deps`, which `board.ts` fills.
 *
 * Guard order is the design — membership, protected, running run, pending
 * intent, mark-removing + handle release, delete:
 *  1. membership against the CURRENT directory names (the traversal
 *     defense — see `board.ts`'s header);
 *  2. protected fixture profile, no I/O (same set as the CLI);
 *  3. a running run blocks; a crashed (stale-heartbeat) one does not;
 *  4. a pending intent blocks; an expired one does not;
 *  5. add `name` to `removing` — every other `BoardSource` method derives
 *     membership through a list that EXCLUDES that set, so from here on the
 *     profile is no longer served (no request can re-open its db) — then
 *     release the memoized sqlite handles (an open handle makes the
 *     directory undeletable on Windows and leaves a stale handle on a
 *     deleted file elsewhere);
 *  6. delete via `ops/profile_remove` (atomic rename out of
 *     `<root>/profiles`, then recursive delete). Never touches Notion or
 *     the network. `removing` is cleared in a `finally`: a failed rename
 *     leaves the profile fully intact and listed again.
 */
import path from 'node:path';
import { removeProfileDir } from '../../ops/profile_remove/index.ts';
import type { BoardStore, RemoveProfileOutcome } from '../../ports/board.ts';
import type { RunIntentStore } from '../../ports/run_intents.ts';
import { PROTECTED_PROFILES } from '../commands/profile.ts';

export interface BoardRemoveDeps {
  root: string;
  /** names of the profiles currently listed (already excludes `removing`) */
  listNames: () => Promise<string[]>;
  openStore: (name: string) => Promise<BoardStore | null>;
  openIntents: (name: string) => Promise<RunIntentStore | null>;
  /** closes and forgets the memoized board + intent store handles */
  releaseHandles: (name: string) => void;
  removing: Set<string>;
}

export async function removeBoardProfile(
  deps: BoardRemoveDeps,
  name: string,
): Promise<RemoveProfileOutcome> {
  if (!(await deps.listNames()).includes(name)) return { outcome: 'not_found' };
  if (PROTECTED_PROFILES.has(name)) return { outcome: 'protected' };

  const store = await deps.openStore(name);
  if (store) {
    const { rows } = store.listRuns({ limit: 1, offset: 0 });
    if (rows[0]?.status === 'running') {
      return { outcome: 'run_in_progress', runId: rows[0].id };
    }
  }

  const intents = await deps.openIntents(name);
  if (intents) {
    const intent = intents.latest(new Date().toISOString());
    if (intent?.status === 'pending') {
      return { outcome: 'intent_pending', intentId: intent.id };
    }
  }

  deps.removing.add(name);
  try {
    deps.releaseHandles(name);
    const result = await removeProfileDir(path.join(deps.root, 'profiles', name));
    return result.ok
      ? { outcome: 'removed' }
      : { outcome: 'remove_failed', message: result.message };
  } finally {
    deps.removing.delete(name);
  }
}
