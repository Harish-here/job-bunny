/**
 * Daemon routes (UI phase 1, Task 7; settings-overhaul task 11 adds Stop,
 * task 12 adds Start, task 13 adds Autostart) — `GET /api/daemon` is a
 * read-only view over `BoardSource.readDaemonStatus` (reads the daemon's
 * own pidfile plus each profile's next scheduled slot,
 * `cli/wire/board.ts`'s `readDaemonStatus`). `POST /api/daemon/stop`,
 * `POST /api/daemon/start`, and `PUT /api/daemon/autostart` call
 * `BoardSource.stopDaemon()`/`startDaemon()`/`setAutostart()` and return
 * the outcome directly as the response body — no envelope. Mirrors
 * `features/doctor/routes.ts`'s shape: no `service.ts` (two-pair rule keeps
 * this slice at one impl file plus `index.ts`).
 *
 * `stopDaemon()`/`startDaemon()` never throw, so their handlers need no
 * try/catch — every outcome is a value. `stopDaemon`'s three non-success
 * outcomes (`daemon_unresponsive`/`child_unresponsive`/`stale_pidfile`) map
 * to a 409 so the client can never mistake them for the 200
 * `stopped`/`already_stopped` success line — `stale_pidfile` (stability-
 * review fix) means the pidfile named the board server's own pid, so
 * nothing was actually stopped even though there was no daemon left to
 * kill either; collapsing it into `already_stopped` would hide that
 * anomaly. `startDaemon`'s `'started'`/`'already_running'` both map to
 * 200 — the daemon ends up running either way, the same "target state
 * reached" posture `'already_stopped'` gets on the stop side — while
 * `'spawn_failed'` maps to 500 (a genuine operational failure, not a state
 * conflict) so it can never read as success. The exact status codes are a
 * UI-side decision (per the design doc); this mapping just guarantees no
 * failure outcome on any route is ever indistinguishable from success.
 * `setAutostart`'s two RETURNED outcomes are BOTH a legitimate, non-error
 * result (`'ok'` the toggle applied, `'unsupported_platform'` there was
 * nothing to apply on this OS) — both map to 200, the body itself carries
 * the distinction; the request body is validated with zod before it ever
 * reaches `BoardSource`. Fix round F13: `setAutostart` CAN also throw
 * `HttpError(409, 'autostart_conflict', ...)` for a darwin legacy-plist
 * conflict the `AutostartOutcome` type has no slot for — no local
 * try/catch is needed for that either, since `server.ts`'s existing
 * generic `HttpError` catch (the same one `router.ts`'s `param()` already
 * relies on) handles it. */
import { z } from 'zod';
import type {
  AutostartOutcome,
  BoardSource,
  StartDaemonOutcome,
  StopDaemonOutcome,
} from '../../../ports/board.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';

function statusHandler(source: BoardSource) {
  return async (_req: BoardRequest): Promise<BoardResponse> => {
    return { status: 200, body: await source.readDaemonStatus() };
  };
}

function stopStatusCode(outcome: StopDaemonOutcome): number {
  return outcome.outcome === 'daemon_unresponsive' ||
    outcome.outcome === 'child_unresponsive' ||
    outcome.outcome === 'stale_pidfile'
    ? 409
    : 200;
}

function stopHandler(source: BoardSource) {
  return async (_req: BoardRequest): Promise<BoardResponse> => {
    const outcome = await source.stopDaemon();
    return { status: stopStatusCode(outcome), body: outcome };
  };
}

function startStatusCode(outcome: StartDaemonOutcome): number {
  return outcome.outcome === 'spawn_failed' ? 500 : 200;
}

function startHandler(source: BoardSource) {
  return async (_req: BoardRequest): Promise<BoardResponse> => {
    const outcome = await source.startDaemon();
    return { status: startStatusCode(outcome), body: outcome };
  };
}

const AutostartBodySchema = z.object({ enabled: z.boolean() });

function autostartHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const parsed = AutostartBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'validation', 'enabled must be a boolean');
    }
    const outcome: AutostartOutcome = await source.setAutostart(parsed.data.enabled);
    return { status: 200, body: outcome };
  };
}

export function makeDaemonRoutes(source: BoardSource): RouteDef[] {
  return [
    { method: 'GET', path: '/api/daemon', handler: statusHandler(source) },
    { method: 'POST', path: '/api/daemon/stop', handler: stopHandler(source) },
    { method: 'POST', path: '/api/daemon/start', handler: startHandler(source) },
    { method: 'PUT', path: '/api/daemon/autostart', handler: autostartHandler(source) },
  ];
}
