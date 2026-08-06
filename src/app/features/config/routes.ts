/**
 * Config routes (config→db Phase 4, Task 9) — GET/PUT one profile's raw
 * config-doc text, and POST a brand-new profile. Mirrors `features/board/
 * routes.ts`'s/`features/runs/routes.ts`'s `parseOrThrow`/`HttpError`
 * pattern exactly, including its own local `parseOrThrow` copy (two-pair
 * rule: internals aren't imported across module boundaries, and neither
 * sibling feature exports theirs either).
 *
 * Reaches the store ONLY through `BoardSource` (the port) — this file
 * never imports `wireConfigStore`/`SqliteConfigStore` directly
 * (`app-only-ports-core`).
 *
 * This is the code-level surface for the hard-rule amendment
 * (`ports/board.ts`'s own doc comment carries the pinned wording, ledger
 * L7): the board's write surface is `updateTracking` (tracking) +
 * `writeConfigDoc`/`createProfile` (config tables) — nothing else.
 */
import { z } from 'zod';
import type { BoardProfile, BoardSource } from '../../../ports/board.ts';
import type { ConfigDocKey } from '../../../ports/config_store.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError, param } from '../../shared/index.ts';

const VALID_DOCS: readonly ConfigDocKey[] = [
  'profile.json',
  'filter.json',
  'resume.json',
  'search_urls.md',
];

const PutConfigBodySchema = z.strictObject({ text: z.string() });

// The regex is NOT the port's only defense — `BoardSource.createProfile`
// re-checks it (defense-in-depth) — but enforcing it here too gives a
// nicer 400 message before ever calling the port.
const CreateProfileBodySchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
});

export interface ConfigGetResponse {
  text: string;
}
export interface CreateProfileResponse {
  profile: BoardProfile;
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(400, 'validation', first ? first.message : 'invalid request');
  }
  return parsed.data;
}

function isValidDoc(doc: string): doc is ConfigDocKey {
  return (VALID_DOCS as readonly string[]).includes(doc);
}

/** `:doc`-path-param gate — distinct from, and checked BEFORE, the
 * `:name` profile-membership gate below. Not one of `VALID_DOCS` → 404
 * `not_found`. */
function parseDoc(req: BoardRequest): ConfigDocKey {
  const doc = param(req, 'doc');
  if (!isValidDoc(doc)) {
    throw new HttpError(404, 'not_found', `no such config doc: ${doc}`);
  }
  return doc;
}

/** `:name`-profile-membership gate — re-derived via `source.listProfiles()`,
 * the same `openStoreOrThrow`-style pattern `board/routes.ts` already
 * uses. A distinct, but same-shaped, 404 from the doc-not-found case
 * above: this one means "no such profile at all", not "doc not present". */
async function assertProfileExists(source: BoardSource, name: string): Promise<void> {
  const profiles = await source.listProfiles();
  if (!profiles.some((p) => p.name === name)) {
    throw new HttpError(404, 'no_such_profile', `no such profile: ${name}`);
  }
}

function getHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const doc = parseDoc(req);
    const name = param(req, 'name');
    await assertProfileExists(source, name);
    const text = await source.readConfigDoc(name, doc);
    if (text === undefined) {
      throw new HttpError(404, 'not_found', `no config doc stored yet: ${doc}`);
    }
    const body: ConfigGetResponse = { text };
    return { status: 200, body };
  };
}

function putHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const doc = parseDoc(req);
    const name = param(req, 'name');
    await assertProfileExists(source, name);
    const parsedBody = parseOrThrow(PutConfigBodySchema, req.body);
    try {
      await source.writeConfigDoc(name, doc, parsedBody.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(422, 'validation', message);
    }
    // Echo back what was just stored — cheaper than a second read, and
    // guaranteed byte-identical since `writeText` never re-serializes.
    const body: ConfigGetResponse = { text: parsedBody.text };
    return { status: 200, body };
  };
}

function createProfileHandler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const { name } = parseOrThrow(CreateProfileBodySchema, req.body);
    try {
      await source.createProfile(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('profile already exists')) {
        throw new HttpError(409, 'profile_exists', message);
      }
      // Any other throw (the route's own regex pre-check should already
      // have caught a bad name) propagates to server.ts's generic 500 —
      // never swallowed into a misleading 409.
      throw err;
    }
    const profile: BoardProfile = { name, connector: 'sqlite', hasDb: true };
    const body: CreateProfileResponse = { profile };
    return { status: 201, body };
  };
}

export function makeConfigRoutes(source: BoardSource): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/profiles/:name/config/:doc',
      handler: getHandler(source),
    },
    {
      method: 'PUT',
      path: '/api/profiles/:name/config/:doc',
      handler: putHandler(source),
    },
    { method: 'POST', path: '/api/profiles', handler: createProfileHandler(source) },
  ];
}
