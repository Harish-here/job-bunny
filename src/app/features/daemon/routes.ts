/**
 * Daemon routes (UI phase 1, Task 7; settings-overhaul task 11 adds Stop) —
 * `GET /api/daemon` is a read-only view over `BoardSource.readDaemonStatus`
 * (reads the daemon's own pidfile plus each profile's next scheduled slot,
 * `cli/wire/board.ts`'s `readDaemonStatus`). `POST /api/daemon/stop` calls
 * `BoardSource.stopDaemon()` and returns its `StopDaemonOutcome` directly
 * as the response body — no envelope. Mirrors `features/doctor/routes.ts`'s
 * shape: no `service.ts` (two-pair rule keeps this slice at one impl file
 * plus `index.ts`).
 *
 * `stopDaemon()` never throws, so this handler never needs a try/catch —
 * every outcome is a value. The two unresponsive outcomes
 * (`daemon_unresponsive`/`child_unresponsive`) map to a 409 so the client
 * can never mistake them for the 200 `stopped`/`already_stopped` success
 * line — the exact status code is a UI-side decision (per the design doc),
 * but it must never read as success for either.
 */
import type { BoardSource, StopDaemonOutcome } from '../../../ports/board.ts';
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

export function makeDaemonRoutes(source: BoardSource): RouteDef[] {
  return [
    { method: 'GET', path: '/api/daemon', handler: statusHandler(source) },
    { method: 'POST', path: '/api/daemon/stop', handler: stopHandler(source) },
  ];
}
