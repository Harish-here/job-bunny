import { z } from 'zod';
import type { Storage } from '../../../ports/storage.ts';

/**
 * Per-URL same-day extract resumability (P4 Task 6). Persisted via the
 * Storage port at `lanes/linkedin/extract_resume.json` as `{ date, done }`
 * where `done` maps url -> captured-JD count. A run that dies partway
 * through (or a later same-day fire) resumes without re-hitting URLs it
 * already finished today (v0 `data/extract_resume.json` crash-recovery
 * lesson). A new calendar day (or a missing/corrupt file) starts fresh.
 * The lane persists this after EVERY url (success or failure), not once
 * at the very end, so a mid-run crash loses at most the in-flight url.
 *
 * v0 invariant this class must preserve: a same-day reset (`rescanReset`,
 * used for multi-fire schedules once every URL is done) NEVER discards
 * already-flushed captures. ResumeState only ever tracks per-URL
 * done-counts — captured JDs are durably flushed by the sibling
 * CaptureStore (capture_store.ts) to its own file, entirely outside this
 * class. Clearing `done` here cannot touch that data because this class
 * never holds a reference to it; the caller (LinkedInLane) is responsible
 * for calling CaptureStore.reset() alongside rescanReset() so the two
 * stay in lockstep on a rescan — ResumeState intentionally doesn't know
 * CaptureStore exists.
 */

export const ResumeStateSchema = z.object({
  date: z.string(),
  done: z.record(z.string(), z.number()),
});

export type ResumeStateShape = z.infer<typeof ResumeStateSchema>;

export const RESUME_STATE_PATH = 'lanes/linkedin/extract_resume.json';

export class ResumeState {
  private readonly date: string;
  private done: Record<string, number>;

  private constructor(date: string, done: Record<string, number>) {
    this.date = date;
    this.done = done;
  }

  /** Reads the persisted state; a missing file OR a stale (non-today)
   * date returns a fresh empty state for `today` — this folds
   * "resetIfNewDay" into load itself rather than a separate step. */
  static async load(storage: Storage, today: string): Promise<ResumeState> {
    const raw = await storage.readJson(RESUME_STATE_PATH, ResumeStateSchema);
    if (!raw || raw.date !== today) {
      return new ResumeState(today, {});
    }
    return new ResumeState(raw.date, { ...raw.done });
  }

  shouldSkip(url: string): boolean {
    return Object.hasOwn(this.done, url);
  }

  markDone(url: string, count: number): void {
    this.done[url] = count;
  }

  /** True once every url in the given list has been captured today. */
  allDone(urls: string[]): boolean {
    return urls.every((url) => Object.hasOwn(this.done, url));
  }

  /** Clears the done-map so a later same-day fire (multi-fire schedules)
   * rescans every URL. Does NOT — and structurally cannot — touch any
   * already-flushed capture data; that lives entirely outside this class. */
  rescanReset(): void {
    this.done = {};
  }

  async persist(storage: Storage): Promise<void> {
    const shape: ResumeStateShape = { date: this.date, done: { ...this.done } };
    await storage.writeJson(RESUME_STATE_PATH, shape);
  }
}
