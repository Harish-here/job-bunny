/**
 * Run-intent routes (UI phase 1, Task 2) — the board server's first WRITE
 * surface beyond `tracking`/config docs, and the first place a user can
 * trigger a pipeline run from. Mirrors `features/board/routes.ts`'s
 * RouteDef/handler pattern: no `service.ts`, each handler talks to
 * `BoardSource`/`RunIntentStore` directly (two-pair rule keeps this slice
 * at exactly one impl file plus `index.ts`).
 *
 * The POST running-run guard uses the EXISTING `BoardStore.listRuns` read
 * surface rather than a new port method (a stale-heartbeat run already
 * reads as `crashed`, so a wedged run never permanently blocks the
 * button), and it runs BEFORE `openIntents` on purpose: `openIntents`
 * creates the profile's db as a side effect, and "is something already
 * running" must never be the thing that brings a never-run profile's
 * database into existence.
 */
import type { BoardSource } from '../../../ports/board.ts';
import type { RunIntent } from '../../../ports/run_intents.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';

/** A fixed cap, not a `?limit=` query param — kept out of scope: phases
 * 3/4 poll for pending -> claimed/expired and 20 is far more than one
 * profile ever queues. */
export const DEFAULT_INTENT_LIST_LIMIT = 20;

export interface PostIntentResponse {
  intent: RunIntent;
  deduped: boolean;
}
export interface DeleteIntentResponse {
  intent: RunIntent;
}
export interface ListIntentsResponse {
  rows: RunIntent[];
}

function requireName(req: BoardRequest): string {
  const name = req.params.name;
  if (!name) throw new HttpError(400, 'bad_request', 'missing profile name');
  return name;
}

function postHandler(source: BoardSource, now: () => Date) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const name = requireName(req);

    // Running-run guard, BEFORE touching intents — see file header.
    const store = await source.openStore(name);
    if (store) {
      const { rows } = store.listRuns({ limit: 1, offset: 0 });
      const newest = rows[0];
      if (newest?.status === 'running') {
        return {
          status: 409,
          body: {
            error: {
              code: 'run_in_progress',
              message: 'a run is already in progress',
              runId: newest.id,
            },
          },
        };
      }
    }

    const intents = await source.openIntents(name);
    if (!intents) throw new HttpError(404, 'no_such_profile', 'no such profile');
    const { intent, deduped } = intents.request(now().toISOString());
    const body: PostIntentResponse = { intent, deduped };
    return { status: deduped ? 200 : 201, body };
  };
}

function deleteHandler(source: BoardSource, now: () => Date) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const name = requireName(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'bad_request', 'invalid intent id');
    }

    const intents = await source.openIntents(name);
    if (!intents) throw new HttpError(404, 'no_such_profile', 'no such profile');

    const result = intents.cancel(id, now().toISOString());
    if (result.outcome === 'not_found') {
      throw new HttpError(404, 'not_found', 'no such intent');
    }
    if (result.outcome === 'not_pending') {
      throw new HttpError(409, 'intent_not_pending', 'intent is no longer pending');
    }
    const body: DeleteIntentResponse = { intent: result.intent };
    return { status: 200, body };
  };
}

function getHandler(source: BoardSource, now: () => Date) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const name = requireName(req);
    const intents = await source.openIntents(name);
    if (!intents) throw new HttpError(404, 'no_such_profile', 'no such profile');

    const rows = intents.list(now().toISOString(), DEFAULT_INTENT_LIST_LIMIT);
    const body: ListIntentsResponse = { rows };
    return { status: 200, body };
  };
}

export function makeIntentRoutes(
  source: BoardSource,
  now: () => Date = () => new Date(),
): RouteDef[] {
  return [
    {
      method: 'POST',
      path: '/api/profiles/:name/run-intents',
      handler: postHandler(source, now),
    },
    {
      method: 'DELETE',
      path: '/api/profiles/:name/run-intents/:id',
      handler: deleteHandler(source, now),
    },
    {
      method: 'GET',
      path: '/api/profiles/:name/run-intents',
      handler: getHandler(source, now),
    },
  ];
}
