/**
 * ports/board_daemon.ts (fix round, file-size cap) — the daemon-control
 * result types `BoardSource`'s daemon methods (`readDaemonStatus`/
 * `stopDaemon`/`startDaemon`/`setAutostart`) return, split out of
 * `board.ts` purely because that file crossed the 400-line cap (a pure type
 * relocation — no behavior change). Re-exported from `board.ts` itself
 * (`export type { ... } from './board_daemon.ts'`) so every existing
 * `from '../../ports/board.ts'` import keeps working unchanged — mirrors
 * `cli/wire/board_daemon.ts`'s own precedent for splitting a `BoardSource`
 * concern out of `board.ts` purely for the size cap.
 */

export type DaemonState = 'running' | 'stopped' | 'stale';

export interface DaemonProfileSchedule {
  profile: string;
  enabled: boolean;
  /** ISO 8601 UTC, or `null` when the profile has no enabled schedule. */
  nextRunAt: string | null;
  degraded: boolean;
  degradedReason: string | null; // human-readable, mirrors T6's cause line, null when not degraded
  schemaVersion: number | null; // the profile's own DB schema version when degraded, else null
  buildVersion: number | null; // this daemon build's LATEST_SCHEMA_VERSION when degraded, else null
}

export interface DaemonStatus {
  state: DaemonState;
  pid: number | null;
  startedAt: string | null;
  lastTickAt: string | null;
  inFlight: { profile: string; pid: number; startedAt: string } | null;
  profiles: DaemonProfileSchedule[];
}

/** `BoardSource.stopDaemon`'s result (R20 = Option 1, board-initiated
 * detached spawn). Deliberately NOT a bare "did the signal go through" —
 * `'stopped'` is reached only after the FULL kill-and-confirm lifecycle
 * (`cli/wire/board_daemon_control.ts`, reusing `cli/commands/serve/
 * lifecycle.ts`'s `runServeStop` sequence) succeeds for both the daemon and
 * any in-flight run child it owned. `'daemon_unresponsive'`/
 * `'child_unresponsive'` are DISTINCT, visible failures — a daemon or child
 * that survives SIGKILL must NEVER be reported as `'already_stopped'`; that
 * would be a false success (the exact defect BE-gate finding F1 caught in
 * this step's original spec). `'child_unresponsive'` carries `childPid`
 * because a stuck run child is a different operator action (manual `kill
 * -9`, or a reboot) than a stuck daemon.
 *
 * `'stale_pidfile'` (stability-review fix): `startDaemon()`'s `ServeDeps.pid`
 * is deliberately the BOARD SERVER's own pid (the not-yet-spawned daemon
 * child has no pid to give it) — `acquireDaemonPidfile` writes that pid into
 * the pidfile BEFORE the child spawns, and only the child's own first action
 * overwrites it with its real pid. A pidfile read here that still names THIS
 * process is therefore never a real running daemon: either a `stopDaemon()`
 * call raced that boot window, or an earlier `startDaemon()` spawn-setup
 * failure leaked the placeholder (now closed by releasing on that catch
 * path too — see `startBoardDaemon`'s own doc comment). Killing it would
 * kill the board server itself, so this outcome is reported instead of
 * ever reaching `killAndConfirmDead`. */
export type StopDaemonOutcome =
  | { outcome: 'stopped' }
  | { outcome: 'already_stopped' }
  | { outcome: 'daemon_unresponsive' }
  | { outcome: 'child_unresponsive'; childPid: number }
  | { outcome: 'stale_pidfile' };

/** `BoardSource.startDaemon`'s result (R20 = Option 1, board-initiated
 * detached spawn — task 12, this brief's Start counterpart to
 * `StopDaemonOutcome` above). `'started'` and `'already_running'` are BOTH
 * a success from the caller's point of view (the daemon ends up running
 * either way — the same "target state reached" posture `'already_stopped'`
 * takes on the stop side), while `'spawn_failed'` is a DISTINCT, visible
 * failure — never collapsed into a false success. Defined HERE, not in
 * `cli/wire/`, for the identical reachability reason `StopDaemonOutcome`
 * is: a `cli/wire/` type is not reachable through the `ports` →
 * `app/features/<name>/index.ts` → `ui/src/lib/api/types.ts` chain. */
export type StartDaemonOutcome = {
  outcome: 'started' | 'already_running' | 'spawn_failed';
};

/** `BoardSource.setAutostart`'s result (R20 = Option 1, task 13 — the
 * Autostart counterpart to `StopDaemonOutcome`/`StartDaemonOutcome` above).
 * Named EXACTLY `AutostartOutcome` — product-ui's own blueprint already
 * assumes this name for this control. `'ok'` covers every darwin outcome
 * short of a real, blocking refusal, including tolerated launchctl hiccups
 * (`autostart.ts:228-231`) — the board never surfaces those as a request
 * failure. `'unsupported_platform'` is reached on any non-darwin
 * `process.platform`, with no filesystem or `launchctl` side effect
 * attempted. Defined HERE, not `cli/wire/`, same reachability reason as
 * `StopDaemonOutcome`/`StartDaemonOutcome`.
 *
 * No slot exists here for the darwin legacy-plist-conflict refusal
 * (`runEnable`, exit 1, enable only — NO plist written, `launchctl` never
 * called): fix round F13 surfaces THAT case as a thrown
 * `HttpError(409, 'autostart_conflict', ...)` instead of silently
 * returning `{outcome:'ok'}` — see `board_autostart_control.ts`'s
 * `setBoardAutostart`. */
export type AutostartOutcome = { outcome: 'ok' | 'unsupported_platform' };
