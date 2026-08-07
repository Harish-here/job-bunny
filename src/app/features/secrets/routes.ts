/**
 * Secrets routes (UI phase 1, Task 4) — write-only, allowlisted access to
 * the data home's `.env`. This is the only route in the board server that
 * accepts a credential; every step below is ordered specifically to keep
 * a submitted value out of every code path that could leak it (see the
 * task brief's numbered rationale). `SECRET_KEYS` (`ports/board.ts`) is
 * the sole allowlist — a route that took an arbitrary key string would
 * let any caller write any line into the user's `.env`.
 */
import { z } from 'zod';
import { type BoardSource, SECRET_KEYS, type SecretKey } from '../../../ports/board.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';

const PutBodySchema = z.object({ value: z.string().min(1) });

function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

/** Fixed message, never zod's own — zod's issue text can echo the
 * received value. */
function parseValueOrThrow(body: unknown): string {
  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, 'validation', 'value must be a non-empty string');
  }
  return parsed.data.value;
}

function getHandler(source: BoardSource) {
  return async (): Promise<BoardResponse> => {
    return { status: 200, body: await source.listSecrets() };
  };
}

function putHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    // Step 1: allowlist check FIRST — before the body is even parsed, so
    // an unknown key never reaches a code path that has the submitted
    // value in scope.
    const key = req.params.key;
    if (!key || !isSecretKey(key)) {
      throw new HttpError(404, 'unknown_secret', 'unknown secret key');
    }

    const value = parseValueOrThrow(req.body);

    // Step 3: newlines are rejected, not escaped — see rationale point 5.
    if (value.includes('\n') || value.includes('\r')) {
      throw new HttpError(400, 'validation', 'value must not contain a newline');
    }

    await source.writeSecret(key, value);
    return { status: 200, body: { key, status: 'present' } };
  };
}

export function makeSecretsRoutes(source: BoardSource): RouteDef[] {
  return [
    { method: 'GET', path: '/api/secrets', handler: getHandler(source) },
    { method: 'PUT', path: '/api/secrets/:key', handler: putHandler(source) },
  ];
}
