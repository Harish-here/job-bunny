/**
 * Runs routes — read-only observability over one profile's `runs`/
 * `run_events` tables (persist-to-db Phase 1). Mirrors
 * `features/board/routes.ts`'s RouteDef/handler/validation pattern
 * exactly, including `:name` path params and the fixed `no_local_db` 404
 * for a profile without a local database. No `service.ts`: unlike the
 * board feature, there is no not-found/404 translation to isolate from
 * request validation — each handler talks to the `BoardStore` directly
 * (two-pair rule keeps this slice at exactly one impl file plus `index.ts`).
 */
import { z } from 'zod';
import type { BoardSource } from '../../../ports/board.ts';
import type { RunDetail, RunEventRow, RunSummary } from '../../../ports/run_store.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError, param } from '../../shared/index.ts';

const ListRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ListRunEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const RunIdSchema = z.coerce.number().int().positive();

export interface ListRunsResponse {
  rows: RunSummary[];
  total: number;
  limit: number;
  offset: number;
}
export type GetRunResponse = RunDetail;
export interface ListRunEventsResponse {
  rows: RunEventRow[];
  total: number;
  limit: number;
  offset: number;
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(400, 'validation', first ? first.message : 'invalid request');
  }
  return parsed.data;
}

/** Same fixed 404 as `features/board/routes.ts`'s `openStoreOrThrow` —
 * pure-Notion profiles have no local `runs`/`run_events` tables either. */
function openStoreOrThrow(source: BoardSource, req: BoardRequest) {
  const store = source.openStore(param(req, 'name'));
  if (!store) {
    throw new HttpError(
      404,
      'no_local_db',
      'profile has no local database (pure-Notion profiles are read via Notion)',
    );
  }
  return store;
}

function parseRunId(req: BoardRequest): number {
  return parseOrThrow(RunIdSchema, param(req, 'id'));
}

function listHandler(source: BoardSource) {
  return (req: BoardRequest): BoardResponse => {
    const store = openStoreOrThrow(source, req);
    const q = parseOrThrow(ListRunsQuerySchema, Object.fromEntries(req.query));
    const { rows, total } = store.listRuns({ limit: q.limit, offset: q.offset });
    const body: ListRunsResponse = {
      rows,
      total,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    };
    return { status: 200, body };
  };
}

function getHandler(source: BoardSource) {
  return (req: BoardRequest): BoardResponse => {
    const store = openStoreOrThrow(source, req);
    const id = parseRunId(req);
    const run = store.getRun(id);
    if (!run) throw new HttpError(404, 'not_found', `no such run: ${id}`);
    const body: GetRunResponse = run;
    return { status: 200, body };
  };
}

function listEventsHandler(source: BoardSource) {
  return (req: BoardRequest): BoardResponse => {
    const store = openStoreOrThrow(source, req);
    const id = parseRunId(req);
    // `getRun` is the existence check — `listRunEvents` alone can't tell
    // "run has no events yet" apart from "no such run".
    if (!store.getRun(id)) throw new HttpError(404, 'not_found', `no such run: ${id}`);
    const q = parseOrThrow(ListRunEventsQuerySchema, Object.fromEntries(req.query));
    const { rows, total } = store.listRunEvents(id, { limit: q.limit, offset: q.offset });
    const body: ListRunEventsResponse = {
      rows,
      total,
      limit: q.limit ?? 500,
      offset: q.offset ?? 0,
    };
    return { status: 200, body };
  };
}

export function makeRunsRoutes(source: BoardSource): RouteDef[] {
  return [
    { method: 'GET', path: '/api/profiles/:name/runs', handler: listHandler(source) },
    { method: 'GET', path: '/api/profiles/:name/runs/:id', handler: getHandler(source) },
    {
      method: 'GET',
      path: '/api/profiles/:name/runs/:id/events',
      handler: listEventsHandler(source),
    },
  ];
}
