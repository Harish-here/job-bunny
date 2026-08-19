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
 */
import type { BoardSource } from '../../../ports/board.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError, param } from '../../shared/index.ts';

function previewHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const name = param(req, 'name');
    try {
      const result = await source.previewFilterRule(name, req.body);
      return { status: 200, body: result };
    } catch (err) {
      // The only throw `previewFilterRule` makes is the draft-validation
      // failure (its own doc comment) — same posture as `writeConfigDoc`'s
      // validator-throw contract, converted to a 422 here.
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(422, 'validation', message);
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
