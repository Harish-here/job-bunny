/**
 * The board's local HTTP server — mounts the profiles + board feature
 * routes, converts thrown `HttpError`s (and anything else) into the JSON
 * error envelope, and falls back to `static.ts` for everything else.
 *
 * Two accepted realities, deliberate, do not "fix":
 *  (a) `BoardStore` is synchronous inside these async handlers (node:sqlite
 *      is sync by design — ports/board.ts). A slow query blocks the event
 *      loop, i.e. this is effectively a single-request-at-a-time server.
 *      That's fine for one local user on their own machine; do NOT reach
 *      for worker threads to "fix" it.
 *  (b) `server.test.ts` uses real `fetch` against `listen(0)`; if a
 *      sandbox ever blocks loopback `fetch`, the documented fallback is
 *      `node:http`'s `http.request` against the same address — never
 *      weaken the test to handler-only (no socket).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { BoardSource } from '../../ports/board.ts';
import type { Logger } from '../../ports/context.ts';
import { makeBoardRoutes } from '../features/board/index.ts';
import { makeProfilesRoutes } from '../features/profiles/index.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../shared/index.ts';
import { HttpError, jsonError, matchRoute, readJsonBody } from '../shared/index.ts';
import { serveStatic } from './static.ts';

export interface BoardServerOptions {
  source: BoardSource;
  logger: Logger;
  /** Absolute path to `ui/dist`. Undefined or a missing directory falls
   * back to the SPA/no-UI page (`static.ts`). */
  uiDir?: string;
  /** Never widened by config in v1 — this option exists for tests only. */
  host?: string;
}

export interface BoardServer {
  /** Resolves with the actual bound port (0 in ⇒ an ephemeral port out). */
  listen(port: number): Promise<{ port: number }>;
  /** Stops accepting connections, then calls `source.close()`. */
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';

export function createBoardServer(opts: BoardServerOptions): BoardServer {
  const { source, logger, uiDir, host = DEFAULT_HOST } = opts;
  const routes: RouteDef[] = [...makeProfilesRoutes(source), ...makeBoardRoutes(source)];

  const httpServer = createServer((req, res) => {
    // Last-resort net: `handleRequest` covers its own body in a
    // try/catch/finally, but nothing may ever crash the process from a
    // future edit inside it — a bare `void` here would turn any escaping
    // throw into an unhandled rejection (fatal on Node 24 by default).
    handleRequest(req, res, routes, uiDir, logger).catch((err) => {
      logger.error('board: handler crashed (last resort)', { error: String(err) });
      if (!res.headersSent) {
        writeJson(res, jsonError(500, 'internal', 'internal server error'));
      } else {
        res.end();
      }
    });
  });

  return {
    listen(port) {
      return new Promise((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', onError);
          const address = httpServer.address();
          const boundPort = typeof address === 'object' && address ? address.port : port;
          resolve({ port: boundPort });
        });
      });
    },
    async close() {
      try {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      } finally {
        source.close();
      }
    },
  };
}

/** Parses the request-target into a `URL`, converting a parse failure into
 * an `HttpError(400, 'bad_request', ...)` rather than letting a raw
 * `TypeError` (or anything else) escape — a malformed absolute-form
 * request-target (e.g. `GET http://[::bad HTTP/1.1`) reaches this code on
 * Node 24 without the HTTP parser rejecting it first. */
function safeParseUrl(rawTarget: string): URL {
  try {
    return new URL(rawTarget, 'http://x');
  } catch {
    throw new HttpError(400, 'bad_request', 'malformed request target');
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: RouteDef[],
  uiDir: string | undefined,
  logger: Logger,
): Promise<void> {
  const start = performance.now();
  const method = req.method ?? 'GET';
  const rawTarget = req.url ?? '/';
  // Safe fallback for logging/error-reporting: must never reference a
  // `url` that failed to parse — this string is always available even
  // when `safeParseUrl` throws below.
  let path = rawTarget;
  let status = 500;
  try {
    const url = safeParseUrl(rawTarget);
    path = url.pathname;
    if (url.pathname.startsWith('/api/')) {
      const response = await handleApi(req, url, method, routes);
      status = response.status;
      writeJson(res, response);
    } else if (method === 'GET') {
      const response = await serveStatic(uiDir, url.pathname);
      status = response.status;
      res.writeHead(response.status, { 'content-type': response.contentType });
      res.end(response.body as string | Buffer);
    } else {
      const response = jsonError(
        404,
        'not_found',
        `no such route: ${method} ${url.pathname}`,
      );
      status = response.status;
      writeJson(res, response);
    }
  } catch (err) {
    const response = toErrorResponse(err, path, logger);
    status = response.status;
    writeJson(res, response);
  } finally {
    logger.info('http', {
      method,
      path,
      status,
      ms: Math.round(performance.now() - start),
    });
  }
}

async function handleApi(
  req: IncomingMessage,
  url: URL,
  method: string,
  routes: RouteDef[],
): Promise<BoardResponse> {
  const matched = matchRoute(routes, method, url.pathname);
  if (!matched) {
    return jsonError(404, 'not_found', `no such route: ${method} ${url.pathname}`);
  }
  const body = matched.route.method === 'PATCH' ? await readJsonBody(req) : undefined;
  const request: BoardRequest = { params: matched.params, query: url.searchParams, body };
  return matched.route.handler(request);
}

/** Never leaks `err.message` on the 500 path — that could surface
 * internals (e.g. a filesystem path from a corrupt-db throw). The real
 * cause goes to `logger.error` only. */
function toErrorResponse(err: unknown, path: string, logger: Logger): BoardResponse {
  if (err instanceof HttpError) {
    return jsonError(err.status, err.code, err.message);
  }
  if (err instanceof z.ZodError) {
    return jsonError(400, 'validation', 'invalid request');
  }
  logger.error('board: handler failed', { path, error: String(err) });
  return jsonError(500, 'internal', 'internal server error');
}

function writeJson(res: ServerResponse, response: BoardResponse): void {
  res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(response.body));
}
