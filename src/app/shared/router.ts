import type { BoardResponse } from './http.ts';
import { HttpError } from './http.ts';

export interface BoardRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown; // undefined for GET
}

/** Required accessor — tsconfig noUncheckedIndexedAccess makes
 * req.params.name type 'string | undefined'; routes MUST use this. */
export function param(req: BoardRequest, key: string): string {
  const value = req.params[key];
  if (value === undefined) {
    throw new HttpError(400, 'bad_request', `missing path param: ${key}`);
  }
  return value;
}

export type RouteHandler = (req: BoardRequest) => BoardResponse | Promise<BoardResponse>;

export interface RouteDef {
  method: 'GET' | 'PATCH' | 'PUT' | 'POST' | 'DELETE';
  path: string;
  handler: RouteHandler;
}

/** Splits `route.path` and `pathname` into '/'-delimited segments and
 * compares them segment-wise: a literal segment must match exactly, a
 * ':param' segment binds. Returns null on method mismatch, a differing
 * segment count (covers trailing slash and extra segments), or a literal
 * mismatch. Param values are decodeURIComponent'd; an invalid escape
 * sequence keeps the raw segment rather than throwing. */
export function matchRoute(
  routes: RouteDef[],
  method: string,
  pathname: string,
): { route: RouteDef; params: Record<string, string> } | null {
  const requestSegments = pathname.split('/');
  for (const route of routes) {
    if (route.method !== method) continue;
    const routeSegments = route.path.split('/');
    if (routeSegments.length !== requestSegments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < routeSegments.length; i++) {
      const routeSegment = routeSegments[i] ?? '';
      const requestSegment = requestSegments[i] ?? '';
      if (routeSegment.startsWith(':')) {
        params[routeSegment.slice(1)] = decodeSegment(requestSegment);
      } else if (routeSegment !== requestSegment) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
