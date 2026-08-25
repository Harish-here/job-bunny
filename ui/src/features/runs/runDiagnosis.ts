import type { RunDetail, RunEventRow, SoftErrorSummary } from '../../lib/api/types';
import type { DiagnosisAction } from './diagnosisActions';
import {
  copyAction,
  navigateAction,
  readBreakerRetryAt,
  revealAction,
  runAction,
} from './diagnosisActions';
import { classifyOutcome, TOTAL_PIPELINE_STAGES } from './runOutcome';
import {
  getBiggestDrop,
  getFailedStage,
  getFailureError,
  getFunnelStages,
} from './runResult';

export type { DiagnosisAction } from './diagnosisActions';

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
 * A5 — the engine is an ORDERED ARRAY of `{ kind, matches, title, action }`
 * entries, iterated first-match-wins, NOT a switch/if-else over
 * `run.failure`'s contents. Adding a class costs exactly one array entry
 * plus one test — never a refactor of `classifyFailure`'s control flow. Do
 * not "simplify" this into a switch statement; the extensibility is the
 * point (plan.md §5, "Open risk carried into implementation").
 */
export type DiagnosisKind =
  | 'stall'
  | 'total-outage'
  | 'expired-login'
  | 'zero-yield-healthy'
  | 'breaker-open'
  | 'chrome-not-found'
  | 'degraded'
  | 'fallback';

/** Everything a diagnosis entry needs to classify and act on a run,
 * bundled into one object rather than positional params so a new evidence
 * source (events, profile name) doesn't ripple through every entry's
 * signature. */
export interface DiagnosisInput {
  run: RunDetail;
  softErrors: SoftErrorSummary | undefined;
  events?: RunEventRow[];
  /** The profile whose run this is — interpolated into the
   * chrome-not-found copy command. */
  profile: string;
}

export interface DiagnosisVerdict {
  kind: DiagnosisKind;
  title: string;
  /** The primary call-to-action. Always present — every verdict has a real
   * target. The panel renders it quietly (not as a primary button) for the
   * calm 'zero-yield-healthy' kind; that tone choice is the panel's, not
   * this module's. */
  action: DiagnosisAction;
  /** Optional quiet secondary — the mockup pairs a primary button with a
   * quiet link on every failure state. */
  secondaryAction?: DiagnosisAction;
  /** Only carried by `'fallback'` (spec AC11): the raw, un-interpreted
   * failure text and last checkpoint, shown verbatim rather than forcing
   * an unmatched failure into an invented bucket. */
  rawError?: string;
  lastCheckpoint?: string;
}

