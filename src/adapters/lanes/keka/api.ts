import { z } from 'zod';
import type { RunContext } from '../../../ports/context.ts';

/**
 * Keka careers API wire shapes + raw HTTP (P5 Task 4). Ported from v0
 * (scripts/pipeline/keka.js, scripts/pipeline/ats_common.js) — same three
 * endpoints (portal-info, /careers/ HTML fallback, embedjobs), same
 * guid-extraction regex, same HTML-entity-then-tag-strip JD text cleanup.
 * zod validates at ingress only; a malformed individual job is the
 * caller's (lane.ts) problem to skip, not this module's.
 */

const FETCH_TIMEOUT_MS = 10_000;

export function kekaBase(tenant: string): string {
  return `https://${tenant}.keka.com`;
}

function fetchSignal(ctx: RunContext): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}

/** Pull the first Keka portal guid out of a blob of text — ported
 * verbatim from v0's extractPortalGuid: the portal-info JSON
 * (stringified) and the /careers/ HTML both embed it in an
 * /ats/documents/<guid>/ asset path. */
export function extractPortalGuid(str: string | null | undefined): string | null {
  const m = String(str ?? '').match(
    /\/ats\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i,
  );
  return m?.[1] ?? null;
}

export const KekaPortalInfoSchema = z.object({
  name: z.string().optional(),
});

export interface PortalInfo {
  /** true only on HTTP 200 + a body that parses as JSON. */
  ok: boolean;
  status: number;
  name?: string;
  /** Extracted from the raw (pre-zod) JSON text — present whenever the
   * body embeds an /ats/documents/<guid>/ path anywhere in it. */
  guid?: string;
}

/** GET /careers/api/organization/default/careerportalinfo — the single
 * keyless endpoint v0 uses both to confirm a tenant guess (probe, by name
 * match) and to source the portal guid (fetch phase). A non-2xx or a body
 * that doesn't parse as JSON both mean "not a Keka tenant" here, same as
 * v0's probeCandidate/discoverGuid treatment. */
export async function getPortalInfo(
  tenant: string,
  ctx: RunContext,
): Promise<PortalInfo> {
  const res = await fetch(
    `${kekaBase(tenant)}/careers/api/organization/default/careerportalinfo`,
    {
      signal: fetchSignal(ctx),
    },
  );
  if (!res.ok) return { ok: false, status: res.status };

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status };
  }

  const parsed = KekaPortalInfoSchema.safeParse(body);
  return {
    ok: true,
    status: res.status,
    name: parsed.success ? parsed.data.name : undefined,
    guid: extractPortalGuid(text) ?? undefined,
  };
}

/** GET /careers/ (HTML) — the guid-discovery fallback v0 falls back to
 * when portal-info doesn't yield a guid. Returns null on any non-2xx;
 * network-level failures still reject. */
export async function getCareersHtml(
  tenant: string,
  ctx: RunContext,
): Promise<string | null> {
  const res = await fetch(`${kekaBase(tenant)}/careers/`, { signal: fetchSignal(ctx) });
  return res.ok ? await res.text() : null;
}

/** One embedjobs entry. Fields are exactly what v0's mapKekaJob reads
 * (job.id, .title, .description, .experience); jobLocations is Keka-only
 * card metadata v0 uses for card_location, which has no home in v2's JD
 * (structured.locations is filled later by the LLM structuring stage, not
 * by a lane) — so it is not part of this schema. */
export const KekaJobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  experience: z.string().optional().nullable(),
});
export type KekaJob = z.infer<typeof KekaJobSchema>;

/** Top-level embedjobs response envelope: a bare JSON array (no wrapper
 * object), per v0's `Array.isArray(data) ? data : []`. Individual entries
 * are validated by the caller so one malformed job doesn't sink the whole
 * board. */
export const KekaJobsResponseSchema = z.array(z.unknown());

/** GET /careers/api/embedjobs/default/active/{guid} — active jobs for a
 * resolved portal guid. Throws on HTTP failure, network failure, or a
 * malformed (non-array) envelope — the whole-board failure the caller
 * turns into a SoftError. */
export async function getEmbedJobs(
  tenant: string,
  guid: string,
  ctx: RunContext,
): Promise<unknown[]> {
  const res = await fetch(
    `${kekaBase(tenant)}/careers/api/embedjobs/default/active/${guid}`,
    {
      signal: fetchSignal(ctx),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.json();
  const parsed = KekaJobsResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new Error(`invalid embedjobs response: ${parsed.error.message}`);
  return parsed.data;
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
 * decode-again → collapse-whitespace order as v0's htmlToText. Duplicated
 * from the Greenhouse lane rather than shared — cross-lane imports are a
 * boundaries error, and this is a handful of lines. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let s = decodeEntities(String(html));
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}
