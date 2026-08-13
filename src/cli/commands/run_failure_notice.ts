/**
 * run_failure_notice.ts (P8 stability-hardening 1.16) — the `'failed'`-
 * outcome half of `run.ts`'s notify call site (D3 — R17-R20). Split out of
 * `run.ts` itself (rather than colocated there, the brief's own default)
 * because adding this inline pushed `run.ts` to 460 lines, over the
 * 400-line implementation cap — a genuinely "more natural home" only
 * discovered once written, per the brief's own step 9 judgment-call
 * discipline (flag, don't silently restructure without recording it).
 *
 * `pipeline/runner/` stays untouched (AC8): the failure error text is read
 * back HERE, via the run store's own `getRun` reader
 * (`ports/run_store.ts`), never threaded through `RunResult` — see
 * `run.ts`'s own header for why threading it through the runner is
 * forbidden, not merely undesirable.
 */
import {
  composeFailureNotice,
  type DedupState,
  DedupStateSchema,
  decideNotification,
  formatDigest,
  type RunResult,
} from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';

const FAILURE_DEDUP_KEY = 'notify/failure_dedup.json';

/** Reduces volatile substrings in a raw failure-error string so two
 * occurrences of the SAME underlying cause produce the SAME dedup
 * signature (blueprint-be.md step 1.16) — order matters: a URL substring
 * is reduced to origin+pathname FIRST (dropping its query/fragment), THEN
 * every remaining digit run collapses to `<N>` (elapsed-ms, ports, pids,
 * retry counts). Raw concatenation is wrong in both directions: too
 * volatile and dedup never fires (an elapsed-ms count changes every
 * occurrence of the identical failure); too coarse (e.g. `failedStage`
 * alone) and genuinely different failures at the same stage collapse into
 * one — see the blueprint's own worked incident example. */
export function normalizeFailureText(text: string): string {
  const urlsNormalized = text.replace(/https?:\/\/\S+/g, (match) => {
    try {
      const url = new URL(match);
      return `${url.origin}${url.pathname}`;
    } catch {
      return match; // not a parseable URL substring — leave untouched, never throw
    }
  });
  return urlsNormalized.replace(/\d+/g, '<N>');
}

/** `RunDetail.failure` is an opaque JSON blob (`ports/run_store.ts`:
 * "shapes owned by their writers") — this guards the `RunFailure` shape at
 * read time instead of casting, falling back to a stable placeholder if it
 * doesn't match. Never throws: a malformed/missing failure blob must not
 * crash the notify path. */
export function extractFailureError(failure: unknown): string {
  if (
    typeof failure === 'object' &&
    failure !== null &&
    'error' in failure &&
    typeof (failure as { error: unknown }).error === 'string'
  ) {
    return (failure as { error: string }).error;
  }
  return 'unknown error';
}

/** Reconstructs `composeFailureNotice`'s `suppressedSignature` display text
 * (`stage "X" — <error text>`) from a prior `DedupState.signature` string
 * (`X::<normalized error text>`) — `failure_notice.ts`'s own contract wants
 * ALREADY pretty-printed text, never the raw `stage::error` join
 * `decideNotification` compares internally. */
export function prettySignature(signature: string): string {
  const sepIndex = signature.indexOf('::');
  if (sepIndex === -1) return `stage "${signature}"`;
  return `stage "${signature.slice(0, sepIndex)}" — ${signature.slice(sepIndex + 2)}`;
}

