/**
 * appinfo routes — a single `GET /api/app` endpoint exposing the running
 * server's version, injected at wire time (`cli/commands/board.ts` reads
 * `package.json`; `app/` stays I/O-free per `app-only-ports-core`).
 */
import type { RouteDef } from '../../shared/index.ts';

export interface AppInfoResponse {
  version: string;
}

export function makeAppInfoRoutes(version: string): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/app',
      handler: () => ({ status: 200, body: { version } satisfies AppInfoResponse }),
    },
  ];
}
