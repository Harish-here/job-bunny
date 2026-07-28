import type { z } from 'zod';
import { isSoftError, SoftError } from '../../../core/errors/index.ts';

/** Distinct whole-url/per-card failure shapes, counted (with one sample
 * message each) separately in the all-urls-failed evidence rather than
 * collapsed into a single guessed cause — see the throw site in
 * `lane.ts`'s `source()`. */
export type FailureKind = 'zero-cards' | 'field-validation' | 'jd-open' | 'other';

/** Per-url bookkeeping for one source() run — the single record the
 * aggregate guards, the failure evidence, and the extraction-source
 * observability are all derived from (replaces the parallel scalar
 * counters that previously fed each of those independently). */
export interface UrlStat {
  url: string;
  /** Cards that reached a JD open (post gate/cache/dedup/cap filtering). */
  cardsAttempted: number;
  captured: number;
  /** Captures whose text came from the anchor-text fallback, not jdRoot. */
  anchorExtractions: number;
  failed: boolean;
  failures: Array<{ kind: FailureKind; message: string }>;
}

export function zodIssuesMessage(err: z.ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Normalizes any thrown value into a SoftError of the given scope,
 * passing an already-SoftError through unchanged (its message already
 * carries the relevant context, e.g. jd_open's card url). */
export function toSoftError(scope: string, target: string, err: unknown): SoftError {
  if (isSoftError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SoftError(scope, `${target}: ${message}`, { cause: err });
}

/** Every attempted url failed: this is not one broken selector — fail
 * loud rather than a silently-green zero-job run (v0
 * checkAggregateFailure). It is NOT always an expired session, though
 * (2026-07-25: a healthy session failed this guard because card
 * title/company selectors had drifted, not because of a logout wall —
 * see memory/extract-flaky root-cause notes). Report the observed
 * evidence and let it point at distinct candidate causes instead of
 * asserting one guessed cause. PURE — returns the message to throw;
 * `lane.ts` owns the actual `throw`. */
export function buildAllUrlsFailedMessage(
  attemptedUrls: number,
  stats: UrlStat[],
  shellJdFailures: number,
): string {
  const failures = stats.flatMap((s) => s.failures);
  const countOf = (kind: FailureKind) => failures.filter((f) => f.kind === kind).length;
  const sampleOf = (kind: FailureKind) => failures.find((f) => f.kind === kind)?.message;

  const evidence: string[] = [];
  const zeroCards = countOf('zero-cards');
  if (zeroCards > 0) {
    const sample = sampleOf('zero-cards');
    evidence.push(
      `${zeroCards}/${attemptedUrls} url(s) found zero (or too few) cards in ` +
        `the DOM${sample ? ` (e.g. "${sample}")` : ''} — ` +
        'consistent with an authwall/logout wall OR a broken results-list selector; ' +
        'candidates: check .chrome-debug/ session state, and/or whether the ' +
        'list-container selector still matches (src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json).',
    );
  }
  const fieldValidation = countOf('field-validation');
  if (fieldValidation > 0) {
    const sample = sampleOf('field-validation');
    evidence.push(
      `${fieldValidation} card(s) had empty/invalid title or company after ` +
        `extraction${sample ? ` (e.g. "${sample}")` : ''} ` +
        '— cards WERE found in the DOM, but field extraction failed schema validation; ' +
        'one candidate is drifted title/company sub-selectors in ' +
        'src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json ' +
        '(regenerate via /page-analyse). This signal on its own does not rule out a ' +
        'degraded/throttled session, so do not treat the inventory as proven guilty.',
    );
  }
  const jdOpen = countOf('jd-open');
  if (jdOpen > 0) {
    const sample = sampleOf('jd-open');
    if (shellJdFailures > 0) {
      // The 2026-07-28 signature: jdRoot present, textContent empty,
      // hydration request 503 while everything else on the page
      // returned 200 — the same job rendered fine to a logged-out
      // guest. Pointing at the inventory here is exactly the
      // misdiagnosis D13 exists to end.
      evidence.push(
        `${shellJdFailures} of ${jdOpen} JD-open failure(s) found the jdRoot element ` +
          'PRESENT but empty — the server withheld the JD content while serving the ' +
          'rest of the page normally. That is a rate-limit/soft-block on the shared ' +
          '.chrome-debug session, not DOM drift: the page inventory is not implicated ' +
          'and regenerating it will not help. Wait out the throttle breaker cooldown ' +
          '(.chrome-debug/.jobbunny-linkedin-breaker.json) — the next fire past it ' +
          'probes automatically.',
      );
    } else {
      evidence.push(
        `${jdOpen} card(s) were found and extracted, but JD-open failed for ` +
          `them${sample ? ` (e.g. "${sample}")` : ''} — a different ` +
          'failure mode from the above two; check the jdRoot selector or JD-pane load timing.',
      );
    }
  }
  const other = countOf('other');
  if (other > 0) {
    const sample = sampleOf('other');
    evidence.push(
      `${other} url(s) failed for other reasons${sample ? ` (e.g. "${sample}")` : ''}.`,
    );
  }
  return (
    `linkedin lane: all ${attemptedUrls} attempted url(s) failed this run. ` +
    (evidence.length > 0
      ? evidence.join(' ')
      : 'No further diagnostic evidence was captured for the underlying failures.')
  );
}

/** Verdict for the lane-wide "no JD ever opened" guard (spec: reached only
 * when the all-urls-failed check did NOT already throw). `shouldThrow` is
 * true when there is no earlier same-day capture to fall back on;
 * otherwise the caller (`lane.ts`) logs `message` as a warning and returns
 * the preserved captures instead of failing the run. PURE — `lane.ts` owns
 * the actual `throw`/`ctx.logger.warn` call. */
export interface NoJdCapturedVerdict {
  shouldThrow: boolean;
  message: string;
}

export function buildNoJdCapturedVerdict(
  totalCardsAttempted: number,
  attemptedUrls: number,
  priorCaptures: number,
): NoJdCapturedVerdict {
  if (priorCaptures === 0) {
    return {
      shouldThrow: true,
      message:
        `linkedin lane: ${totalCardsAttempted} card(s) were attempted across ` +
        `${attemptedUrls} url(s) this run, but zero JDs were captured — every JD-open ` +
        'failed. Check the JD-open path (openJd, jd_open.ts) and whether the jdRoot ' +
        'selector still matches (src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json).',
    };
  }
  return {
    shouldThrow: false,
    message:
      'linkedin lane: every JD-open failed this fire — returning JDs preserved from an earlier same-day fire instead of failing the run',
  };
}
