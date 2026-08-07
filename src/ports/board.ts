import type { JD } from '../core/jd/index.ts';
import type { TrackingFields } from '../core/tracking/index.ts';
import type { ConfigDocKey } from './config_store.ts';
import type { RunIntentStore } from './run_intents.ts';
import type { RunDetail, RunEventRow, RunSummary } from './run_store.ts';

/** One discovered profile, as the board sees it. `hasDb` reflects ONLY
 * whether a `jobbunny.db` FILE exists — every profile gets one
 * unconditionally once it has run at least once (local-DB spec D5: run
 * history is tracked regardless of `connector`), so a pure-Notion profile
 * can legitimately show `hasDb: true` too, once it has run. It is never an
 * error either way (spec §5).
 *
 * `hasDb` alone is NOT "this profile's jobs live locally" — `jobs` is only
 * ever written by a `sqlite` connector's own sync stage, so a non-sqlite
 * profile's `jobs` table, even inside a `jobbunny.db` file that exists for
 * run-history reasons alone, is always empty. Jobs routes
 * (`app/features/board/routes.ts`) gate on `connector === 'sqlite'`
 * separately from `openStore`'s own `hasDb` gate, so they 404
 * `no_local_db` for a non-sqlite profile even when a store could
 * technically be opened; runs routes (`app/features/runs/routes.ts`) have
 * no such gate — runs/`run_events` are unconditional, so they keep using
 * `openStore`'s file check alone. */
export interface BoardProfile {
  name: string;
  connector: string; // '' when profile.json is missing/malformed
  hasDb: boolean; // a jobbunny.db file exists for this profile
}

