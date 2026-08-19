/**
 * Daemon routes (UI phase 1, Task 7; settings-overhaul task 11 adds Stop,
 * task 12 adds Start) — `GET /api/daemon` is a read-only view over
 * `BoardSource.readDaemonStatus` (reads the daemon's own pidfile plus each
 * profile's next scheduled slot, `cli/wire/board.ts`'s `readDaemonStatus`).
 * `POST /api/daemon/stop` and `POST /api/daemon/start` call
 * `BoardSource.stopDaemon()`/`startDaemon()` and return the outcome
 * directly as the response body — no envelope. Mirrors
 * `features/doctor/routes.ts`'s shape: no `service.ts` (two-pair rule keeps
 * this slice at one impl file plus `index.ts`).
 *
 * `stopDaemon()`/`startDaemon()` never throw, so neither handler needs a
 * try/catch — every outcome is a value. `stopDaemon`'s two unresponsive
 * outcomes (`daemon_unresponsive`/`child_unresponsive`) map to a 409 so the
 * client can never mistake them for the 200 `stopped`/`already_stopped`
 * success line. `startDaemon`'s `'started'`/`'already_running'` both map
 * to 200 — the daemon ends up running either way, the same "target state
 * reached" posture `'already_stopped'` gets on the stop side — while
 * `'spawn_failed'` maps to 500 (a genuine operational failure, not a state
 * conflict) so it can never read as success. The exact status codes are a
 * UI-side decision (per the design doc); this mapping just guarantees no
 * failure outcome on either route is ever indistinguishable from success. */
import type {
  BoardSource,
  StartDaemonOutcome,
  StopDaemonOutcome,
} from '../../../ports/board.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';

function statusHandler(source: BoardSource) {
  return async (_req: BoardRequest): Promise<BoardResponse> => {
    return { status: 200, body: await source.readDaemonStatus() };
  };
}

function stopStatusCode(outcome: StopDaemonOutcome): number {
  return outcome.outcome === 'daemon_unresponsive' ||
    outcome.outcome === 'child_unresponsive'
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

export function makeDaemonRoutes(source: BoardSource): RouteDef[] {
  return [
    { method: 'GET', path: '/api/daemon', handler: statusHandler(source) },
    { method: 'POST', path: '/api/daemon/stop', handler: stopHandler(source) },
    { method: 'POST', path: '/api/daemon/start', handler: startHandler(source) },
  ];
}
