/**
 * ops/daemon/pidfile.ts — the scheduling daemon's own supervision state:
 * a heartbeat (lastTickAt, D22) instead of an age check (unlike
 * ops/scheduling/run_lock.ts's 4-hour DEFAULT_MAX_AGE_MS — see
 * isDaemonPidfileStale below for why that rule is wrong here), an
 * attempts ledger (D19, closes the respawn-storm gap left by run folders
 * being created lazily), and an inFlight child pid so `serve stop` can
 * find and kill an in-progress run even if the daemon itself has died.
 *
 * File location: `<root>/.jobbunny-daemon.pid`, sibling to
 * `<root>/.jobbunny-run.lock` — same directory convention, a different
 * file, so the daemon's own long-lived supervision state never collides
 * with a single run's cross-process exclusive lock.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseDeferredNotifyAttempts,
  parseDegraded,
  parseInFlight,
  parseLastGateDecline,
  parseNullableTimestamp,
  parseSlotGateDeclines,
} from './pidfile_parse.ts';

export interface DaemonAttempt {
  profile: string;
  date: string; // "YYYY-MM-DD" local
  slot: string; // "HH:MM" local
}

export interface DaemonInFlight {
  pid: number; // pid of the child run currently executing
  profile: string;
  startedAt: string; // ISO 8601
}

export interface DaemonDegradedEntry {
  profile: string;
  schemaVersion: number;
  buildVersion: number;
  detectedAt: string; // ISO 8601
}

export interface DaemonPidfile {
  pid: number;
  startedAt: string; // ISO 8601
  lastTickAt: string; // ISO 8601
  inFlight?: DaemonInFlight;
  attempts: DaemonAttempt[];
  degraded: DaemonDegradedEntry[]; // per-profile detection — today's + any still-unresolved prior entries
  schemaDriftNotifiedAt: string | null; // DAEMON-LEVEL, NOT per-profile — guards the single T6 send
  // (step 0.6). Kept as a separate field from `degraded` on purpose: `degraded` answers "which
  // profiles are affected" (board/doctor drill-down, step 0.8/0.9); this field answers "has the
  // one allowed notification already gone out" (AC14) — conflating the two would either re-notify
  // per newly-degraded profile (violates AC14) or suppress board/doctor detail to match the
  // notification count (wrong information to withhold).
  schemaDriftNoNotifierWarnedAt: string | null; // DAEMON-LEVEL latch for the "no notifier
  // configured for any scheduled profile" skip warning (AC14/R15) — same precedent as
  // `schemaDriftNotifiedAt`: stamped the first tick the skip fires, checked before logging again,
  // so a contiguous degraded-with-no-notifier episode logs once instead of every 30s tick forever.
  // Cleared back to null the moment a tick DOES find a sender (the episode is over), so a later,
  // genuinely new no-notifier episode logs again. Deliberately its own field, not reused from
  // `schemaDriftNotifiedAt`: that field guards the one delivered ALERT and is never cleared once
  // stamped (AC14 — at most one alert per daemon lifetime); this field guards a LOG LINE and must
  // be able to reset mid-lifetime, or a transient notifier misconfiguration would permanently
  // suppress a real, later no-notifier episode.
  schemaDriftNotifyFailedAt: string | null; // DAEMON-LEVEL interval throttle for a sender FOUND
  // but the send itself failing (missing token, a 401, a timed-out fetch — the twin of
  // `schemaDriftNoNotifierWarnedAt`'s "no sender at all" case, same file, same shape). A hard
  // latch like the other two would be wrong here: a failed send deliberately never stamps
  // `schemaDriftNotifiedAt` (see `trackSchemaDriftAndNotify`'s doc comment), so the one guaranteed
  // alert must stay retryable — but retrying every 30s tick forever reproduces the exact
  // 2,880-lines/2,880-API-calls-a-day outage D2 exists to fix. So this field is a retry-interval
  // gate, not a one-shot: stamped on a failed send, checked before the NEXT attempt (skip both the
  // send and the log line while less than `SCHEMA_DRIFT_NOTIFY_RETRY_MS` has elapsed since it), and
  // cleared back to null the moment a send succeeds, so a later, genuinely new failure attempts
  // immediately rather than waiting out a stale interval.
  lastGateDecline?: {
    reasonCode: 'host-asleep' | 'network-unreachable';
    reason: string;
    at: string;
  };
  // Single rolling value, NOT an array — the gate is host-level, computed
  // once per tick and applied uniformly to every owed entry that tick
  // (step 1.11), so there is exactly one current reason at any moment,
  // never a per-slot history. A second gate decline (same tick or a later
  // one) simply overwrites this field wholesale via the normal
  // updateDaemonPidfile mutate-and-write pattern — deliberately less
  // structure than `degraded[]`. Optional (`?:`), not `| null`, mirroring
  // `inFlight?: DaemonInFlight`'s convention rather than the four
  // `schemaDrift*` fields' `T | null` convention. Kept for whatever cheap
  // "what was the last thing that happened" display value it's worth —
  // `deferred_sweep/sweep.ts`'s own per-SLOT reason attribution (bug 1) never
  // reads it; see `slotGateDeclines` below for why a single rolling field
  // cannot answer "why was THIS slot declined."
  slotGateDeclines: SlotGateDecline[];
  // Bug 1 (pipeline-stability-hardening QA, 2026-08-14): `lastGateDecline`
  // above is a single rolling value, overwritten by every gate-declined
  // owed entry — by the time a SPECIFIC slot's grace window fully closes
  // (`deferred_sweep/sweep.ts`'s own sweep, possibly many ticks and several OTHER
  // declined slots later), it usually holds a LATER slot's own reason, so
  // the recorded `deferred_slots` row silently misattributes. This is the
  // per-slot record that field cannot be: one entry per (profile, date,
  // slot) that was EVER seen gate-declined while still owed (written by
  // `applyGateDecline`, upserted so a later tick's decline for the SAME
  // slot replaces rather than duplicates its own entry), read by
  // `deferred_sweep/sweep.ts` once that slot's grace has fully closed. Filtered
  // to `date === today` on every write (same self-pruning idiom as
  // `attempts`), so yesterday's entries never linger.
  deferredNotifyAttempts: DeferredNotifyAttempt[];
  // Bug 2/6 (pipeline-stability-hardening QA, 2026-08-14): the last time an
  // attempt (successful or not) was made to send a deferred-day summary for
  // (profile, date) — covers BOTH the same-day T4 path and the retrospective
  // (past-day) summary path, since both compose and send the exact same
  // kind of message for the exact same (profile, date) pair.
  // `deferred_sweep/sweep.ts` skips the attempt (no send, no log) entirely while
  // less than `DEFERRED_NOTIFY_RETRY_INTERVAL_MS` has elapsed since the
  // last one — the same 1-hour-retry idiom as
  // `schemaDriftNotifyFailedAt`/`SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS`
  // (`alert/schema_drift.ts`), reused here rather than duplicated inline.
  // Deliberately NOT cleared on a successful `notify()` call: `markNotified`
  // is fail-soft (silently drops on a DB write error), so a SUCCEEDING send
  // immediately followed by a FAILING write must still stay throttled — see
  // this task's own report for the "escalation" this guards against.
  // Bug 9 (pipeline-stability-hardening QA round 2, 2026-08-14): pruned by
  // the entry's own `at` AGE on every `stampNotifyAttempt` write (dropped
  // once older than `DEFERRED_NOTIFY_ATTEMPT_MAX_AGE_MS`, 24h) — NOT by
  // `date === today` like `slotGateDeclines` below. The retrospective
  // sweep re-visits PAST dates every tick for as long as they stay
  // unnotified (`listUnnotifiedDatesBefore` has no date floor), so a
  // date-based prune would evict a still-active PAST-date throttle and
  // reopen bug 2 for exactly the dates this array protects; age-based
  // pruning only ever drops an entry once nothing has attempted that
  // (profile, date) pair in over a day.
}

export interface SlotGateDecline {
  profile: string;
  date: string; // 'YYYY-MM-DD' local — the OWED SLOT's own date, not
  // necessarily "today" by the time this entry is read (a slot's grace can
  // close well after its own date if the daemon is mid-batch past local
  // midnight — same posture as `deferred_slots.runDate`).
  slot: string; // 'HH:MM' local
  reasonCode: 'host-asleep' | 'network-unreachable'; // narrower than
  // `DeferredSlotRow.reasonCode`'s three-value union — same reasoning as
  // `lastGateDecline`'s own `reasonCode` field (see its doc comment).
  reason: string;
  at: string; // ISO 8601 — when this decline was last observed for this slot.
}

export interface DeferredNotifyAttempt {
  profile: string;
  date: string; // 'YYYY-MM-DD' — the deferred day being summarized.
  at: string; // ISO 8601 — the last attempt time, success or failure.
}

export interface DaemonPidfileDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  writeFileSyncExclusive(path: string, data: string): boolean; // wx flag; false on EEXIST
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  pidIsAlive(pid: number): boolean;
  now(): Date;
}

/** 5 minutes = 10 missed ticks at the 30s cadence (D22). Replaces
 * run_lock.ts's 4-hour age rule, which is correct for a single bounded
 * run and wrong for a process meant to live for days: from hour 4 onward
 * it would judge every healthy daemon stale and let a new `serve start`
 * steal a live daemon's pidfile. */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

