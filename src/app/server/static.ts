/**
 * Static file serving for the board UI (`ui/dist`, built via `npm run
 * ui:build`). Confined strictly to `uiDir`: every resolved path is checked with
 * `startsWith(uiDir + path.sep)` before the file is read, so a `..`
 * segment (or an absolute path smuggled into the URL) can never escape the
 * directory — traversal attempts fall through to the SPA-fallback/no-UI
 * response (HTTP 200), never surfaced as a 403 or 404 (no information about
 * what does/doesn't exist outside `uiDir`).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BoardResponse } from '../shared/index.ts';

const NO_UI_MESSAGE =
  'Job Bunny board API is running. UI not built yet — ' +
  'run: npm run ui:build. API: GET /api/profiles';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Resolves `filePath` within `uiDir`; returns null when it escapes
 * (traversal) or does not exist/isn't a readable file. */
async function readWithinUiDir(uiDir: string, filePath: string): Promise<Buffer | null> {
  const resolved = path.resolve(uiDir, `.${path.sep}${filePath}`);
  if (resolved !== uiDir && !resolved.startsWith(uiDir + path.sep)) {
    return null;
  }
  try {
    return await readFile(resolved);
  } catch {
    return null;
  }
}

function rawBody(body: Buffer): BoardResponse['body'] {
  // BoardResponse.body is `unknown`; the server writes it back as-is for
  // non-JSON responses (see server.ts's request handler, which writes
  // static responses inline via res.writeHead/res.end).
  return body;
}

/** Serves a file from `uiDir` for `pathname`, or falls back: SPA fallback
 * to `index.html` (when it exists) for any other missing path, else the
 * no-UI plaintext page. `uiDir` undefined is equivalent to "always
 * missing" — the no-UI page. */
export async function serveStatic(
  uiDir: string | undefined,
  pathname: string,
): Promise<BoardResponse & { contentType: string }> {
  if (uiDir === undefined) {
    return { status: 200, contentType: 'text/plain; charset=utf-8', body: NO_UI_MESSAGE };
  }

  const requested = pathname === '/' ? 'index.html' : pathname;
  const file = await readWithinUiDir(uiDir, requested);
  if (file !== null) {
    return { status: 200, contentType: contentTypeFor(requested), body: rawBody(file) };
  }

  const fallback = await readWithinUiDir(uiDir, 'index.html');
  if (fallback !== null) {
    return {
      status: 200,
      contentType: contentTypeFor('index.html'),
      body: rawBody(fallback),
    };
  }

  return { status: 200, contentType: 'text/plain; charset=utf-8', body: NO_UI_MESSAGE };
}
