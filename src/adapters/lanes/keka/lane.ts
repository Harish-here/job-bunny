import { companyKey, type JD, JDSchema } from '../../../core/jd/index.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { ApiLane, ProbeResult } from '../../../ports/lane.ts';
import {
  extractPortalGuid,
  getCareersHtml,
  getEmbedJobs,
  getPortalInfo,
  htmlToText,
  KekaJobSchema,
  kekaBase,
  type PortalInfo,
} from './api.ts';

/**
 * Keka keyless-ATS lane (P5 Task 4). Probe/fetch semantics ported from v0
 * (scripts/pipeline/keka.js): guess tenant subdomains from the company
 * name, confirm against the portal-info endpoint by name match, resolve
 * the tenant's portal guid (portal-info JSON, falling back to scraping
 * the /careers/ HTML), then pull active embedjobs for that guid.
 * `probe`/`fetchBoard` are called by the generic source stage
 * (pipeline/stages/source.ts) — this lane owns nothing about the
 * registry, the probe cap, or politeness throttling (spec §5).
 */

/** Tenant-subdomain guesses for a company name — the same three-shape
 * heuristic as the Greenhouse lane (companyKey squashed / hyphenated /
 * raw-squashed), additionally filtered to hostname-legal characters:
 * a tenant guess becomes the SUBDOMAIN of the probed URL (unlike
 * Greenhouse, where the token is a path segment), so anything illegal in
 * a hostname label must be dropped rather than silently probing the
 * wrong host — mirrors v0's keka.js probeCandidate filter. */
export function candidateTokens(companyName: string): string[] {
  const key = companyKey(companyName);
  const raw = String(companyName ?? '')
    .toLowerCase()
    .trim();

  const guesses = [key.replace(/-/g, ''), key, raw.replace(/[^a-z0-9]+/g, '')].filter(
    Boolean,
  );

  return [...new Set(guesses)].filter((t) => /^[a-z0-9-]+$/.test(t));
}

/** Does a tenant's own display name plausibly belong to our candidate
 * company? Ported from v0's verifyBoardName onto companyKey: exact
 * match, or either side containing the other, after normalization. */
export function verifyBoardName(
  candidateCompany: string,
  boardName: string | undefined,
): boolean {
  if (!boardName) return false;
  const a = companyKey(candidateCompany);
  const b = companyKey(boardName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Resolve a tenant's portal guid given an already-fetched PortalInfo
 * (avoids re-fetching the exact same portal-info endpoint a second time
 * within one fetchBoard call — v0's discoverGuid always re-fetches it
 * because it's a standalone function called with no prior context; here
 * fetchBoard already has it for the company name, so the guid is read
 * off that response first). Falls back to scraping the /careers/ HTML,
 * exactly as v0 does. */
async function resolveGuid(
  tenant: string,
  ctx: RunContext,
  portalInfo: PortalInfo,
): Promise<string | null> {
  if (portalInfo.guid) return portalInfo.guid;
  const html = await getCareersHtml(tenant, ctx);
  return extractPortalGuid(html);
}

export class KekaLane implements ApiLane {
  readonly kind = 'api' as const;
  readonly name = 'keka';

  async probe(company: string, ctx: RunContext): Promise<ProbeResult> {
    const candidates = candidateTokens(company);

    let sawDefiniteResponse = false;
    let lastErrorMessage: string | undefined;

    for (const token of candidates) {
      try {
        const info = await getPortalInfo(token, ctx);
        if (info.status === 200) {
          if (info.ok && verifyBoardName(company, info.name)) {
            return { status: 'found', boardRef: token };
          }
          // A real HTTP 200 that isn't a match — wrong company, or a body
          // that doesn't even parse as JSON (info.ok false) — is still
          // definitive evidence this tenant isn't ours, not a hiccup.
          sawDefiniteResponse = true;
          continue;
        }
        if (info.status === 404 || info.status === 410) {
          // Resource definitively absent — real evidence of no tenant.
          sawDefiniteResponse = true;
          continue;
        }
        // 429 (rate-limited) or 5xx (server trouble), or any other
        // non-definitive status: we got an answer but not a conclusive
        // one — treat like a network error so the registry retries
        // instead of caching a false 'not-found' for
        // reprobeNotFoundAfterDays (~30 days).
        lastErrorMessage = `HTTP ${info.status}`;
      } catch (err) {
        if (ctx.signal.aborted) throw err; // run/lane-budget abort — propagate, not evidence
        lastErrorMessage = err instanceof Error ? err.message : String(err);
        ctx.logger.warn('keka probe candidate failed', {
          company,
          token,
          error: lastErrorMessage,
        });
      }
    }

    // Same distinction as the Greenhouse lane: only report 'error' when
    // every candidate failed to give a conclusive answer (thrown network
    // error, or a 429/5xx status) — the registry retries those rather
    // than treating them as absence. A 200-with-wrong-name or a definitive
    // 404/410 for at least one candidate is real evidence of absence.
    if (!sawDefiniteResponse && lastErrorMessage) {
      return { status: 'error', message: lastErrorMessage };
    }
    return { status: 'not-found' };
  }

  async fetchBoard(boardRef: string, ctx: RunContext): Promise<JD[]> {
    const now = new Date().toISOString();

    // Not caught: a network-level failure here is the whole-board
    // failure (same fail-loud posture as v0's discoverGuid, whose own
    // portal-info fetch is likewise never try/caught in the fetch phase —
    // only the probe phase tolerates per-candidate network errors).
    const portalInfo = await getPortalInfo(boardRef, ctx);
    const guid = await resolveGuid(boardRef, ctx, portalInfo);
    if (!guid) throw new Error('no portal guid found');

    const companyName = portalInfo.ok && portalInfo.name ? portalInfo.name : boardRef;

    const rawJobs = await getEmbedJobs(boardRef, guid, ctx);

    const jobs: JD[] = [];
    for (const raw of rawJobs) {
      const parsedJob = KekaJobSchema.safeParse(raw);
      if (!parsedJob.success) {
        ctx.logger.warn('keka fetchBoard: dropped malformed job', {
          boardRef,
          error: parsedJob.error.message,
        });
        continue;
      }
      const job = parsedJob.data;
      const experiencePrefix =
        typeof job.experience === 'string' && job.experience
          ? `Experience: ${job.experience}. `
          : '';

      try {
        const jd = JDSchema.parse({
          identity: {
            id: `kk-${job.id}`,
            lane: 'keka',
            url: `${kekaBase(boardRef)}/careers/jobdetails/${job.id}`,
            company: companyName,
            title: job.title,
            scrapedAt: now,
          },
          content: { rawText: (experiencePrefix + htmlToText(job.description)).trim() },
        });
        jobs.push(jd);
      } catch (err) {
        ctx.logger.warn('keka fetchBoard: dropped job failing JDSchema', {
          boardRef,
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return jobs;
  }
}
