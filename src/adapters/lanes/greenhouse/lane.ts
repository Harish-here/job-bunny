import { companyKey, type JD, JDSchema } from '../../../core/jd/index.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { ApiLane, ProbeResult } from '../../../ports/lane.ts';
import {
  BOARDS_API,
  GreenhouseJobSchema,
  getBoardInfo,
  getBoardJobs,
  htmlToText,
} from './api.ts';

/**
 * Greenhouse keyless-ATS lane (P5 Task 3). Probe/fetch semantics ported
 * from v0 (scripts/pipeline/greenhouse.js): guess board tokens from the
 * company name, confirm against the board-info endpoint by name match,
 * then pull `jobs?content=true` for confirmed boards. `probe`/`fetchBoard`
 * are called by the generic source stage (pipeline/stages/source.ts) —
 * this lane owns nothing about the registry, the probe cap, or politeness
 * throttling; that's all the stage's job (spec §5).
 */

/** Board-token guesses for a company name (v0 tokenCandidates, ported onto
 * companyKey — v2's normalize primitive — in place of v0's normalizeName):
 *   1. companyKey(name) with the hyphens squashed out  ("Acme Robotics" → "acmerobotics")
 *   2. companyKey(name) as-is, hyphenated               ("Acme Robotics" → "acme-robotics")
 *   3. the raw lowercased name, non-alnum stripped      ("Acme Inc" → "acmeinc")
 * Deduped, order preserved — guess 3 exists to catch boards whose token
 * still carries a legal suffix that companyKey strips. */
export function candidateTokens(companyName: string): string[] {
  const key = companyKey(companyName);
  const raw = String(companyName ?? '')
    .toLowerCase()
    .trim();

  const guesses = [key.replace(/-/g, ''), key, raw.replace(/[^a-z0-9]+/g, '')].filter(
    Boolean,
  );

  return [...new Set(guesses)];
}

/** Does a board's own display name plausibly belong to our candidate
 * company? Ported from v0's verifyBoardName onto companyKey: exact match,
 * or either side containing the other, after normalization. */
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

export class GreenhouseLane implements ApiLane {
  readonly kind = 'api' as const;
  readonly name = 'greenhouse';

  async probe(company: string, ctx: RunContext): Promise<ProbeResult> {
    const candidates = candidateTokens(company);

    let sawDefiniteResponse = false;
    let lastErrorMessage: string | undefined;

    for (const token of candidates) {
      try {
        const info = await getBoardInfo(token, ctx);
        if (info.status === 200) {
          if (info.ok && verifyBoardName(company, info.name)) {
            return { status: 'found', boardRef: token };
          }
          // A real HTTP 200 that isn't a match — wrong company, or a body
          // that doesn't even parse as JSON (info.ok false) — is still
          // definitive evidence this token isn't ours, not a hiccup.
          sawDefiniteResponse = true;
          continue;
        }
        if (info.status === 404 || info.status === 410) {
          // Resource definitively absent — real evidence of no board.
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
        ctx.logger.warn('greenhouse probe candidate failed', {
          company,
          token,
          error: lastErrorMessage,
        });
      }
    }

    // Only report 'error' when every candidate failed to give a
    // conclusive answer (thrown network error, or a 429/5xx status) — the
    // registry retries those rather than treating them as absence. A
    // 200-with-wrong-name or a definitive 404/410 for at least one
    // candidate is real evidence the company has no board under any
    // guessed token: 'not-found'.
    if (!sawDefiniteResponse && lastErrorMessage) {
      return { status: 'error', message: lastErrorMessage };
    }
    return { status: 'not-found' };
  }

  async fetchBoard(boardRef: string, ctx: RunContext): Promise<JD[]> {
    const now = new Date().toISOString();

    let companyName = boardRef;
    try {
      const info = await getBoardInfo(boardRef, ctx);
      if (info.ok && info.name) companyName = info.name;
    } catch (err) {
      if (ctx.signal.aborted) throw err; // run/lane-budget abort — propagate, don't paper over it
      // Board-info lookup is a display-name nicety, not the source of
      // truth for this fetch — fall back to the boardRef itself rather
      // than fail the whole board over it.
      ctx.logger.warn(
        'greenhouse fetchBoard: board-info lookup failed, using boardRef as company',
        {
          boardRef,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    const rawJobs = await getBoardJobs(boardRef, ctx);

    const jobs: JD[] = [];
    for (const raw of rawJobs) {
      const parsedJob = GreenhouseJobSchema.safeParse(raw);
      if (!parsedJob.success) {
        ctx.logger.warn('greenhouse fetchBoard: dropped malformed job', {
          boardRef,
          error: parsedJob.error.message,
        });
        continue;
      }
      const job = parsedJob.data;

      try {
        const jd = JDSchema.parse({
          identity: {
            id: `gh-${job.id}`,
            lane: 'greenhouse',
            url: job.absolute_url,
            company: companyName,
            title: job.title,
            postedAt: job.updated_at ? job.updated_at.slice(0, 10) : undefined,
            scrapedAt: now,
          },
          content: { rawText: htmlToText(job.content) },
        });
        jobs.push(jd);
      } catch (err) {
        ctx.logger.warn('greenhouse fetchBoard: dropped job failing JDSchema', {
          boardRef,
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return jobs;
  }
}

export { BOARDS_API };
