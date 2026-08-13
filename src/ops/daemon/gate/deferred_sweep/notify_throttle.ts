/**
 * ops/daemon/gate/deferred_sweep/notify_throttle.ts — the interval throttle
 * and age-based prune for the deferred-day summary notify path, shared by
 * both `sweep.ts`'s same-day T4 send and its retrospective (past-day) send
 * (both compose and send the exact same kind of message for the exact same
 * (profile, date) pair). Split out of `../deferred_sweep.ts` (now this
 * folder's `sweep.ts`) purely to keep that file under the file-size cap —
 * a non-behavioral split, same precedent as `../reachability_gate.ts`'s own
 * header comment. Internal to this module: not re-exported by
 * `deferred_sweep/index.ts` — `sweep.ts` is this folder's only importer.
 */
import type { DaemonPidfile, DaemonPidfileDeps } from '../../pidfile.ts';
import { updateDaemonPidfile } from '../../pidfile.ts';

/** 1 hour — same idiom as `alert/schema_drift.ts`'s own
 * `SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS`, reused here rather than
 * duplicated inline. Bug 2/6 (pipeline-stability-hardening QA, 2026-08-14):
 * without this, both the same-day T4 send and the retrospective summary
 * send retry on EVERY 30s tick while failing (measured: 12 ticks -> 12
 * sends; ~2,880/day) — this bounds retries to at most once per pending
 * (profile, date) item per hour, both for a failing `notify()` AND for the
 * "notify succeeded but the fail-soft `markNotified` write silently didn't
 * stick" escalation (see `isNotifyThrottled`'s own doc comment). */
export const DEFERRED_NOTIFY_RETRY_INTERVAL_MS = 60 * 60_000;

/** 24 hours — bug 9 (pipeline-stability-hardening QA round 2, 2026-08-14):
 * `stampNotifyAttempt` only ever de-duped the EXACT (profile, date) pair
 * (a later attempt for the SAME day replaces its own entry) — it never
 * pruned an OLDER pair, so every calendar day that ever had a deferral
 * left one permanent entry behind (driven: 1 -> 22 entries over 30
 * simulated days, ~260/profile/year, in a file rewritten every 30s tick).
 * `slotGateDeclines` avoids this by pruning to `date === today` on every
 * write — but that mechanism is wrong here: this array throttles the
 * RETROSPECTIVE sweep too (`sweep.ts`'s `runRetrospectiveDeferredSweep`),
 * which deliberately re-visits PAST dates every tick
 * (`listUnnotifiedDatesBefore` has no date floor — read `adapters/db/
 * sqlite/deferred/store.ts`'s own query, `WHERE notified_at IS NULL AND
 * run_date < ?` — a still-unnotified date is retried for as long as it
 * stays unnotified, however old). Pruning by `date === today` would evict
 * a PAST date's entry seconds after it was stamped, reopening bug 2's
 * per-tick retry storm for exactly the dates this mechanism exists to
 * protect.
 *
 * The fix instead prunes by the entry's own `at` AGE, which an entry
 * still protecting an active throttle can never fall behind: any date
 * still being retried gets `stampNotifyAttempt`ed (and its `at` bumped)
 * at most once per `DEFERRED_NOTIFY_RETRY_INTERVAL_MS` (1h) for as long
 * as it remains unresolved, so a live entry's `at` is always well inside
 * a 24h window — 24x the 1h interval it exists to enforce, comfortable
 * margin against clock skew or a slow tick. Only entries that have gone
 * fully quiet (successfully notified, or the profile stopped being
 * scheduled) age past 24h and get dropped — exactly the common case this
 * bug measured: a daily deferral that resolves normally still left a
 * permanent entry behind under the old exact-pair-only de-dup. */
export const DEFERRED_NOTIFY_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Whether an attempt to notify (profile, date)'s deferred-day summary was
 * made within the last `DEFERRED_NOTIFY_RETRY_INTERVAL_MS` — checked BEFORE
 * every notify attempt in both `runDeferredSweepAndCatchup` and
 * `runRetrospectiveDeferredSweep`. Deliberately keyed off the last ATTEMPT
 * (stamped by `stampNotifyAttempt` regardless of whether `notify()`
 * succeeded), not the last FAILURE: `markNotified` is fail-soft (a DB write
 * error is swallowed, not surfaced), so a `notify()` that reports success
 * is not reliable proof the underlying `deferred_slots` row was actually
 * marked — throttling on attempts alone catches that escalation too,
 * where throttling only on reported failures would not. */
export function isNotifyThrottled(
  pidfileNow: DaemonPidfile | undefined,
  profile: string,
  date: string,
  now: Date,
): boolean {
  const entry = (pidfileNow?.deferredNotifyAttempts ?? []).find(
    (a) => a.profile === profile && a.date === date,
  );
  if (!entry) return false;
  const elapsed = now.getTime() - Date.parse(entry.at);
  return Number.isFinite(elapsed) && elapsed <= DEFERRED_NOTIFY_RETRY_INTERVAL_MS;
}

/** Upserts (profile, date)'s own attempt timestamp — one entry per pair,
 * a later call replacing rather than accumulating — AND prunes every
 * OTHER entry whose own `at` has aged past `DEFERRED_NOTIFY_ATTEMPT_MAX_
 * AGE_MS` (bug 9, see that constant's own doc comment for why age, not
 * date). A malformed `at` (unparseable -> `NaN` elapsed) is treated as
 * infinitely old and dropped, same posture as `isNotifyThrottled`'s own
 * `Number.isFinite` guard. Best-effort: a failed write here (unreadable/
 * corrupt pidfile) is not fatal to the caller. */
export function stampNotifyAttempt(
  root: string,
  pidfile: DaemonPidfileDeps,
  profile: string,
  date: string,
  now: Date,
): void {
  updateDaemonPidfile(
    root,
    (current) => ({
      ...current,
      deferredNotifyAttempts: [
        ...current.deferredNotifyAttempts.filter((a) => {
          if (a.profile === profile && a.date === date) return false; // replaced below.
          const age = now.getTime() - Date.parse(a.at);
          return Number.isFinite(age) && age <= DEFERRED_NOTIFY_ATTEMPT_MAX_AGE_MS;
        }),
        { profile, date, at: now.toISOString() },
      ],
    }),
    pidfile,
  );
}
