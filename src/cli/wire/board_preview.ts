/**
 * cli/wire/board_preview.ts (R15, filter-rule drop preview) —
 * `BoardSource.previewFilterRule`'s real implementation, split out of
 * `board.ts` purely for the file-size cap (`board.ts` is already close to
 * its 400-line cap and cannot absorb this). Mirrors `board_daemon.ts`'s /
 * `board_doctor.ts`'s own precedent for splitting a `BoardSource` method's
 * body out of `board.ts` — NOT a member of `only-wire-imports-adapters`'s
 * carve-out (`.dependency-cruiser.cjs`'s `pathNot` there names only
 * `compose|builders|registry|board|daemon|daemon_deferred|migrate\.ts$` —
 * this file isn't on that list), and it doesn't need to be: this module
 * imports no `src/adapters/**` directly. The checkpoint store is injected
 * via `PreviewFilterRuleDeps.openCheckpointStore` — constructed in
 * `board.ts` (which IS carve-out-legal) — the same delegate-not-import
 * posture `board_doctor.ts`'s own doc comment already documents.
 *
 * Read-only and reruns nothing: it reads the most recent run's pre-filter
 * candidate pool from a checkpoint and re-evaluates it against `core/filter`
 * twice (current config, then the draft) — never the pipeline itself, never
 * a stored config.
 */
import { decide, evaluate, FilterConfigSchema } from '../../core/filter/index.ts';
import type { StructuredJD } from '../../core/jd/index.ts';
import type { BoardSource, FilterPreviewResult } from '../../ports/board.ts';
import type { CheckpointStore } from '../../ports/checkpoint_store.ts';

/** Newest-first runs to try before giving up — never unbounded scanning. */
const MAX_RECENT_RUNS = 5;
/** The stage that immediately precedes `filter` in the frozen pipeline
 * order (`reconcile → farm → source → compress → structure → assemble →
 * filter → dedup → rank → sync`) — its checkpoint holds the full pre-filter
 * candidate pool. */
const ASSEMBLE_STAGE = 'assemble';
/** Matches the mockup's disclosure, "see which 12 →". */
const NEWLY_DROPPED_CAP = 12;

export interface PreviewFilterRuleDeps {
  source: BoardSource;
  /** Opens a short-lived `CheckpointStore` for `name` — the real adapter is
   * constructed in `board.ts`, never here (see this file's own header). The
   * caller of `previewFilterRule` below always closes what this returns. */
  openCheckpointStore(name: string): CheckpointStore;
}

/** A checkpoint payload is opaque `unknown` at the port boundary by
 * design — never trust it blindly. This is the shape every stage on the
 * job-flow path (`pipeline/runner/stage.ts`'s `StagePayload`) actually
 * writes, but a malformed/foreign payload must degrade, never throw. */
interface RawCheckpointPayload {
  jobs: unknown[];
  dropped: unknown[];
}

function isRawCheckpointPayload(payload: unknown): payload is RawCheckpointPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as { jobs?: unknown; dropped?: unknown };
  return Array.isArray(candidate.jobs) && Array.isArray(candidate.dropped);
}

/** `pipeline/runner/stage.ts`'s `StagePayload.jobs` is typed `JD[]`, and
 * `JD.structured` is `.optional()` (`core/jd/schema.ts`) — a `JD` with no
 * `structured` slice satisfies `StagePayload` but NOT `StructuredJD`.
 * `core/filter`'s `evaluate(jd: StructuredJD, ...)` assumes it is present,
 * so any entry failing this guard is dropped, never thrown on. */
function isStructuredJD(jd: unknown): jd is StructuredJD {
  return (
    typeof jd === 'object' && jd !== null && (jd as StructuredJD).structured !== undefined
  );
}

export async function previewFilterRule(
  deps: PreviewFilterRuleDeps,
  name: string,
  draftFilterConfig: unknown,
): Promise<FilterPreviewResult> {
  // (1) Validate the draft FIRST — never touch a store on a malformed
  // request. Throw: the route layer converts this into a 422 (same posture
  // as `writeConfigDoc`'s validator-throw contract).
  const draftParsed = FilterConfigSchema.safeParse(draftFilterConfig);
  if (!draftParsed.success) {
    const issue = draftParsed.error.issues[0];
    const field = issue?.path.join('.') || 'body';
    throw new Error(issue ? `${field}: ${issue.message}` : 'invalid filter config');
  }
  const draftConfig = draftParsed.data;

  // (2) Recent runs, newest-first, capped at MAX_RECENT_RUNS. `openStore`
  // returns null for a profile with no db at all — that alone already
  // means no run exists.
  const store = await deps.source.openStore(name);
  const runs = store ? store.listRuns({ limit: MAX_RECENT_RUNS }).rows : [];
  if (runs.length === 0) return { available: false, reason: 'no_recent_run' };

  // (3) First checkpoint hit wins — stop iterating as soon as one run
  // yields an `assemble` checkpoint.
  const checkpointStore = deps.openCheckpointStore(name);
  let hitPayload: unknown;
  let found = false;
  try {
    for (const run of runs) {
      const hit = checkpointStore.readAt(run.date, run.timeDir ?? '', ASSEMBLE_STAGE);
      if (hit) {
        hitPayload = hit.payload;
        found = true;
        break;
      }
    }
  } finally {
    checkpointStore.close();
  }
  if (!found) return { available: false, reason: 'checkpoint_expired' };

  // (4) Defensive parse — never throw on a malformed payload.
  if (!isRawCheckpointPayload(hitPayload)) {
    return { available: false, reason: 'checkpoint_expired' };
  }

  // (4a) Narrow to structured jobs before evaluating; drop (never throw on)
  // anything that fails the guard. All-unstructured degrades rather than
  // reporting a preview over zero jobs as if it were meaningful.
  const structuredJobs = hitPayload.jobs.filter(isStructuredJD);
  if (structuredJobs.length === 0) {
    return { available: false, reason: 'checkpoint_expired' };
  }

  // (5) The profile's CURRENT filter.json — an absent doc reads as the
  // schema's own defaults, mirroring `compose.ts`'s own
  // `filterCfgForStage = filterCfg ?? FilterConfigSchema.parse({})`.
  const currentRaw = await deps.source.readConfigDoc(name, 'filter.json');
  const currentConfig =
    currentRaw === undefined
      ? FilterConfigSchema.parse({})
      : FilterConfigSchema.parse(JSON.parse(currentRaw));

  // (6) Evaluate every narrowed, structured job twice — current, then
  // draft. `core/filter`'s `evaluate`/`decide` are reused directly; zero
  // reimplementation of filter logic here.
  let baselineDrops = 0;
  let draftDrops = 0;
  const newlyDropped: Array<{ title: string; company: string }> = [];
  for (const jd of structuredJobs) {
    const baselineDecision = decide(evaluate(jd, currentConfig));
    const draftDecision = decide(evaluate(jd, draftConfig));
    if (baselineDecision === 'drop') baselineDrops += 1;
    if (draftDecision === 'drop') draftDrops += 1;
    if (
      draftDecision === 'drop' &&
      baselineDecision !== 'drop' &&
      newlyDropped.length < NEWLY_DROPPED_CAP
    ) {
      newlyDropped.push({ title: jd.identity.title, company: jd.identity.company });
    }
  }

  return {
    available: true,
    totalJobs: structuredJobs.length,
    baselineDrops,
    draftDrops,
    newlyDropped,
  };
}
