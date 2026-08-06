import type { JD } from '../core/jd/index.ts';
import type { TrackingFields } from '../core/tracking/index.ts';
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

/** Read `jobs`, write `tracking` — never the reverse (ownership zones,
 * spec §3). Synchronous by design: node:sqlite is sync. */
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
 * against an ALREADY-OPENED store. */
export interface BoardSource {
  listProfiles(): Promise<BoardProfile[]>;
  /** null for unknown names and profiles without a local DB. MAY throw for a
   * discovered profile whose DB file is corrupt or schema-newer — callers
   * surface that as a 500, never a crash. */
  openStore(name: string): Promise<BoardStore | null>;
  close(): void;
}
