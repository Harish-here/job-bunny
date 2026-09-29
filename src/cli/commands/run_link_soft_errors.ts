/**
 * run_link_soft_errors.ts (blueprint-be.md Step 14, R11) — reads back
 * farm's side-written `link_soft_errors.json` state doc, applies the
 * cross-invocation staleness guard, resolves each URL's `search_urls.md`
 * label, and enriches the run's `RunResult.linkSoftErrors` for the digest
 * and run-detail views.
 *
 * This module is under `cli/commands/`, not the `only-wire-imports-adapters`
 * carve-out, so `search_urls.md` label resolution goes through
 * `wireConfigStore` (a plain function import from `../wire/index.ts`, never
 * `src/adapters/**` directly) — exactly like `configCommand` does.
 *
 * Importing `LINK_SOFT_ERRORS_PATH`/`LinkSoftErrorsSchema` straight from
 * `pipeline/stages/farm.ts` is a deliberate, feature-scoped coupling
 * (`cli` is free to import `pipeline` — no boundary rule forbids it),
 * chosen over the larger alternative of threading a stage-specific field
 * through the stage-agnostic `StagePayload`/`runPipeline` contract.
 */
import { resolveSearchUrlLabels } from '../../core/config/search_urls/index.ts';
import type { RunResult } from '../../ops/observability/index.ts';
import {
  LINK_SOFT_ERRORS_PATH,
  LinkSoftErrorsSchema,
} from '../../pipeline/stages/farm.ts';
import type { Logger } from '../../ports/context.ts';
import type { StateStore } from '../../ports/state_store.ts';
import { wireConfigStore } from '../wire/index.ts';

export interface ResolveLinkSoftErrorsOptions {
  stateStore: StateStore;
  profile: string;
  root: string;
  /** This invocation's own start time — the staleness guard's cutoff. A
   * doc older than this was written by a DIFFERENT invocation (an earlier
   * `--resume` that skipped farm, or a standalone `stage farm`) and must
   * never be attributed to this run. */
  runStartedAtIso: string;
  logger: Logger;
}

/** Cheap short-circuit for a `'failed'` outcome (no attempted read at all),
 * then a fail-soft best-effort enrichment: any read/parse/label failure
 * logs a warning and returns `result` untouched — label/side-doc
 * enrichment is cosmetic and must never fail an otherwise-passed run. */
export async function resolveLinkSoftErrors(
  result: RunResult,
  opts: ResolveLinkSoftErrorsOptions,
): Promise<RunResult> {
  if (result.outcome !== 'passed') return result;
  try {
    const doc = await opts.stateStore.readDoc(
      LINK_SOFT_ERRORS_PATH,
      LinkSoftErrorsSchema,
    );
    if (!doc || doc.links.length === 0) return result;
    // A doc older than THIS invocation's own start time was written by a
    // DIFFERENT invocation and must never be attributed to this run.
    if (doc.writtenAt < opts.runStartedAtIso) return result;

    let labels = new Map<string, string>();
    const configStore = wireConfigStore(opts.profile, {
      root: opts.root,
      liftMode: 'readonly',
    });
    try {
      const raw = await configStore.readText('search_urls.md');
      if (raw) labels = resolveSearchUrlLabels(raw); // keyed by cleaned URL
    } finally {
      configStore.close();
    }

    return {
      ...result,
      linkSoftErrors: doc.links.map((l) => ({
        url: l.url,
        reason: l.reason,
        label: labels.get(l.url),
      })),
    };
  } catch (err) {
    // Fail-soft, explicitly: label/side-doc enrichment is cosmetic — never
    // fail an otherwise-passed run over it.
    opts.logger.warn(
      'run: link-soft-error enrichment failed — digest/run-detail will show URLs without labels',
      { message: err instanceof Error ? err.message : String(err) },
    );
    return result;
  }
}
