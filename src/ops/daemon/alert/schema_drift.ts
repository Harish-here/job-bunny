import type { ProfileSchedule } from '../../../core/schedule/index.ts';
import type { NotifyEvent } from '../../../ports/notifier.ts';
import type { DaemonDegradedEntry, DaemonPidfileDeps } from '../pidfile.ts';
import { readDaemonPidfile, updateDaemonPidfile } from '../pidfile.ts';

/** Narrow, structural dependency slice — deliberately NOT `DaemonDeps`
 * (importing that type here would create a daemon.ts <-> alert/index.ts
 * import cycle). `DaemonDeps` satisfies this shape structurally, so
 * daemon.ts passes its own `deps` straight through with no cast. */
export interface SchemaDriftAlertDeps {
  root: string;
  pidfile: DaemonPidfileDeps;
  /** Resolves `true` iff at least one configured notifier actually sent —
   * see `wireDaemonNotifier`'s own doc comment. `trackSchemaDriftAndNotify`
   * below stamps `schemaDriftNotifiedAt` ONLY on `true`, so a `false` (no
   * notifier configured for anyone, or every send failed — missing token,
   * 401, timeout) leaves the alert eligible for retry on a later tick. */
  notify: (profile: string, event: NotifyEvent) => Promise<boolean>;
  hasNotifierConfigured: (profile: string) => Promise<boolean>;
  log: (
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ) => void;
}

/** T6 (`tg-daemon-degraded`) plaintext — the mockup's literal single
 * -profile copy (`ux-notes.md` §4 T6) when exactly one profile is
 * degraded; a generalized cause line plus a per-profile version
 * breakdown in the `Affected profiles:` line when more than one is
 * (ux-notes.md has no literal N>1 copy — see this task's brief for the
 * judgment call). Pure — no clock read, no I/O. */
export function composeSchemaDriftAlertText(
  degraded: readonly DaemonDegradedEntry[],
): string {
  const buildVersion = degraded[0]?.buildVersion;
  const causeLines =
    degraded.length === 1
      ? [
          `Cause: the database schema (v${degraded[0]?.schemaVersion}) is newer than the`,
          `running daemon's build (v${degraded[0]?.buildVersion}). This happens after an`,
          `update that changes the schema.`,
        ]
      : [
          `Cause: at least one profile's database schema is newer than the`,
          `running daemon's build (v${buildVersion}). This happens after an update that`,
          `changes the schema. Each affected profile's own schema version is`,
          `listed below.`,
        ];
  const affectedLine =
    degraded.length === 1
      ? `Affected profiles: ${degraded[0]?.profile}`
      : `Affected profiles: ${degraded
          .map((d) => `${d.profile} (v${d.schemaVersion})`)
          .join(', ')}`;
  return [
    '⚠️ Job Bunny — daemon degraded',
    '',
    'The scheduler has STOPPED starting runs.',
    '',
    ...causeLines,
    '',
    affectedLine,
    '',
    'Fix: restart the daemon —',
    '  jobbunny serve stop',
    '  jobbunny serve start',
    '',
    'No scheduled runs will start until you do.',
  ].join('\n');
}

/** Short, single-profile "mirrors T6's cause line" sentence — the
 * per-profile drill-down text both the board (`ports/board.ts`'s
 * `DaemonProfileSchedule.degradedReason`, step 0.8) and `jobbunny
 * doctor` (step 0.9) show. Deliberately distinct from
 * `composeSchemaDriftAlertText`, which is the daemon-level, possibly
 * multi-profile T6 ALERT text — this is always exactly one profile's
 * own sentence. */
export function degradedReasonText(entry: DaemonDegradedEntry): string {
  return `the database schema (v${entry.schemaVersion}) is newer than the running daemon's build (v${entry.buildVersion}). This happens after an update that changes the schema.`;
}

/** Minimum gap between consecutive send ATTEMPTS once a sender exists but a
 * prior attempt failed (missing token, a 401, a timed-out fetch) — the
 * `schemaDriftNotifyFailedAt` throttle in `trackSchemaDriftAndNotify` below.
 * A failed send deliberately never stamps `schemaDriftNotifiedAt` (the one
 * guaranteed alert must stay retryable — see that field's own doc comment),
 * so without this gate every 30s tick would re-attempt forever: the exact
 * 2,880-lines/2,880-API-calls-a-day outage D2 exists to fix, just shifted
 * one branch over (sender found, send failed, vs. no sender at all). One
 * hour bounds worst-case retries to ~24/day while still landing the alert
 * within an hour of the underlying problem (e.g. a revoked token) being
 * fixed. */
export const SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS = 60 * 60_000;

/** Phase 0 (D2 self-heal): (1) records every newly-degraded profile
 * (present in `schemaDrift` this tick, not yet in the pidfile's
 * `degraded` array) — accurate detection for board/doctor drill-down,
 * every tick, regardless of notification state; (2) dispatches the
 * SINGLE daemon-level T6 alert (AC14) — at most once per pidfile
 * lifetime (cleared only by a daemon restart), to the
 * alphabetically-first scheduled profile that actually has a notifier
 * configured. Never throws — a failed pidfile write here is logged by
 * the caller's own posture (fire-and-forget), never fatal to the tick. */
