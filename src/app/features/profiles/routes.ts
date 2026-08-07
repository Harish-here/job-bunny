/**
 * Discovery (`GET /api/profiles`, no store touched) plus guarded removal
 * (`DELETE /api/profiles/:name`, UI phase 1 Task 8 — FLAGGED: permanently
 * deletes user data). The handler is a thin outcome-to-HTTP mapping; every
 * actual guard (membership, protected, running run, pending intent,
 * handle release, delete) lives in `BoardSource.removeProfile`
 * (`cli/wire/board.ts`), per this module's own layering — a route handler
 * never touches the filesystem directly.
 */
import type { BoardProfile, BoardSource } from '../../../ports/board.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';

export interface ProfilesResponse {
  profiles: BoardProfile[];
}

export interface RemoveProfileResponse {
  removed: true;
  name: string;
}

function deleteHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const name = req.params.name;
    if (!name) throw new HttpError(400, 'bad_request', 'missing profile name');

    const result = await source.removeProfile(name);
    switch (result.outcome) {
      case 'removed': {
        const body: RemoveProfileResponse = { removed: true, name };
        return { status: 200, body };
      }
      case 'not_found':
        throw new HttpError(404, 'no_such_profile', 'no such profile');
      case 'protected':
        throw new HttpError(
          409,
          'protected_profile',
          `"${name}" is a protected fixture profile`,
        );
      case 'run_in_progress':
        return {
          status: 409,
          body: {
            error: {
              code: 'run_in_progress',
              message: 'a run is in progress for this profile',
              runId: result.runId,
            },
          },
        };
      case 'intent_pending':
        return {
          status: 409,
          body: {
            error: {
              code: 'intent_pending',
              message: 'a queued run intent is still pending for this profile',
              intentId: result.intentId,
            },
          },
        };
    }
  };
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
    {
      method: 'DELETE',
      path: '/api/profiles/:name',
      handler: deleteHandler(source),
    },
  ];
}
