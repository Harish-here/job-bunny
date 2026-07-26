import { z } from 'zod';
import { type JD, JDSchema } from '../../../core/jd/index.ts';
import type { Storage } from '../../../ports/storage.ts';

/**
 * Durable incremental flush of captured JDs — crash-recovery companion to
 * ResumeState (P4 fix, verified code review finding). Persisted via the
 * Storage port at `lanes/linkedin/captures.json` as a plain JD[]. The lane
 * appends to this file after EVERY successfully captured JD (not batched
 * at end-of-run) so a mid-run crash never loses an already-scraped JD —
 * only the in-flight card is at risk. A same-day resumed fire loads this
 * file's contents via `all()` and seeds its own in-memory job list with
 * them, so a url skipped as already-done (ResumeState.shouldSkip) still
 * contributes its jobs to this run's result.
 *
 * Deliberately independent of ResumeState: the two are separate files
 * tracking separate concerns (done-marks vs. captured content), wired
 * together only by the caller (LinkedInLane), which must call `reset()`
 * here whenever it calls `ResumeState.rescanReset()` — a rescan discards
 * the old done-map, and the stale captures from the run(s) that produced
 * it must go with it, or a same-id job re-harvested this run would sit
 * alongside its own now-orphaned duplicate forever.
 */

const CapturesSchema = z.array(JDSchema);

export const CAPTURE_PATH = 'lanes/linkedin/captures.json';

export class CaptureStore {
  private jobs: JD[];

  private constructor(jobs: JD[]) {
    this.jobs = jobs;
  }

  /** Reads the persisted captures; a missing file starts empty. */
  static async load(storage: Storage): Promise<CaptureStore> {
    const raw = await storage.readJson(CAPTURE_PATH, CapturesSchema);
    return new CaptureStore(raw ? [...raw] : []);
  }

  /** Every JD flushed so far (this run's appends plus anything reloaded
   * from a prior same-day fire) — a defensive copy. */
  all(): JD[] {
    return [...this.jobs];
  }

  /** Appends one newly captured JD and immediately persists — called
   * after every successful JD open, never batched. */
  async append(storage: Storage, jd: JD): Promise<void> {
    this.jobs.push(jd);
    await storage.writeJson(CAPTURE_PATH, this.jobs);
  }

  /** Clears the file for a rescan (multi-fire schedules) — always call
   * this alongside ResumeState.rescanReset(); see header. */
  async reset(storage: Storage): Promise<void> {
    this.jobs = [];
    await storage.writeJson(CAPTURE_PATH, this.jobs);
  }
}
