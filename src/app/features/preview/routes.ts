/**
 * Filter-rule drop preview route (R15) — `POST
 * /api/profiles/:name/preview/filter`. Body is the DRAFT filter config JSON
 * (the same shape `filter.json` itself holds); the handler asks
 * `BoardSource.previewFilterRule` how many more jobs that draft would drop
 * against the most recent run's pre-filter candidate pool, versus the
 * profile's current `filter.json`. It never reruns the pipeline and never
 * writes anything — the response body IS `FilterPreviewResult` directly, no
 * wrapping envelope.
 *
 * Reaches the store ONLY through `BoardSource` (the port) — `app-only-
 * ports-core` — same discipline as every sibling feature.
 *
 * Fix round (adversarial review, two findings):
 *  1. `previewFilterRule` throws `InvalidDraftFilterConfigError`
 *     (`ports/board_preview.ts`) for exactly one case — the caller's DRAFT
 *     filter rule failing schema validation — and only THAT is a 422. Any
 *     other throw (the profile's own stored `filter.json` corrupted, or its
 *     store broken) is a server-side data problem, not the caller's input;
 *     it is deliberately rethrown unwrapped so `server.ts`'s generic
 *     catch-all turns it into a 500 `internal`, the same convention every
 *     other route here relies on for an unclassified failure (e.g.
 *     `config/routes.ts`'s `createProfileHandler`).
 *  2. An unknown `:name` now 404s `no_such_profile`, mirroring
 *     `config/routes.ts`'s own `assertProfileExists` gate exactly, instead
 *     of silently degrading into `available:false/no_recent_run`.
 */
import type { BoardSource } from '../../../ports/board.ts';
import { isInvalidDraftFilterConfigError } from '../../../ports/board_preview.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError, param } from '../../shared/index.ts';

/** Same shape as `config/routes.ts`'s own `assertProfileExists` — re-derived
 * per file (two-pair rule: internals aren't shared across module
 * boundaries) rather than imported. */
async function assertProfileExists(source: BoardSource, name: string): Promise<void> {
  const profiles = await source.listProfiles();
  if (!profiles.some((p) => p.name === name)) {
    throw new HttpError(404, 'no_such_profile', `no such profile: ${name}`);
  }
}

function previewHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const name = param(req, 'name');
    await assertProfileExists(source, name);
    try {
      const result = await source.previewFilterRule(name, req.body);
      return { status: 200, body: result };
    } catch (err) {
      if (isInvalidDraftFilterConfigError(err)) {
        throw new HttpError(422, 'validation', err.message);
      }
      // Anything else means the profile's own stored config or store is
      // broken, not that the caller's draft is invalid — rethrow as-is so
      // it is never misattributed as a 422. `server.ts`'s generic
      // catch-all turns an unclassified throw into a 500 `internal`.
      throw err;
    }
  };
}

export function makePreviewRoutes(source: BoardSource): RouteDef[] {
  return [
    {
      method: 'POST',
      path: '/api/profiles/:name/preview/filter',
      handler: previewHandler(source),
    },
  ];
}