export async function trackSchemaDriftAndNotify(
  deps: SchemaDriftAlertDeps,
  schemaDrift: ReadonlyMap<string, { schemaVersion: number; buildVersion: number }>,
  schedules: readonly ProfileSchedule[],
  now: Date,
): Promise<void> {
  if (schemaDrift.size === 0) return;

  const before = readDaemonPidfile(deps.root, deps.pidfile);
  const alreadyDegraded = new Set((before?.degraded ?? []).map((d) => d.profile));
  const newlyDegraded: DaemonDegradedEntry[] = [];
  for (const [profile, info] of schemaDrift) {
    if (!alreadyDegraded.has(profile)) {
      newlyDegraded.push({
        profile,
        schemaVersion: info.schemaVersion,
        buildVersion: info.buildVersion,
        detectedAt: now.toISOString(),
      });
    }
  }
  if (newlyDegraded.length > 0) {
    updateDaemonPidfile(
      deps.root,
      (current) => ({ ...current, degraded: [...current.degraded, ...newlyDegraded] }),
      deps.pidfile,
    );
  }

  const after = readDaemonPidfile(deps.root, deps.pidfile);
  if (!after || after.degraded.length === 0 || after.schemaDriftNotifiedAt !== null)
    return;

  const sortedProfiles = [...schedules]
    .map((s) => s.profile)
    .sort((a, b) => a.localeCompare(b));
  let sender: string | undefined;
  for (const profile of sortedProfiles) {
    // Sequential, awaited — NOT Array.prototype.find with an async
    // predicate (that never awaits and always "finds" the first
    // element regardless of the real result; see this task's brief).
    if (await deps.hasNotifierConfigured(profile)) {
      sender = profile;
      break;
    }
  }
  if (sender === undefined) {
    // Latched, not per-tick (AC14/R15): log the skip once per contiguous
    // degraded-with-no-notifier episode, not every 30s tick forever — the
    // 2,880-lines-a-day repeat is the exact outage D2 exists to fix. See
    // `schemaDriftNoNotifierWarnedAt`'s doc comment in pidfile.ts.
    if (after.schemaDriftNoNotifierWarnedAt === null) {
      deps.log(
        'schema-drift-notify-skipped-no-notifier',
        { degraded: after.degraded.map((d) => d.profile) },
        'warn',
      );
      updateDaemonPidfile(
        deps.root,
        (current) => ({ ...current, schemaDriftNoNotifierWarnedAt: now.toISOString() }),
        deps.pidfile,
      );
    }
    return;
  }

  // A sender was found this tick — the no-notifier episode (if any) is
  // over. Reset the latch so a later, genuinely new episode logs again.
  if (after.schemaDriftNoNotifierWarnedAt !== null) {
    updateDaemonPidfile(
      deps.root,
      (current) => ({ ...current, schemaDriftNoNotifierWarnedAt: null }),
      deps.pidfile,
    );
  }

  // A sender was found but a PRIOR attempt failed: throttle re-attempts to
  // at most once per `SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS`, or this branch
  // hammers the sender's notify() (and logs a warn line) every 30s tick
  // forever — the exact repeated-line/repeated-API-call shape D2 exists to
  // eliminate, just on the "sender found, send failed" twin of the
  // no-notifier branch above. Skip BOTH the send attempt and the log line
  // entirely while still within the interval — not just the log line.
  if (after.schemaDriftNotifyFailedAt !== null) {
    const elapsed = now.getTime() - Date.parse(after.schemaDriftNotifyFailedAt);
    if (Number.isFinite(elapsed) && elapsed <= SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS) {
      return;
    }
  }

  const text = composeSchemaDriftAlertText(after.degraded);
  const sent = await deps.notify(sender, { kind: 'alert', profile: sender, text });
  if (!sent) {
    // Delivery never happened (missing token, a 401, a timed-out fetch —
    // see `wireDaemonNotifier`'s doc comment): leave `schemaDriftNotifiedAt`
    // null so a LATER qualifying tick retries, instead of permanently
    // suppressing the one guaranteed alert on a send that never landed.
    // Stamp `schemaDriftNotifyFailedAt` so that retry is interval-bounded
    // (see its doc comment in pidfile.ts) rather than every-tick.
    deps.log(
      'schema-drift-notify-failed',
      { profile: sender, degraded: after.degraded.map((d) => d.profile) },
      'warn',
    );
    updateDaemonPidfile(
      deps.root,
      (current) => ({ ...current, schemaDriftNotifyFailedAt: now.toISOString() }),
      deps.pidfile,
    );
    return;
  }

  deps.log('schema-drift-notify-sent', { profile: sender }, 'info');
  updateDaemonPidfile(
    deps.root,
    (current) => ({
      ...current,
      schemaDriftNotifiedAt: now.toISOString(),
      schemaDriftNotifyFailedAt: null,
    }),
    deps.pidfile,
  );
}
