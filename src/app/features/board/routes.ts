/**
 * Board routes — list/get/patch-tracking/meta over one profile's local
 * database. Transport owns validation: the two request zod schemas live
 * here (not in a separate `schemas.ts` — two-pair rule keeps this slice
 * at exactly two impl files, this one and `service.ts`).
 */
import { z } from 'zod';
import { EXCITEMENT_OPTIONS, STATUS_OPTIONS } from '../../../core/tracking/index.ts';
import type {
  BoardJobDetail,
  BoardJobRow,
  BoardSource,
  TrackingRow,
} from '../../../ports/board.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError, param } from '../../shared/index.ts';
import { boardService } from './service.ts';

const ListQuerySchema = z.object({
  status: z.enum(STATUS_OPTIONS).optional(),
  excitement: z.enum(EXCITEMENT_OPTIONS).optional(),
  company: z.string().min(1).max(200).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  archived: z.enum(['true', 'false']).optional(),
  sort: z.enum(['date_found', 'score']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type ListQuery = z.infer<typeof ListQuerySchema>;

const TrackingPatchSchema = z
  .strictObject({
    status: z.enum(STATUS_OPTIONS).nullable().optional(),
    compRange: z.string().min(1).max(500).nullable().optional(),
    notes: z.string().min(1).max(5000).nullable().optional(),
    contact: z.string().min(1).max(500).nullable().optional(),
    dateApplied: z.iso.date().nullable().optional(),
    nextAction: z.string().min(1).max(500).nullable().optional(),
    nextActionDate: z.iso.date().nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'empty patch' });

export type TrackingPatchBody = z.infer<typeof TrackingPatchSchema>;

export interface BoardListResponse {
  rows: BoardJobRow[];
  total: number;
  limit: number;
  offset: number;
}
export type BoardDetailResponse = BoardJobDetail;
export interface TrackingPatchResponse {
  tracking: TrackingRow;
}
export interface BoardMetaResponse {
  statusOptions: string[];
  excitementOptions: string[];
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(400, 'validation', first ? first.message : 'invalid request');
  }
  return parsed.data;
}

function noLocalDb(): never {
  throw new HttpError(
    404,
    'no_local_db',
    'profile has no local database (pure-Notion profiles are read via Notion)',
  );
}

/** Shared by the three store-backed routes (list/get/patch): resolves
 * `:name` to a store or throws the fixed no_local_db 404.
 *
 * Gated on `connector === 'sqlite'` FIRST, before ever calling
 * `openStore` — `hasDb` (a `jobbunny.db` file exists) is now unconditional
 * for every profile once it has run once (local-DB spec D5's run-history
 * tracking), so a non-sqlite profile can have a real, openable store whose
 * `jobs` table is simply always empty (only a `sqlite` connector's sync
 * stage ever writes it). Without this gate a pure-Notion profile that has
 * run would silently show an empty job list instead of the explanatory
 * "read via Notion" state (`ports/board.ts`'s `BoardProfile` doc). Runs
 * routes (`features/runs/routes.ts`) have no such gate — deliberately —
 * since runs/`run_events` ARE unconditional. */
function openStoreOrThrow(source: BoardSource, req: BoardRequest) {
  const name = param(req, 'name');
  const profile = source.listProfiles().find((p) => p.name === name);
  if (profile?.connector !== 'sqlite') noLocalDb();
  const store = source.openStore(name);
  if (!store) noLocalDb();
  return store;
}

function listHandler(source: BoardSource) {
  return (req: BoardRequest): BoardResponse => {
    const store = openStoreOrThrow(source, req);
    const q = parseOrThrow(ListQuerySchema, Object.fromEntries(req.query));
    const { rows, total } = boardService(store).list({
      status: q.status,
      excitement: q.excitement,
      company: q.company,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      archived: q.archived === 'true',
      sort: q.sort,
      order: q.order,
      limit: q.limit,
      offset: q.offset,
    });
    const body: BoardListResponse = {
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
    const body: BoardDetailResponse = boardService(store).get(param(req, 'id'));
    return { status: 200, body };
  };
}

function patchHandler(source: BoardSource) {
  return (req: BoardRequest): BoardResponse => {
    const store = openStoreOrThrow(source, req);
    const patch = parseOrThrow(TrackingPatchSchema, req.body);
    const now = new Date().toISOString();
    const tracking = boardService(store).patchTracking(param(req, 'id'), patch, now);
    const body: TrackingPatchResponse = { tracking };
    return { status: 200, body };
  };
}

/** Deliberately does NOT call `source.openStore` and returns 200 even for
 * an unknown/nonexistent `:name` — the tracking vocabulary (statuses,
 * excitement levels) is profile-independent, sourced from `core/tracking`
 * alone. Do not "fix" this into a 404 lookup: a UI profile-switcher bug
 * that requests a bogus name should never be mistaken for this endpoint,
 * or the profile it names, being broken. */
function metaHandler(): (req: BoardRequest) => BoardResponse {
  return (): BoardResponse => {
    const body: BoardMetaResponse = {
      statusOptions: [...STATUS_OPTIONS],
      excitementOptions: [...EXCITEMENT_OPTIONS],
    };
    return { status: 200, body };
  };
}

export function makeBoardRoutes(source: BoardSource): RouteDef[] {
  return [
    { method: 'GET', path: '/api/profiles/:name/jobs', handler: listHandler(source) },
    { method: 'GET', path: '/api/profiles/:name/jobs/:id', handler: getHandler(source) },
    {
      method: 'PATCH',
      path: '/api/profiles/:name/jobs/:id/tracking',
      handler: patchHandler(source),
    },
    { method: 'GET', path: '/api/profiles/:name/meta', handler: metaHandler() },
  ];
}