export interface DiagnosisEntry {
  kind: DiagnosisKind;
  matches(input: DiagnosisInput): boolean;
  title(input: DiagnosisInput): string;
  action(input: DiagnosisInput): DiagnosisAction;
  secondaryAction?(input: DiagnosisInput): DiagnosisAction | undefined;
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

/** The mockup pairs a primary button with a quiet "Show full log" link on
 * every non-calm failure state — this is that shared secondary. */
const showFullLog = () => revealAction('Show full log');

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
// never misclassifies as expired-login. The capture group doubles as the
// failed-URL count for the secondary action's label.
const EXPIRED_LOGIN_PATTERN = /all (\d+) attempted url\(s\) failed this run/;

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

/**
 * `'degraded'` — fix-round finding #2: `RunDetailView` renders this panel
 * for every `classifyOutcome` kind in `{failed, crashed, degraded, empty}`
 * (`RunDetailView.tsx`'s `DIAGNOSIS_KINDS`), but until this entry the
 * registry had NO entry that could ever match a `'degraded'` run — every
 * class above reads `errorText(run)`, which is `''` for a `status:
 * 'passed'` run, so a degraded run always fell through to the generic
 * `'fallback'` verdict and rendered "Failed at `unknown stage`" with a
 * destructive-red tint, even though its recorded `status` is `'passed'`.
 * Ordered LAST in the registry (after `'breaker-open'`/`'chrome-not-
 * found'`, both of which are themselves "ordered after zero-yield-
 * healthy" too): a degraded run caused specifically by an open throttle
 * breaker still gets `'breaker-open'`'s more specific copy — this generic
 * entry only catches degraded outcomes with no more specific class (a
 * missing-stage count or a high soft-error rate with no breaker
 * involved), never pre-empting a more specific match. */
function degradedTitle(run: RunDetail, softErrors: SoftErrorSummary | undefined): string {
  const stageCount = getFunnelStages(run.result)?.length ?? 0;
  if (stageCount < TOTAL_PIPELINE_STAGES) {
    return `Ran with warnings — only ${stageCount} of ${TOTAL_PIPELINE_STAGES} pipeline stages recorded.`;
  }
  const total = softErrors?.total ?? 0;
  return `Ran with warnings — ${total} soft error${total === 1 ? '' : 's'} logged this run.`;
}

// ---- the registry, in the exact plan.md order --------------------------
const REGISTRY: DiagnosisEntry[] = [
  {
    kind: 'stall',
    matches: ({ run }) => errorText(run).includes(STALL_SUBSTRING),
    title: ({ run }) => {
      const stage = getFailedStage(run.failure) ?? 'a';
      const minutes = stallMinutes(errorText(run));
      return minutes !== undefined
        ? `The \`${stage}\` stage stopped reporting progress for ${minutes} minute(s).`
        : `The \`${stage}\` stage stopped reporting progress.`;
    },
    action: () => runAction('Run again'),
    secondaryAction: showFullLog,
  },
  {
    kind: 'total-outage',
    matches: ({ run }) => errorText(run).includes(TOTAL_OUTAGE_SUBSTRING),
    title: ({ run }) => {
      const stage = getFailedStage(run.failure) ?? 'a';
      return (
        `Every attempted lane in the \`${stage}\` stage failed this run — ` +
        'this looks like an expired login or a broader outage.'
      );
    },
    action: () => runAction('Run again'),
    secondaryAction: showFullLog,
  },
  {
    kind: 'expired-login',
    matches: ({ run }) =>
      getFailedStage(run.failure) === 'source' &&
      EXPIRED_LOGIN_PATTERN.test(errorText(run)),
    title: () => 'LinkedIn login has expired.',
    action: () => runAction('Run again'),
    secondaryAction: ({ run }) => {
      const match = EXPIRED_LOGIN_PATTERN.exec(errorText(run));
      const count = match?.[1];
      return count
        ? revealAction(`Show the ${count} failed URLs`)
        : revealAction('Show full log');
    },
  },
  {
    kind: 'zero-yield-healthy',
    matches: ({ run, softErrors }) => classifyOutcome(run, softErrors) === 'empty',
    title: ({ run }) => zeroYieldHealthyTitle(run),
    action: () =>
      navigateAction('Review filter rules →', {
        name: 'settings',
        section: 'roles-companies',
      }),
  },
  {
    kind: 'breaker-open',
    // First-class flag (fix-round finding #3), never a `group.sample`
    // substring match — see `SoftErrorSummary.breakerOpen`'s own doc
    // comment (`app/features/runs/soft_errors.ts`) for why that used to be
    // unreliable.
    matches: ({ softErrors }) => softErrors?.breakerOpen ?? false,
    title: () => 'LinkedIn is soft-blocking us — the throttle breaker is open.',
    action: ({ events }) =>
      runAction('Run again', { disabled: true, retryAt: readBreakerRetryAt(events) }),
    secondaryAction: showFullLog,
  },
  {
    kind: 'chrome-not-found',
    matches: ({ run }) => errorText(run).includes(CHROME_NOT_FOUND_SUBSTRING),
    title: () => "Chrome wasn't found at any known path.",
    action: ({ profile }) =>
      copyAction(
        `Copy: jobbunny doctor --profile ${profile}`,
        `jobbunny doctor --profile ${profile}`,
      ),
    secondaryAction: showFullLog,
  },
  {
    kind: 'degraded',
    matches: ({ run, softErrors }) => classifyOutcome(run, softErrors) === 'degraded',
    title: ({ run, softErrors }) => degradedTitle(run, softErrors),
    action: () => revealAction('Review run events'),
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
  input: DiagnosisInput,
): DiagnosisVerdict | null {
  for (const entry of entries) {
    if (entry.matches(input)) {
      return {
        kind: entry.kind,
        title: entry.title(input),
        action: entry.action(input),
        secondaryAction: entry.secondaryAction?.(input),
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
export function classifyFailure(input: DiagnosisInput): DiagnosisVerdict {
  const matched = runRegistry(REGISTRY, input);
  if (matched) return matched;

  return {
    kind: 'fallback',
    title: `Failed at \`${getFailedStage(input.run.failure) ?? 'unknown stage'}\``,
    action: runAction('Run again'),
    secondaryAction: showFullLog(),
    rawError: getFailureError(input.run.failure) ?? '',
    lastCheckpoint: getFailureLastCheckpoint(input.run.failure),
  };
}