export function daemonPidfilePath(root: string): string {
  return join(root, '.jobbunny-daemon.pid');
}

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

/** Creates the pidfile via an exclusive (`wx`) write — the actual
 * mutual-exclusion guarantee, identical mechanism to run_lock.ts's
 * tryCreate. Returns false (does not throw) if a pidfile already exists;
 * the caller is responsible for staleness-checking and stealing it. */
export function acquireDaemonPidfile(
  root: string,
  pid: number,
  deps: DaemonPidfileDeps,
): boolean {
  const path = daemonPidfilePath(root);
  const initial: DaemonPidfile = {
    pid,
    startedAt: deps.now().toISOString(),
    lastTickAt: deps.now().toISOString(),
    attempts: [],
    degraded: [],
    schemaDriftNotifiedAt: null,
    schemaDriftNoNotifierWarnedAt: null,
    schemaDriftNotifyFailedAt: null,
    slotGateDeclines: [],
    deferredNotifyAttempts: [],
  };
  return deps.writeFileSyncExclusive(path, JSON.stringify(initial));
}

function parsePidfile(raw: string): DaemonPidfile | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonPidfile>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.lastTickAt === 'string' &&
      Array.isArray(parsed.attempts)
    ) {
      return {
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        lastTickAt: parsed.lastTickAt,
        inFlight: parseInFlight(parsed.inFlight),
        attempts: parsed.attempts as DaemonAttempt[],
        degraded: parseDegraded(parsed.degraded),
        schemaDriftNotifiedAt: parseNullableTimestamp(parsed.schemaDriftNotifiedAt),
        schemaDriftNoNotifierWarnedAt: parseNullableTimestamp(
          parsed.schemaDriftNoNotifierWarnedAt,
        ),
        schemaDriftNotifyFailedAt: parseNullableTimestamp(
          parsed.schemaDriftNotifyFailedAt,
        ),
        lastGateDecline: parseLastGateDecline(parsed.lastGateDecline),
        slotGateDeclines: parseSlotGateDeclines(parsed.slotGateDeclines),
        deferredNotifyAttempts: parseDeferredNotifyAttempts(
          parsed.deferredNotifyAttempts,
        ),
      };
    }
    return undefined; // malformed shape — treated the same as unreadable.
  } catch {
    return undefined; // corrupt JSON — same treatment.
  }
}