export const SECRET_KEYS = ['NOTION_TOKEN', 'TELEGRAM_BOT_TOKEN'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
export type SecretPresence = Record<SecretKey, 'present' | 'absent'>;

export interface BoardQuery {
  status?: string;
  excitement?: string;
  company?: string; // case-insensitive substring
  dateFrom?: string; // inclusive calendar date (YYYY-MM-DD); date_found holds a full
  dateTo?: string; // ISO DATETIME (identity.scrapedAt) — filters compare substr(date_found,1,10)
  archived?: boolean; // default false
  sort?: 'date_found' | 'score';
  order?: 'asc' | 'desc';
  limit?: number; // caller pre-validated: 1..200
  offset?: number; // >= 0
}

export interface TrackingRow extends TrackingFields {
  jobId: string;
  updatedAt: string;
}

/** null clears a field; absent keys are untouched. */
export type TrackingPatch = { [K in keyof TrackingFields]?: TrackingFields[K] | null };

export interface BoardJobRow {
  id: string;
  lane: string;
  title: string;
  company: string;
  url: string;
  seniority: string | null;
  locationCity: string | null;
  workType: string | null;
  timezone: string | null;
  skills: string[];
  excitement: string | null;
  score: number | null;
  matchReasons: string[];
  reviewFlags: string[];
  dateFound: string;
  archived: boolean;
  tracking: TrackingRow | null;
}

export interface BoardJobDetail extends BoardJobRow {
  jd: JD; // parsed jd_json — the detail pane payload
}

/** The board server binds `127.0.0.1` and writes only the `tracking`,
 * config, run-intent, and secrets (the data home's `.env`) surfaces
 * (hard-rule amendment, config→db Phase 4 ledger L7, widened by UI phase
 * 1 Task 2 to add run intents and Task 4 to add write-only allowlisted
 * secrets — superseding the previous "writes only `tracking`" wording).
 * `jobs` and the runs tables stay pipeline/runner-only — the split is
 * structural, enforced here: `BoardStore` reads `jobs`/`runs`/`run_events`
 * and writes ONLY `tracking` (`updateTracking`); config-doc writes,
 * profile creation, run-intent inserts/cancels, and secret writes are
 * `BoardSource`-level operations below
 * (`readConfigDoc`/`writeConfigDoc`/`createProfile`/`openIntents`/
 * `writeSecret`), never `BoardStore` methods, since a config doc or a run
 * intent is per-profile-discovery, and a secret lives in the data home's
 * single `.env` (cross-profile, not per-opened-job-store at all).
 * Synchronous by design: node:sqlite is sync. */
export interface BoardStore {
  listJobs(query: BoardQuery): { rows: BoardJobRow[]; total: number };
  getJob(id: string): BoardJobDetail | null;
  /** Returns the merged row, or null when no such job id exists. */
  updateTracking(id: string, patch: TrackingPatch, now: string): TrackingRow | null;
  /** Read-only runs observability (persist-to-db Phase 1) — the board
   * never writes `runs`/`run_events`, it only surfaces them. */
  listRuns(query: { limit?: number; offset?: number }): {
    rows: RunSummary[];
    total: number;
  };
  getRun(id: number): RunDetail | null;
  listRunEvents(
    id: number,
    query: { limit?: number; offset?: number },
  ): { rows: RunEventRow[]; total: number };
  close(): void;
}

/** Cross-profile hub the CLI wires and the app consumes. openStore returns
 * null for unknown profiles and for profiles without a local DB.
 *
 * `listProfiles`/`openStore` are `async` (config→db Phase 4, Task 5):
 * probing a profile's `connector` field now reads `profile.json` through
 * the `ConfigStore` port, whose `readText` is `Promise`-wrapped (see
 * `ports/config_store.ts`) even though the real adapter is synchronous
 * under the hood. `BoardStore`'s own methods stay synchronous — untouched
 * by this widening, "node:sqlite is sync" still holds for every query
 * against an ALREADY-OPENED store.
 *
 * Write-surface invariant (hard-rule amendment, ledger L7 — the code-level
 * home for it, `CLAUDE.md` carries the prose): **the board server binds
 * `127.0.0.1` and writes only the `tracking`, config, run-intent, and
 * secrets surfaces**. `jobs` and the runs tables stay pipeline/runner-only.
 * As of UI phase 1 Task 4 the board's full write surface is exactly
 * `BoardStore.updateTracking` (tracking) + `writeConfigDoc` (config
 * tables, below) + `createProfile` (which itself only ever calls
 * `writeConfigDoc` under the hood, via `seedProfileDocs`) +
 * `openIntents`'s returned store (insert a `pending` run intent, cancel
 * one's own `pending` intent) + `writeSecret` (write-only, allowlisted
 * `SECRET_KEYS`, appends/replaces one line of the data home's `.env` —
 * never reads a value back) — nothing else, ever. */
export interface BoardSource {
  listProfiles(): Promise<BoardProfile[]>;
  /** null for unknown names and profiles without a local DB. MAY throw for a
   * discovered profile whose DB file is corrupt or schema-newer — callers
   * surface that as a 500, never a crash. */
  openStore(name: string): Promise<BoardStore | null>;
  /** Raw text for one profile's config doc. `undefined` when the doc is
   * absent for a REAL profile OR when `name` fails the same membership
   * check `openStore` uses (defense-in-depth — callers are expected to
   * check `listProfiles()` membership themselves first, same as
   * `openStoreOrThrow` already does for jobs routes; this is the backstop,
   * not the primary gate). Never gated on `hasDb` — UNLIKE `openStore`,
   * reading/writing config is allowed even for a profile that has never
   * run (config editing is itself a legitimate "first meaningful use" that
   * MAY create the db file, exactly like `setup`/`migrate` already do —
   * this is a deliberate, documented exception to `openStore`'s own
   * "never create a DB" rule, scoped to config docs only). */
  readConfigDoc(name: string, doc: ConfigDocKey): Promise<string | undefined>;
  /** Validator-gated write (throws the validator's message on an invalid
   * doc — caller turns that into 422). Throws a generic "unknown profile"
   * message when `name` fails membership (caller is expected to have
   * already 404'd on that via its own `listProfiles()` check, mirroring
   * `openStoreOrThrow` — this throw is the defense-in-depth backstop, not
   * the primary signal). */
  writeConfigDoc(name: string, doc: ConfigDocKey, rawText: string): Promise<void>;
  /** Creates `profiles/<name>/data/` + seeds the four config docs (reuses
   * `seedProfileDocs`, Task 7). Throws on an invalid name (fails
   * `^[a-z0-9_-]+$`) or a name that already exists — check the name format
   * BEFORE ever touching the filesystem (never construct a path from an
   * unsanitized name, same discipline as every other traversal-sensitive
   * function in this file). */
  createProfile(name: string): Promise<void>;
  /** One profile's run-intent store. `null` for a name that is not a
   * current directory under `<root>/profiles`. Unlike `openStore`, this
   * OPENS-OR-CREATES the profile's db: an intent is durable state a
   * never-run profile must still be able to record. Memoized per name for
   * the life of this `BoardSource` and closed by `close()` — callers must
   * never call `close()` on the returned store. */
  openIntents(name: string): Promise<RunIntentStore | null>;
  /** Presence only — never a value, never a prefix, never a length. */
  listSecrets(): Promise<SecretPresence>;
  /** Write-only. Appends or replaces `key`'s line in `<root>/.env`.
   * Never reads a value back out and never returns one. */
  writeSecret(key: SecretKey, value: string): Promise<void>;
  close(): void;
}
