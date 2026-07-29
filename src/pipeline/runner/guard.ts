import type { PipelineCtx } from './context.ts';
import type { StageDef } from './stage.ts';

/**
 * guardStage wraps a single StageDef attempt with a per-attempt timeout
 * (AbortSignal.timeout), an optional heartbeat-stall watchdog, and retry.
 *
 * Internal to pipeline/runner — not part of the frozen P3 handoff contract
 * (runPipeline is). Returns `{ output, attempts }` (not a bare `Out`) so the
 * runner (Task 6) can surface the attempt count in result.json's per-stage
 * `attempts` field without re-deriving it.
 *
 * Terminal vs retryable: an abort driven by `ctx.signal` (the run-level
 * signal, already-aborted or aborted mid-attempt) is a terminal run-level
 * cancellation — it is rethrown immediately with no retry. A per-stage
 * timeout or any thrown/rejected error from `stage.run` is retryable up to
 * `stage.retries` additional attempts.
 */
export async function guardStage<In, Out>(
  stage: StageDef<In, Out>,
  input: In,
  ctx: PipelineCtx,
  opts: { stallMs: number },
): Promise<{ output: Out; attempts: number }> {
  const maxAttempts = stage.retries + 1;
  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;

    if (ctx.signal.aborted) {
      throw runLevelAbortError(ctx.signal);
    }

    try {
      const output = await runOneAttempt(stage, input, ctx, opts.stallMs);
      return { output, attempts };
    } catch (err) {
      if (isRunLevelAbort(err, ctx.signal)) {
        throw err;
      }
      lastError = err;
      ctx.logger.warn('stage attempt failed', {
        stage: stage.name,
        attempt,
        maxAttempts,
        error: err instanceof Error ? err.message : String(err),
      });
      // fall through to retry (if attempts remain)
    }
  }

  throw new Error(`stage "${stage.name}" failed after ${attempts} attempt(s)`, {
    cause: lastError,
  });
}

function runLevelAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error('run-level abort', { cause: reason });
}

function isRunLevelAbort(err: unknown, runSignal: AbortSignal): boolean {
  if (!runSignal.aborted) return false;
  const reason = runSignal.reason;
  if (reason === undefined) return false;
  return err === reason || (err instanceof Error && err.cause === reason);
}

async function runOneAttempt<In, Out>(
  stage: StageDef<In, Out>,
  input: In,
  ctx: PipelineCtx,
  stallMs: number,
): Promise<Out> {
  const stallController = new AbortController();
  const attemptSignal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(stage.timeoutMs),
    stallController.signal,
  ]);

  let stallTimer: NodeJS.Timeout | undefined;

  const armStall = () => {
    if (!stage.heartbeat) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallController.abort(
        new Error(`stage "${stage.name}" stalled: no beat() within ${stallMs}ms`),
      );
    }, stallMs);
    stallTimer.unref?.();
  };

  const childCtx: PipelineCtx = {
    ...ctx,
    signal: attemptSignal,
    beat() {
      armStall();
      ctx.beat();
    },
  };

  if (stage.heartbeat) armStall();

  const onAbort = () => abortReject?.(toAbortError(attemptSignal, stage.name));
  let abortReject: ((err: Error) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
    if (attemptSignal.aborted) {
      onAbort();
      return;
    }
    attemptSignal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([stage.run(input, childCtx), abortPromise]);
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    attemptSignal.removeEventListener('abort', onAbort);
  }
}

function toAbortError(signal: AbortSignal, stageName: string): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(`stage "${stageName}" aborted`, { cause: reason });
}