/** Reads and parses the pidfile. A reader that fails to parse retries
 * once — the same "unreadable ⇒ stale ⇒ safe to steal" posture
 * run_lock.ts already documents for its own lock file — before treating
 * the file as corrupt and returning undefined. Returns undefined (never
 * throws) when the pidfile doesn't exist. */
export function readDaemonPidfile(
  root: string,
  deps: DaemonPidfileDeps,
): DaemonPidfile | undefined {
  const path = daemonPidfilePath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = deps.readFileSync(path);
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return undefined;
      throw err;
    }
    const parsed = parsePidfile(raw);
    if (parsed) return parsed;
    // First attempt failed to parse — retry once before giving up.
  }
  return undefined;
}

/** Every in-place update (heartbeat, inFlight, attempts) goes through
 * here: SYNCHRONOUS write-to-temp then rename-over-target. Synchronous,
 * not an async temp-write-then-rename, so the heartbeat write Task 7
 * places outside the reentrancy guard can never interleave with this same
 * function's own guarded-body calls — Node's single-threaded event loop
 * runs a sync write-then-rename to completion without yielding.
 *
 * Returns FALSE when the pidfile is currently unreadable (missing or
 * corrupt) and the update was therefore a no-op — nothing safe to mutate.
 * That return value is load-bearing for the D19 attempts ledger: a silent
 * no-op there means the ledger append never lands, every tick re-derives
 * the same slot as owed, and a doctor-red profile respawns a run every
 * 30s. Callers whose write is genuinely best-effort (the heartbeat) may
 * ignore it; `daemon.ts`'s pre-spawn ledger append must not. */
