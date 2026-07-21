import { z } from 'zod';
import type { RunContext } from '../../../ports/context.ts';

/**
 * Greenhouse boards API wire shapes + raw HTTP (P5 Task 3). Ported from v0
 * (scripts/pipeline/greenhouse.js, scripts/pipeline/ats_common.js) — same
 * two endpoints, same board-info/name-match probe heuristic, same
 * HTML-entity-then-tag-strip JD text cleanup. zod validates at ingress
 * only; a malformed individual job is the caller's (lane.ts) problem to
 * skip, not this module's — getBoardJobs only fails the whole board on a
 * malformed top-level response shape (`jobs` not present/an array).
 */

export const BOARDS_API = 'https://boards-api.greenhouse.io/v1/boards';

/** 10s HTTP deadline (v0's FETCH_TIMEOUT_MS), composed with the run's own
 * cancellation signal via AbortSignal.any. */
const FETCH_TIMEOUT_MS = 10_000;

function fetchSignal(ctx: RunContext): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}

/** GET /v1/boards/{token} — board metadata only (no jobs). v0's probe
 * endpoint: it exists solely to confirm a guessed token resolves to a real
 * board and to read back the board's display `name` for verifyBoardName. */
export const GreenhouseBoardInfoSchema = z.object({
  name: z.string().optional(),
  id: z.number().optional(),
});
export type GreenhouseBoardInfo = z.infer<typeof GreenhouseBoardInfoSchema>;

/** GET /v1/boards/{token}/jobs?content=true — one job entry. Fields are
 * exactly what v0's mapGhJob reads (job.id, .title, .absolute_url,
 * .updated_at, .location.name, .content); everything else on the wire is
 * ignored. */
export const GreenhouseJobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string().min(1),
  absolute_url: z.url(),
  updated_at: z.string().optional(),
  location: z.object({ name: z.string().optional().nullable() }).optional().nullable(),
  content: z.string().optional().nullable(),
});
export type GreenhouseJob = z.infer<typeof GreenhouseJobSchema>;

/** Top-level jobs-list envelope. `jobs` entries are validated individually
 * by the caller (one bad job must not sink the whole board), so this
 * schema only asserts the envelope shape — it is intentionally NOT
 * `z.array(GreenhouseJobSchema)`. */
export const GreenhouseJobsResponseSchema = z.object({
  jobs: z.array(z.unknown()),
  meta: z.object({ total: z.number() }).optional(),
});

export interface BoardInfoResult {
  /** true only on HTTP 200 + a body that parses against
   * GreenhouseBoardInfoSchema; false for any 4xx/5xx or malformed body. */
  ok: boolean;
  status: number;
  name?: string;
}

/** Raw fetch of a board's metadata. Network-level failures (DNS, abort,
 * connection reset) reject. `ok:false` alone is NOT "definitely not this
 * board" — a 429/5xx `status` means the server didn't give a conclusive
 * answer, same as a thrown error; only a 404/410 `status`, or a 200 body
 * that fails name verification, is real evidence of absence. Callers
 * (lane.ts) own that classification via the returned `status`. */
export async function getBoardInfo(
  boardToken: string,
  ctx: RunContext,
): Promise<BoardInfoResult> {
  const res = await fetch(`${BOARDS_API}/${boardToken}`, { signal: fetchSignal(ctx) });
  if (!res.ok) return { ok: false, status: res.status };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, status: res.status };
  }

  const parsed = GreenhouseBoardInfoSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: res.status };
  return { ok: true, status: res.status, name: parsed.data.name };
}

/** Raw jobs fetch for a confirmed board. Throws on HTTP failure, network
 * failure, or a malformed envelope — the whole-board failure the caller
 * (lane.ts fetchBoard / the source stage above it) turns into a
 * SoftError. Individual malformed job entries are NOT validated here;
 * `jobs` is returned as raw unknown[] for the caller to validate one at a
 * time and skip. */
export async function getBoardJobs(
  boardToken: string,
  ctx: RunContext,
): Promise<unknown[]> {
  const res = await fetch(`${BOARDS_API}/${boardToken}/jobs?content=true`, {
    signal: fetchSignal(ctx),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.json();
  const parsed = GreenhouseJobsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error(`invalid jobs response: ${parsed.error.message}`);
  return parsed.data.jobs;
}

// ---------- pure helpers (ported from ats_common.js) ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** HTML(-entity-escaped) JD body → plain text. Same decode → strip-tags →
 * decode-again → collapse-whitespace order as v0's htmlToText (Greenhouse
 * `content` arrives entity-escaped, e.g. "&lt;p&gt;…"). Duplicated in the
 * Keka lane rather than shared — cross-lane imports are a boundaries
 * error, and this is a handful of lines. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let s = decodeEntities(String(html));
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}
