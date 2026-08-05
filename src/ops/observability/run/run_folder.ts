import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CHECKPOINT_RE = /^(\d{2})-(.+)\.json$/;
const TIME_DIR_RE = /^\d{2}-\d{2}(-\d+)?$/;

/** Formats `now` as local `HH-MM` (zero-padded, dash separator) — matches
 * `schedule.times`'s local-clock convention so run artifacts line up with
 * the schedule that triggered them. */
export function formatRunTime(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}-${mm}`;
}

/**
 * Lexicographically greatest subdirectory of `<profileDataDir>/runs/<date>/`
 * matching the time-dir shape (`HH-MM`, or `HH-MM-N` on a rare same-minute
 * collision — see `nextTimeDir`), or `undefined` when `runs/<date>/` doesn't
 * exist or has no matching entries. Lexicographic ordering is safe for the
 * zero-padded `HH-MM` case; a `-N` collision suffix sorts AFTER its bare
 * `HH-MM` (a string that is a strict prefix of another sorts first), which
 * is exactly "later within the same minute" — the property we want.
 */
export async function latestTimeDir(
  profileDataDir: string,
  date: string,
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(join(profileDataDir, 'runs', date));
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  const matches = entries.filter((entry) => TIME_DIR_RE.test(entry)).sort();
  return matches.at(-1);
}

/**
 * Returns `time` itself, or `time`-2, `time`-3, … if that folder already
 * exists under `<profileDataDir>/runs/<date>/`. A collision is
 * near-impossible in practice — the cross-process run lock
 * (`ops/scheduling/run_lock.ts`) already prevents two runs from starting in
 * the same minute — but this guards against it anyway rather than silently
 * overwriting an existing folder's contents.
 */
export async function nextTimeDir(
  profileDataDir: string,
  date: string,
  time: string,
): Promise<string> {
  let candidate = time;
  let suffix = 2;
  while (await pathExists(join(profileDataDir, 'runs', date, candidate))) {
    candidate = `${time}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/** One run's checkpoints — rooted at
 * `<profileDataDir>/runs/<date>/<time>/`. Heartbeat, failure, and result
 * records live in the `runs`/`run_events` sqlite tables now (runs-
 * observability Phase 1) — this class is checkpoint-only. Writes are
 * atomic (temp + rename) so a killed process never leaves a truncated
 * file. */
export class RunFolder {
  readonly dir: string;
  readonly date: string;
  readonly time: string;

  constructor(profileDataDir: string, date: string, time: string) {
    this.dir = join(profileDataDir, 'runs', date, time);
    this.date = date;
    this.time = time;
  }

  checkpointPath(index: number, stage: string): string {
    return join(this.dir, `${String(index).padStart(2, '0')}-${stage}.json`);
  }

  async writeCheckpoint(index: number, stage: string, payload: unknown): Promise<void> {
    await this.writeAtomic(this.checkpointPath(index, stage), payload);
  }

  async readLatestCheckpoint(): Promise<
    { index: number; stage: string; payload: unknown } | undefined
  > {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }

    let best: { index: number; stage: string; file: string } | undefined;
    for (const entry of entries) {
      const match = CHECKPOINT_RE.exec(entry);
      if (!match) continue;
      const index = Number(match[1]);
      const stage = match[2] as string;
      // Ties (same index, different stage) should never happen in normal
      // operation — the runner assigns one index per stage in sequence.
      // On a tie we keep the first one encountered (readdir order).
      if (!best || index > best.index) best = { index, stage, file: entry };
    }
    if (!best) return undefined;

    const raw = await readFile(join(this.dir, best.file), 'utf8');
    return { index: best.index, stage: best.stage, payload: JSON.parse(raw) };
  }

  private async writeAtomic(absPath: string, value: unknown): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
    const tmpPath = `${absPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmpPath, absPath);
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