export function updateDaemonPidfile(
  root: string,
  mutate: (current: DaemonPidfile) => DaemonPidfile,
  deps: DaemonPidfileDeps,
): boolean {
  const current = readDaemonPidfile(root, deps);
  if (!current) return false;
  const next = mutate(current);
  const path = daemonPidfilePath(root);
  const tmpPath = `${path}.tmp`;
  deps.writeFileSync(tmpPath, JSON.stringify(next));
  deps.renameSync(tmpPath, path);
  return true;
}

/** Removes the pidfile. Tolerates an already-absent file (nothing to do). */
export function releaseDaemonPidfile(root: string, deps: DaemonPidfileDeps): void {
  const path = daemonPidfilePath(root);
  try {
    deps.unlinkSync(path);
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) throw err;
  }
}

/** Stale (safe to steal) when the recorded pid is dead, OR the heartbeat
 * (lastTickAt) is older than HEARTBEAT_STALE_MS — NOT run_lock.ts's
 * 4-hour DEFAULT_MAX_AGE_MS, which is the wrong rule for a long-lived
 * daemon (see HEARTBEAT_STALE_MS's doc comment above). An undefined
 * (missing or corrupt) pidfile is always stale, and so is a lastTickAt
 * that won't parse: a NON-FINITE age is a heartbeat this daemon can no
 * longer prove is fresh, which is exactly what `serve status` already
 * reports as wedged. Treating it as fresh instead would pin a wedged
 * daemon in place forever — no `serve start` could ever steal it. The
 * steal itself is still not immediate for a live pid: `serve start`'s own
 * 35s re-check (which compares lastTickAt for CHANGE, not parseability)
 * backs off the moment the incumbent heartbeats again. */
export function isDaemonPidfileStale(
  file: DaemonPidfile | undefined,
  deps: DaemonPidfileDeps,
): boolean {
  if (!file) return true;
  if (!deps.pidIsAlive(file.pid)) return true;
  const age = deps.now().getTime() - Date.parse(file.lastTickAt);
  return !Number.isFinite(age) || age > HEARTBEAT_STALE_MS;
}

/** Builds the real (non-test) DaemonPidfileDeps. Mirrors
 * run_lock.ts's defaultRunLockDeps exactly. */
export function defaultDaemonPidfileDeps(): DaemonPidfileDeps {
  return {
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p, 'utf8'),
    writeFileSync: (p, data) => {
      writeFileSync(p, data, 'utf8');
    },
    writeFileSyncExclusive: (p, data) => {
      try {
        writeFileSync(p, data, { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (err) {
        if (hasCode(err, 'EEXIST')) return false;
        throw err;
      }
    },
    renameSync: (from, to) => renameSync(from, to),
    unlinkSync: (p) => unlinkSync(p),
    pidIsAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // ESRCH: no such process — dead. EPERM: exists but owned by
        // someone else — still alive. Anything else: assume alive.
        return !hasCode(err, 'ESRCH');
      }
    },
    now: () => new Date(),
  };
}
