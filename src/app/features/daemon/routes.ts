/**
 * Daemon status route (UI phase 1, Task 7) — a single, read-only endpoint
 * over `BoardSource.readDaemonStatus`, which reads the daemon's own
 * pidfile plus each profile's next scheduled slot (`cli/wire/board.ts`'s
 * `readDaemonStatus`). Mirrors `features/doctor/routes.ts`'s single-route
 * shape: no `service.ts` (two-pair rule keeps this slice at exactly one
 * impl file plus `index.ts`).
 */
import type { BoardSource } from '../../../ports/board.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';

function handler(source: BoardSource) {
  return async (_req: BoardRequest): Promise<BoardResponse> => {
    return { status: 200, body: await source.readDaemonStatus() };
  };
}

export function makeDaemonRoutes(source: BoardSource): RouteDef[] {
  return [{ method: 'GET', path: '/api/daemon', handler: handler(source) }];
}