/** The `'failed'`-outcome notify path (D3 — R17-R20): reads this run's own
 * recorded failure text back via the run store, builds a normalized
 * signature, and defers to `decideNotification` for send/remind/suppress.
 * `writeDoc` always runs, AFTER `ctx.notify` has already resolved, wrapped
 * so a write failure can only fail to update NEXT time's bookkeeping —
 * never this run's own exit code (blueprint-be.md §8, "Dedup state
 * read/write (1.16)").
 *
 * Accepted risk (deliberate, not missed): `PipelineCtx.notify` is
 * `Promise<void>` (`pipeline/runner/context.ts`), and the real
 * implementation (`cli/wire/compose.ts`) is `Promise.allSettled` over every
 * configured notifier plus per-notifier error logging — it never signals
 * whether any send actually reached its destination. `action.nextState` is
 * therefore written UNCONDITIONALLY below, exactly as it always has been:
 * a silently-dropped delivery (e.g. a revoked Telegram token) still stamps
 * `lastNotifiedAt`, which can suppress the SAME recurring failure's next
 * alert for up to 24h during an outage the operator has no other signal
 * of. Widening `PipelineCtx.notify` to `Promise<boolean>` (mirroring
 * `ops/daemon/deps.ts`'s `DaemonDeps.notify`, which DOES carry a delivery
 * signal) would close this, but touches the shared pipeline-wide contract
 * and every `PipelineCtx` fixture across `pipeline/`, `routines/`, and
 * `cli/commands/*.test.ts` — out of scope for this call site alone. See
 * `run.dedup.test.ts`'s own pin of this behavior. */
export async function sendFailureDigest(
  ctx: PipelineCtx,
  runId: number,
  result: RunResult,
  profile: string,
  dryRun: boolean,
  nowIso: string,
): Promise<void> {
  const detail = ctx.runStore.getRun(runId);
  const errorText = extractFailureError(detail?.failure);
  const signature = `${result.failedStage ?? 'unknown'}::${normalizeFailureText(errorText)}`;

  // `readDoc` returning `undefined` (first-ever failure, or a genuinely
  // absent key) is "no prior state" — `decideNotification` always sends in
  // that case, per the port's own contract: fails toward MORE notification.
  // A row that EXISTS but fails to parse against `DedupStateSchema` THROWS
  // (`ports/state_store.ts`'s own documented contract) — caught here and
  // treated the same as "no prior state" so a corrupt/stale dedup doc can
  // only ever cost next time's bookkeeping, never this run's own failure
  // notification (the same fails-toward-more-notification posture as the
  // `writeDoc` guard below).
  let prior: DedupState | undefined;
  try {
    prior = await ctx.stateStore.readDoc(FAILURE_DEDUP_KEY, DedupStateSchema);
  } catch (err) {
    ctx.logger.warn('failed to read failure-dedup state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const action = decideNotification(prior, signature, nowIso);

  if (action.action === 'send' || action.action === 'remind') {
    // T3's wrapper text only when a DIFFERENT prior signature was (would
    // have been) suppressed — a true first-ever failure or a same-
    // signature 'remind' never passes this.
    const suppressedSignature =
      action.action === 'send' && prior !== undefined && prior.signature !== signature
        ? prettySignature(prior.signature)
        : undefined;
    // T3's "STILL OPEN" line describes the SUPPRESSED (prior) signature, so
    // its count/since must come from `prior`'s own accumulated state, not
    // `action.nextState` — `decideNotification` RESETS `nextState` to
    // `consecutiveCount: 1`/`firstSeenAt: now` for the new signature that
    // just broke through, which is right for the NEW signature but wrong
    // for describing how long/how often the OLD one has recurred.
    const [count, firstSeenAt] =
      suppressedSignature !== undefined && prior !== undefined
        ? [prior.consecutiveCount, prior.firstSeenAt]
        : [action.nextState.consecutiveCount, action.nextState.firstSeenAt];
    await ctx.notify({
      kind: 'digest',
      profile,
      text: composeFailureNotice(
        formatDigest(result, { dryRun }),
        action.action,
        count,
        firstSeenAt,
        suppressedSignature,
      ),
    });
  }

  try {
    await ctx.stateStore.writeDoc(FAILURE_DEDUP_KEY, action.nextState);
  } catch (err) {
    // LOUD per StateStore's own contract, but this call site must not let
    // that escape into the run's own exit code — logged, not fatal.
    ctx.logger.warn('failed to write failure-dedup state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
