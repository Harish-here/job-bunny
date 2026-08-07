/**
 * personas routes — a single `GET /api/personas` endpoint serving the
 * static persona catalog (`core/personas`) verbatim. No `BoardSource`
 * argument: the catalog is static data imported straight from `core/`,
 * so this factory needs no per-profile state — keeping "routes are pure
 * functions of their inputs" visible in the zero-argument signature.
 */
import { PERSONA_CATALOG } from '../../../core/personas/index.ts';
import type { RouteDef } from '../../shared/index.ts';

export function makePersonasRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/personas',
      handler: () => ({ status: 200, body: PERSONA_CATALOG }),
    },
  ];
}
