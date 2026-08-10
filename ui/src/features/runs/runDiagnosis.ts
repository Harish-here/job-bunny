import type { RunDetail, SoftErrorSummary } from '../../lib/api/types';
import { classifyOutcome } from './runOutcome';
import {
  getBiggestDrop,
  getFailedStage,
  getFailureError,
  getFunnelStages,
} from './runResult';

/**
 * B14, amended by A4 + A5 (docs/product/run-experience-overhaul/plan.md §0).
 * A validation run against a real corpus (13 runs, 4 failures) found the
 * blueprint's original five-class list closed around an assumed
 * distribution, not an observed one — 2 of 4 observed failures were a
 * `stall` class absent from that list. Two structural amendments follow:
 *
 * A4 — `stall` is a first-class registry entry, ordered first (highest
 * observed frequency, highest diagnostic value).
 *
 * A5 — the engine is an ORDERED ARRAY of `{ kind, matches, title,
 * nextAction }` entries, iterated first-match-wins, NOT a switch/if-else
 * over `run.failure`'s contents. Adding a class costs exactly one array
 * entry plus one test — never a refactor of `classifyFailure`'s control
 * flow. Do not "simplify" this into a switch statement; the extensibility
 * is the point (plan.md §5, "Open risk carried into implementation").
 */
export type DiagnosisKind =
  | 'stall'
  | 'total-outage'
  | 'expired-login'
  | 'zero-yield-healthy'
  | 'breaker-open'
  | 'chrome-not-found'
  | 'fallback';

export interface DiagnosisVerdict {
  kind: DiagnosisKind;
  title: string;
  nextAction: string;
  /** Only carried by `'fallback'` (spec AC11): the raw, un-interpreted
   * failure text and last checkpoint, shown verbatim rather than forcing
   * an unmatched failure into an invented bucket. */
  rawError?: string;
  lastCheckpoint?: string;
}

export interface DiagnosisEntry {
  kind: DiagnosisKind;
  matches(run: RunDetail, softErrors: SoftErrorSummary | undefined): boolean;
  title(run: RunDetail, softErrors: SoftErrorSummary | undefined): string;
  nextAction(run: RunDetail, softErrors: SoftErrorSummary | undefined): string;
}

// ---- shared evidence readers -----------------------------------------

