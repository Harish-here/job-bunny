import type { JD } from '../core/jd/index.ts';
import type { TrackingFields } from '../core/tracking/index.ts';

/** One discovered profile, as the board sees it. Pure-Notion profiles are
 * listed with hasDb=false and are never an error (spec §5). */
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
  close(): void;
}

/** Cross-profile hub the CLI wires and the app consumes. openStore returns
 * null for unknown profiles and for profiles without a local DB. */
export interface BoardSource {
  listProfiles(): BoardProfile[];
  /** null for unknown names and profiles without a local DB. MAY throw for a
   * discovered profile whose DB file is corrupt or schema-newer — callers
   * surface that as a 500, never a crash. */
  openStore(name: string): BoardStore | null;
  close(): void;
}
