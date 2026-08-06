/**
 * cli/commands/serve/status.ts — `serve status`'s rendering: pid/uptime,
 * last-tick heartbeat (with a "wedged" flag), in-flight child, and
 * next-fire lines. Split out of `serve.ts` (task 5, 2026-07-28 file-size
 * split plan); see `./index.ts` for the shared `ServeDeps` bag and
 * dispatch.
 */
import { formatLocalDate, isRunOwed, nextFireAt } from '../../../core/schedule/index.ts';
import { HEARTBEAT_STALE_MS, readDaemonPidfile } from '../../../ops/daemon/index.ts';
import { scanProfileSchedules } from '../../../ops/daemon/scan/index.ts';
import type { ServeDeps } from './index.ts';

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h${m}m${s}s`;
}

export async function runServeStatus(deps: ServeDeps): Promise<number> {
  const file = readDaemonPidfile(deps.root, deps.pidfile);
  if (!file || !deps.pidIsAlive(file.pid)) {
    deps.write('serve status: not running');
    return 1;
  }

  const now = deps.now();
  deps.write(
    `serve status: running (pid ${file.pid}, uptime ${formatDuration(now.getTime() - Date.parse(file.startedAt))})`,
  );

  const heartbeatAgeMs = now.getTime() - Date.parse(file.lastTickAt);
  if (!Number.isFinite(heartbeatAgeMs)) {
    // An unparseable lastTickAt is suspicious, not benign: the operator
    // gets the raw value plus the wedged flag rather than `NaNhNaNmNaNs`,
    // which reads as a rendering bug and hides the real problem. Same
    // verdict `isDaemonPidfileStale` reaches for the same file (a
    // non-finite age is stale) — status only REPORTS it, while `serve
    // start` acts on it, one 35s re-check later.
    deps.write(`  last tick: ${file.lastTickAt} (age unknown) — appears wedged`);
  } else {
    const wedged = heartbeatAgeMs > HEARTBEAT_STALE_MS;
    deps.write(
      `  last tick: ${file.lastTickAt} (${formatDuration(heartbeatAgeMs)} ago)` +
        (wedged ? ' — appears wedged' : ''),
    );
  }
  // §6.1: reports the profile and elapsed time, not just the pid — the
  // bare `pid ${n}` form told an operator nothing about WHICH profile
  // was running or for how long.
  deps.write(
    file.inFlight !== undefined
      ? `  in flight: pid ${file.inFlight.pid} (profile ${file.inFlight.profile}, running ` +
          `${formatDuration(now.getTime() - Date.parse(file.inFlight.startedAt))})`
      : '  in flight: none',
  );

  const schedules = scanProfileSchedules(deps.profilesDir, deps.scan);
  const next = nextFireAt(now, schedules);
  deps.write(
    next
      ? `  next fire: ${next.at.toISOString()} (${next.runs.map((r) => r.profile).join(', ')})`
      : '  next fire: none scheduled',
  );

  // D19: the same durable-db-history-plus-ledger merge daemon.ts's own tick
  // uses — the db history alone would over-report a slot a synthetic
  // ledger entry already served.
  const date = formatLocalDate(now);
  const dbHistory = deps.readRunHistory(
    schedules.map((s) => s.profile),
    date,
  );
  const ledgerHistory = file.attempts
    .filter((a) => a.date === date)
    .map((a) => ({ profile: a.profile, date: a.date, startedAt: a.slot }));
  const owed = isRunOwed(now, schedules, [...dbHistory, ...ledgerHistory]);
  if (owed.length > 0) {
    deps.write(
      `  currently owed: ${owed.map((o) => `${o.profile}@${o.slot}`).join(', ')}`,
    );
  }

  return 0;
}