function errorText(run: RunDetail): string {
  return getFailureError(run.failure) ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Mirrors `RunFailure.lastCheckpoint` (ports/run_store.ts) — narrowed
 * defensively like every other `RunDetail.failure` reader on this path
 * (runResult.ts's doc comment: opaque at the port boundary). */
function getFailureLastCheckpoint(failure: unknown): string | undefined {
  if (!isRecord(failure)) return undefined;
  return typeof failure.lastCheckpoint === 'string' ? failure.lastCheckpoint : undefined;
}

// ---- class (vi) stall — src/pipeline/runner/guard.ts's armStall() -----
// Exact thrown/recorded shape (guard.ts): `stage "${stage.name}" stalled:
// no beat() within ${stallMs}ms` — matched on the stable
// `'stalled: no beat()'` substring per plan.md's table, not the whole
// string, so a stage-name/timeout wording tweak doesn't break detection.
const STALL_SUBSTRING = 'stalled: no beat()';
const STALL_TIMEOUT_PATTERN = /stalled: no beat\(\) within (\d+)ms/;

function stallMinutes(error: string): number | undefined {
  const match = STALL_TIMEOUT_PATTERN.exec(error);
  const raw = match?.[1];
  if (!raw) return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) ? Math.round(ms / 60000) : undefined;
}

// ---- total-outage — farm.ts/source.ts's all-lanes-failed guard --------
// Both stages' thrown message contains the literal substring 'total
// outage' ("... total outage, not one broken lane") — this is the shape
// CLAUDE.md's fail-loud-on-total-outage invariant produces, and per
// plan.md's table it is the class an ambiguous 'expired-login' match must
// never outrank.
const TOTAL_OUTAGE_SUBSTRING = 'total outage';

// ---- class (i) expired-login — LinkedIn's own all-urls-failed message -
// evidence.ts:120-125's exact wording: 'linkedin lane: all N attempted
// url(s) failed this run.' Best-effort, explicitly imprecise (blueprint
// §7's "Class (i) divergence" — the pipeline itself declines to assert a
// login expired over this evidence), and per plan.md's registry order
// this class is checked AFTER total-outage so an overlapping fixture
// never misclassifies as expired-login.
const EXPIRED_LOGIN_PATTERN = /all \d+ attempted url\(s\) failed this run/;

// ---- class (ii) breaker-open — lane.ts:154-158's exact warn message ---
const BREAKER_OPEN_SAMPLE_SUBSTRING = 'throttle breaker is open';

function hasBreakerOpenWarn(softErrors: SoftErrorSummary | undefined): boolean {
  if (!softErrors) return false;
  return softErrors.groups.some((group) =>
    group.sample.includes(BREAKER_OPEN_SAMPLE_SUBSTRING),
  );
}

// ---- class (v) chrome-not-found — launcher.ts:105-108's exact message -
const CHROME_NOT_FOUND_SUBSTRING = 'no Chrome executable found';

// ---- class (iv) zero-yield-healthy — delegates to B13's health gate ---
function zeroYieldHealthyTitle(run: RunDetail): string {
  const stages = getFunnelStages(run.result) ?? [];
  const drop = getBiggestDrop(stages);
  const base = 'Ran clean — no jobs made it through your filter.';
  return drop
    ? `${base} Biggest drop: \`${drop.stage}\` — ${drop.count} by \`${drop.rule}\`.`
    : base;
}

// ---- the registry, in the exact plan.md order --------------------------
const REGISTRY: DiagnosisEntry[] = [
  {
    kind: 'stall',
    matches: (run) => errorText(run).includes(STALL_SUBSTRING),
    title: (run) => {
      const stage = getFailedStage(run.failure) ?? 'a';
      const minutes = stallMinutes(errorText(run));
      return minutes !== undefined
        ? `The \`${stage}\` stage stopped reporting progress for ${minutes} minute(s).`
        : `The \`${stage}\` stage stopped reporting progress.`;
    },
    nextAction: () => 'Run again',
  },
  {
    kind: 'total-outage',
    matches: (run) => errorText(run).includes(TOTAL_OUTAGE_SUBSTRING),
    title: (run) => {
      const stage = getFailedStage(run.failure) ?? 'a';
      return (
        `Every attempted lane in the \`${stage}\` stage failed this run — ` +
        'this looks like an expired login or a broader outage.'
      );
    },
    nextAction: () => 'Run again',
  },
  {
    kind: 'expired-login',
    matches: (run) =>
      getFailedStage(run.failure) === 'source' &&
      EXPIRED_LOGIN_PATTERN.test(errorText(run)),
    title: () => 'LinkedIn login has expired.',
    nextAction: () => 'Run again',
  },
  {
    kind: 'zero-yield-healthy',
    matches: (run, softErrors) => classifyOutcome(run, softErrors) === 'empty',
    title: (run) => zeroYieldHealthyTitle(run),
    nextAction: () => 'Review filter rules',
  },
  {
    kind: 'breaker-open',
    matches: (_run, softErrors) => hasBreakerOpenWarn(softErrors),
    title: () => 'LinkedIn is soft-blocking us — the throttle breaker is open.',
    nextAction: () => 'Run again once the throttle breaker reopens',
  },
  {
    kind: 'chrome-not-found',
    matches: (run) => errorText(run).includes(CHROME_NOT_FOUND_SUBSTRING),
    title: () => "Chrome wasn't found at any known path.",
    nextAction: () => 'Run `jobbunny doctor`',
  },
];

/**
 * Iterates `entries` in order, first match wins — exported so a test can
 * exercise the registry's own iteration against an array literal (A5's
 * extensibility claim, made mechanically checkable) without touching
 * `classifyFailure`'s signature. Returns `null` when nothing matches,
 * leaving the caller to build the fallback verdict.
 */
export function runRegistry(
  entries: DiagnosisEntry[],
  run: RunDetail,
  softErrors: SoftErrorSummary | undefined,
): DiagnosisVerdict | null {
  for (const entry of entries) {
    if (entry.matches(run, softErrors)) {
      return {
        kind: entry.kind,
        title: entry.title(run, softErrors),
        nextAction: entry.nextAction(run, softErrors),
      };
    }
  }
  return null;
}

/**
 * Classifies a run's failure into the registry's diagnosis vocabulary
 * (plan.md B14, amended by A4/A5). An unmatched failure falls through to
 * `{ kind: 'fallback', rawError, lastCheckpoint }` with no invented `kind`
 * (spec AC11) — the designed-for outcome for a long-tail failure text,
 * not an error case.
 */
export function classifyFailure(
  run: RunDetail,
  softErrors: SoftErrorSummary | undefined,
): DiagnosisVerdict {
  const matched = runRegistry(REGISTRY, run, softErrors);
  if (matched) return matched;

  return {
    kind: 'fallback',
    title: `Failed at \`${getFailedStage(run.failure) ?? 'unknown stage'}\``,
    nextAction: 'Run again',
    rawError: getFailureError(run.failure) ?? '',
    lastCheckpoint: getFailureLastCheckpoint(run.failure),
  };
}
