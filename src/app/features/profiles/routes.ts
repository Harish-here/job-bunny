/** The single profiles-list route: discovery only, no store touched. */
import type { BoardProfile, BoardSource } from '../../../ports/board.ts';
import type { RouteDef } from '../../shared/index.ts';

export interface ProfilesResponse {
  profiles: BoardProfile[];
}

export function makeProfilesRoutes(source: BoardSource): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/profiles',
      handler: async () => {
        const body: ProfilesResponse = { profiles: await source.listProfiles() };
        return { status: 200, body };
      },
    },
  ];
}
