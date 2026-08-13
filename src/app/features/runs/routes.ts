/**
 * Runs routes — read-only observability over one profile's `runs`/
 * `run_events` tables (persist-to-db Phase 1). Mirrors
 * `features/board/routes.ts`'s RouteDef/handler/validation pattern
 * exactly, including `:name` path params and the fixed `no_local_db` 404
 * for a profile without a local database. No `service.ts`: unlike the
 * board feature, there is no not-found/404 translation to isolate from
 * request validation — each handler talks to the `BoardStore` directly
 * (two-pair rule: this slice is at its cap of two impl files —
 * `routes.ts` + `soft_errors.ts` — plus `index.ts`).
 */
import { z } from 'zod';
import { formatLocalDate } from '../../../core/schedule/index.ts';
import type { BoardSource } from '../../../ports/board.ts';
import type { DeferredSlotRow } from '../../../ports/deferred_slots.ts';
import type { RunDetail, RunEventRow, RunSummary } from '../../../ports/run_store.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError, param } from '../../shared/index.ts';
import { groupSoftErrors, type SoftErrorSummary } from './soft_errors.ts';

const ListRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ListRunEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const RunIdSchema = z.coerce.number().int().positive();

/** `z.iso.date()` is the codebase's established convention for a bare
 * YYYY-MM-DD query param (`app/features/board/routes.ts`'s
 * `dateFrom`/`dateTo`), reused here rather than a hand-rolled regex. */
const ListDeferredSlotsQuerySchema = z.object({
  date: z.iso.date().optional(),
});

/** Well above any realistic personal-scale run's warn+error volume — the
 * same "hundreds not millions" scale reasoning `reconcile.ts`'s own doc
 * comment uses for its DB-wide timeout. This is the "bounded query" R9's
 * backend-dependency table asks for. */
export const SOFT_ERROR_SCAN_LIMIT = 2000;

/** One `GET /runs` list row: a `RunSummary` plus the health-gate inputs
 * `classifyOutcome` (`ui/runOutcome.ts`) needs — `total`/`breakerOpen`,
 * batched via ONE `BoardStore.listRunHealth` query per list call, never a
 * per-row soft-errors fetch (fix-round finding #4's N+1 constraint).
 * `groups` is always `[]` here: the list never needs the full grouped
 * breakdown, only the detail pane's dedicated `/soft-errors` endpoint
 * computes that. */
export interface RunListRow extends RunSummary {
  softErrors: SoftErrorSummary;
}

export interface ListRunsResponse {
  rows: RunListRow[];
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
export type GetSoftErrorsResponse = SoftErrorSummary;

/** D3b (blueprint step 1.17) — `date` is the RESOLVED date (today, local,
 * when the request omitted `?date=`), never the raw query value, so the
 * UI never has to re-derive "what date did this page actually show". */
export interface ListDeferredSlotsResponse {
  rows: DeferredSlotRow[];
  total: number;
  date: string;
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
 * pure-Notion profiles have no local `runs`/`run_events` tables either.
 * `async` (config→db Phase 4, Task 5) — `BoardSource.openStore` now reads
 * `profile.json` through the `ConfigStore` port. */
async function openStoreOrThrow(source: BoardSource, req: BoardRequest) {
  const store = await source.openStore(param(req, 'name'));
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
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const store = await openStoreOrThrow(source, req);
    const q = parseOrThrow(ListRunsQuerySchema, Object.fromEntries(req.query));
    const { rows, total } = store.listRuns({ limit: q.limit, offset: q.offset });
    // ONE batched query for every row's health, not a per-row fetch — see
    // `RunListRow`'s own doc comment and `ports/board.ts`'s
    // `listRunHealth`.
    const health = store.listRunHealth(rows.map((r) => r.id));
    const body: ListRunsResponse = {
      rows: rows.map((r) => {
        const h = health.get(r.id);
        return {
          ...r,
          softErrors: {
            total: h?.total ?? 0,
            groups: [],
            breakerOpen: h?.breakerOpen ?? false,
          },
        };
      }),
      total,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    };
    return { status: 200, body };
  };
}

function getHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const store = await openStoreOrThrow(source, req);
    const id = parseRunId(req);
    const run = store.getRun(id);
    if (!run) throw new HttpError(404, 'not_found', `no such run: ${id}`);
    const body: GetRunResponse = run;
    return { status: 200, body };
  };
}

function listEventsHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const store = await openStoreOrThrow(source, req);
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

/** R9 read-side soft-error aggregation (blueprint §5) — bounded scan over
 * `SOFT_ERROR_SCAN_LIMIT` most-recent events, filtered to warn/error, then
 * grouped by `groupSoftErrors`. Read-only: no write to `jobs` or any `runs`
 * table, same as every other handler in this file. */
function softErrorsHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const store = await openStoreOrThrow(source, req);
    const id = parseRunId(req);
    // `getRun` is the existence check — `listRunEvents` alone can't tell
    // "run has no events yet" apart from "no such run".
    if (!store.getRun(id)) throw new HttpError(404, 'not_found', `no such run: ${id}`);
    const { rows } = store.listRunEvents(id, { limit: SOFT_ERROR_SCAN_LIMIT });
    const softErrors = rows.filter(
      (row) => row.level === 'warn' || row.level === 'error',
    );
    const body: GetSoftErrorsResponse = groupSoftErrors(softErrors);
    return { status: 200, body };
  };
}

/** D3b (blueprint step 1.17) — the board's read surface for deferred
 * slots. `date` defaults to today (local) when the query param is absent;
 * mirrors `listHandler`'s own limit/offset-default-in-the-envelope
 * pattern, computed independently of `SqliteBoardStore.listDeferredSlots`'s
 * own identical default (that store method must still default correctly
 * when called directly, e.g. from a future non-HTTP caller). */
function listDeferredSlotsHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const store = await openStoreOrThrow(source, req);
    const q = parseOrThrow(ListDeferredSlotsQuerySchema, Object.fromEntries(req.query));
    const date = q.date ?? formatLocalDate(new Date());
    const { rows, total } = store.listDeferredSlots({ date });
    const body: ListDeferredSlotsResponse = { rows, total, date };
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
    {
      method: 'GET',
      path: '/api/profiles/:name/runs/:id/soft-errors',
      handler: softErrorsHandler(source),
    },
    {
      method: 'GET',
      path: '/api/profiles/:name/deferred-slots',
      handler: listDeferredSlotsHandler(source),
    },
  ];
}
