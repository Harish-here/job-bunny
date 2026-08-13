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
  notify: (profile: string, event: NotifyEvent) => Promise<void>;
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
          `Cause: the database schema (v${degraded[0]!.schemaVersion}) is newer than the`,
          `running daemon's build (v${degraded[0]!.buildVersion}). This happens after an`,
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
      ? `Affected profiles: ${degraded[0]!.profile}`
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
    deps.log(
      'schema-drift-notify-skipped-no-notifier',
      { degraded: after.degraded.map((d) => d.profile) },
      'warn',
    );
    return;
  }

  const text = composeSchemaDriftAlertText(after.degraded);
  await deps.notify(sender, { kind: 'alert', profile: sender, text });
  updateDaemonPidfile(
    deps.root,
    (current) => ({ ...current, schemaDriftNotifiedAt: now.toISOString() }),
    deps.pidfile,
  );
}
