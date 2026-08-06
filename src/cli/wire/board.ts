/**
 * cli/wire/board.ts (local-DB spec PR 4, Task 7) — the board server's own
 * composition point: sibling to `compose.ts`/`builders.ts` in the
 * `only-wire-imports-adapters` carve-out (`.dependency-cruiser.cjs`), the
 * ONE place a `BoardSource` is assembled from real sqlite adapters.
 * `wireBoard` is built once, at CLI-command time (Task 8's `board`
 * command); `createBoardServer` (Task 6) is the only thing that calls
 * `listProfiles`/`openStore` afterward, once per request.
 *
 * Tolerant posture: a broken `profile.json` (missing, unreadable,
 * malformed JSON, or a non-string `connector`) never kills discovery —
 * `listProfiles` degrades that profile to `{ name, connector: '', hasDb }`
 * rather than throwing, the same posture the pipeline's own doctor takes
 * on a bad profile.
 *
 * `openStore`'s three gates are SECURITY-ORDERED and must stay in this
 * order:
 *   1. `name` membership against the CURRENT `listProfiles()` result,
 *      compared with `===` — THIS is the traversal defense, not
 *      `path.normalize`/`path.resolve` or a `startsWith(root)` check.
 *      `name` arrives straight from a URL path param that `matchRoute`
 *      decodes (`%2F` included), so `'../rajni'` or `'a/../a'` are
 *      genuinely reachable inputs; neither ever equals a real directory
 *      name read off disk, so the membership check rejects them outright
 *      without needing to reason about path math at all.
 *   2. `hasDb` must be true, else null. `openJobsDb` would mkdir+create a
 *      missing file — the board reads and annotates, it never
 *      initializes a database.
 *   3. Only past both gates: `new SqliteBoardStore(openJobsDb(dbPath))`,
 *      memoized per name for the life of this `BoardSource`.
 * `openStore` MAY throw past the gates (corrupt file, schema newer than
 * this build supports) — that is intentional and documented on
 * `ports/board.ts`'s `openStore`; the caller (the board server's
 * catch-all) turns it into a 500, never a crash.
 *
 * Discovery is at-call: every `listProfiles()` (and every `openStore`,
 * which re-derives its own membership list) re-reads `<root>/profiles`
 * from disk, so a profile created while the server is running appears on
 * the next call. The store memo is unaffected by that — it survives until
 * `close()`.
 */
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openJobsDb, SqliteBoardStore } from '../../adapters/db/sqlite/index.ts';
import type { BoardProfile, BoardSource, BoardStore } from '../../ports/board.ts';
import { resolveSqlitePath } from './builders.ts';

export interface BoardWireOverrides {
  /** repo root; default `process.cwd()` — same resolution as
   * `compose.ts`/`wireMigrate` in `builders.ts`. */
  root?: string;
}

interface ProfileInfo extends BoardProfile {
  dbPath: string;
}

/** Delegates to `builders.ts`'s `resolveSqlitePath` — THE single
 * authoritative resolver, also used by `wire()`'s run store and
 * `wireMigrate`, so all three agree on one path for a given profile
 * regardless of `connector`. */
function resolveDbPath(root: string, name: string, parsed: unknown): string {
  const settings =
    parsed && typeof parsed === 'object'
      ? (parsed as { settings?: unknown }).settings
      : undefined;
  const sqliteSlice =
    settings && typeof settings === 'object'
      ? (settings as { sqlite?: unknown }).sqlite
      : undefined;
  return resolveSqlitePath(
    sqliteSlice,
    path.join(root, 'profiles', name, 'data', 'jobbunny.db'),
  );
}

function readProfileInfo(root: string, name: string): ProfileInfo {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(
      readFileSync(path.join(root, 'profiles', name, 'profile.json'), 'utf8'),
    );
  } catch {
    // missing, unreadable, or malformed profile.json — tolerant posture.
  }
  const connector =
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as { connector?: unknown }).connector === 'string'
      ? (parsed as { connector: string }).connector
      : '';
  const dbPath = resolveDbPath(root, name, parsed);
  return { name, connector, hasDb: existsSync(dbPath), dbPath };
}

/** `<root>/profiles`, directories only, sorted. A missing `profiles/`
 * directory itself yields `[]` rather than throwing — the same fail-soft
 * shape `scanProfileSchedules` (ops/daemon/scan) already uses. */
function listProfileInfos(root: string): ProfileInfo[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(path.join(root, 'profiles'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readProfileInfo(root, name));
}

export function wireBoard(overrides: BoardWireOverrides = {}): BoardSource {
  const root = overrides.root ?? process.cwd();
  const stores = new Map<string, BoardStore>();

  return {
    listProfiles(): BoardProfile[] {
      return listProfileInfos(root).map(({ name, connector, hasDb }) => ({
        name,
        connector,
        hasDb,
      }));
    },

    openStore(name: string): BoardStore | null {
      // Gate 1 — membership, not path math: `name` must be `===` one of
      // the CURRENT directory names, freshly read from disk.
      const info = listProfileInfos(root).find((p) => p.name === name);
      if (!info) return null;

      // Gate 2 — never create a DB file for a profile that doesn't have one.
      if (!info.hasDb) return null;

      const existing = stores.get(name);
      if (existing) return existing;

      // Gate 3 — only now open (and memoize) the real store.
      const store = new SqliteBoardStore(openJobsDb(info.dbPath));
      stores.set(name, store);
      return store;
    },

    close(): void {
      for (const store of stores.values()) store.close();
      stores.clear();
    },
  };
}
