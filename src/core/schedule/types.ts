/**
 * core/schedule/types.ts — the pure vocabulary the daemon's owed-slot
 * decision (owed.ts) is built from. Local wall-clock time throughout, never
 * UTC: run-folder-shaped names (formatted by `formatRunTime` in
 * ops/observability/run/run_folder.ts) are local, and using UTC here is a
 * bug this project already hit once — run.log timestamps are UTC while
 * folder-shaped names are local, and conflating the two silently misaligns
 * "is this slot served" checks. (Historical note: this checked actual
 * on-disk run folders pre-Phase-2; the checkpoints-to-db migration retired
 * the folders themselves, but the `HH-MM(-N)` format they used lives on in
 * `formatRunTime` and in this file's own `RUN_FOLDER_RE`.)
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ProfileSchedule {
  profile: string;
  enabled: boolean;
  times: string[]; // "HH:MM", local wall clock
  weekdays: Weekday[]; // default [1, 2, 3, 4, 5]
  graceMinutes: number; // default 90
}

/**
 * Evidence that a run happened OR was attempted for a given
 * (profile, date, time) — sourced from either an on-disk run folder
 * (actual start time, via parseRunFolderName below) or a synthetic entry
 * the daemon derives from its pidfile attempts ledger (D19: an owed slot
 * the daemon attempted to spawn but which crashed before writing a run
 * folder). Both sources produce the identical shape below; a caller
 * cannot and need not distinguish them.
 */
export interface RunRecord {
  profile: string;
  date: string; // "YYYY-MM-DD" local
  startedAt: string; // "HH:MM" local
}

export interface OwedRun {
  profile: string;
  date: string; // "YYYY-MM-DD" local
  slot: string; // "HH:MM" local
}

// Matches the same `^\d{2}-\d{2}(-\d+)?$` shape `formatRunTime` produces
// (ops/observability/run/run_folder.ts): always zero-padded HH-MM,
// optionally suffixed -N on a same-minute collision. A name that doesn't
// match (e.g. "sync_dryrun.json") is not a run-folder-shaped name at all
// and yields undefined.
const RUN_FOLDER_RE = /^(\d{2})-(\d{2})(?:-\d+)?$/;

/**
 * Maps a run-folder directory name to "HH:MM", stripping any -N collision
 * suffix — two folders in the same minute (e.g. "14-04" and "14-04-2")
 * therefore yield the same result, which is harmless: served-detection
 * only asks whether ANY record falls in the owed window, not how many.
 * Returns undefined for anything that is not a run-folder name.
 */
export function parseRunFolderName(name: string): string | undefined {
  const match = RUN_FOLDER_RE.exec(name);
  if (!match) return undefined;
  const hh = match[1] as string;
  const mm = match[2] as string;
  return `${hh}:${mm}`;
}

/** Local calendar date as YYYY-MM-DD — never UTC (see module doc comment). */
export function formatLocalDate(d: Date): string {
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Local wall-clock time as HH:MM — never UTC (see module doc comment). */
export function localHhMm(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** "14:04" -> 844 (minutes since local midnight) — used to sort OwedRun[]
 * by slot ascending without re-parsing a Date each comparison. */
export function hhMmToMinutes(hhMm: string): number {
  const parts = hhMm.split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  return hh * 60 + mm;
}
