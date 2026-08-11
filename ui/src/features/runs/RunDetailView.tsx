import { DatabaseX } from 'lucide-react';
import { useState } from 'react';
import {
  formatInstant,
  formatInstantTitle,
} from '../../../../src/core/datetime/index.ts';
import { Badge } from '../../components/ui/badge';
import type { RunDetail, RunEventRow, SoftErrorSummary } from '../../lib/api/types';
import { DiagnosisPanel } from './detail/DiagnosisPanel';
import { EvidenceSection } from './detail/EvidenceSection';
import { FunnelTable } from './detail/FunnelTable';
import { StageRail, type StageRailStage } from './detail/StageRail';
import { classifyFailure } from './runDiagnosis';
import { formatDuration, statusLabel, statusVariant } from './runFormat';
import { classifyOutcome, type OutcomeKind, outcomeLabel } from './runOutcome';
import { STAGE_ORDER } from './runProgress';
import {
  getFailedStage,
  getFailureError,
  getFunnelStages,
  newMatchCount,
} from './runResult';

/** ux-notes.md §7's exact copy — kept verbatim, including the illustrative
 * `--profile harish` example (a fixed UI string, not an actual invocation
 * against any real profile). */
const UNRECORDED_COPY =
  "This run's telemetry was never written. The run itself may have succeeded — the board cannot tell. Check ";

/** Fallback passed to `EvidenceSection` (whose `summary` prop is required)
 * when the caller hasn't yet resolved a `SoftErrorSummary` for this run —
 * reads as "no soft errors recorded" rather than a loading gap. */
const EMPTY_SOFT_ERRORS: SoftErrorSummary = { total: 0, groups: [], breakerOpen: false };

/** The four outcome kinds `DiagnosisPanel` renders for (plan.md B20 step 4:
 * "only when kind is one of failed/crashed/degraded/empty (never for
 * produced)") — an explicit allowlist rather than a `!== 'produced'`
 * exclusion, since `'running'`/`'unrecorded'` must also stay excluded. */
const DIAGNOSIS_KINDS: ReadonlySet<OutcomeKind> = new Set([
  'failed',
  'crashed',
  'degraded',
  'empty',
]);

/** Builds the 10-segment `StageRail` input from a `RunDetail`: a recorded
 * funnel stage is `'done'` (or `'failed'` when it's the stage the run
 * failed at), everything else is `'pending'` (or `'failed'` when it's the
 * failed stage itself, absent from the funnel because it never completed).
 * No `'current'` segment — that state only applies to a still-`running`
 * run, out of this composer's fixture scope (AC12 covers
 * failing/crashed/produced/empty/unrecorded only). */
function buildStageRailStages(
  run: RunDetail,
  failedStage: string | null,
): StageRailStage[] {
  const stages = getFunnelStages(run.result);
  const byName = new Map((stages ?? []).map((s) => [s.name, s] as const));
  return STAGE_ORDER.map((name) => {
    const stage = byName.get(name);
    const failed = name === failedStage;
    if (stage) {
      return { name, state: failed ? 'failed' : 'done', elapsedMs: stage.elapsedMs };
    }
    return { name, state: failed ? 'failed' : 'pending', elapsedMs: null };
  });
}

/** ux-notes.md §7 — the S7 "Telemetry missing" card, now a live path per
 * plan.md's A6 amendment (a real DB row: `status === 'crashed'` with both
 * `result_json`/`failure_json` NULL). Dashed outline, `database-off`-style
 * icon (closest available in this repo's pinned `lucide-react`:
 * `DatabaseX`), number slot `—` (never `0`), exact copy from ux-notes §7. */
function UnrecordedCard() {
  return (
    <div
      data-testid="rundetail-unrecorded-card"
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-8 text-center"
    >
      <DatabaseX className="size-8 text-muted-foreground" aria-hidden="true" />
      <span className="font-heading text-2xl text-muted-foreground" aria-hidden="true">
        —
      </span>
      <p className="text-sm font-medium">Telemetry missing</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {UNRECORDED_COPY}
        <code className="font-mono">jobbunny runs --profile harish</code> or the daemon
        log.
      </p>
    </div>
  );
}

/** The kinds whose headline is the "Failed at stage: …" banner (test-pinned
 * verbatim at `RunDetailView.test.tsx:217-226`) rather than the yield
 * sentence — always exactly `'failed'`/`'crashed'` since only those two
 * kinds have `failedStage != null` (blueprint §6, "KEEP the existing
 * headline behavior exactly"). */
const FAILED_HEADLINE_KINDS: ReadonlySet<OutcomeKind> = new Set(['failed', 'crashed']);

/**
 * Outcome-driven headline (blueprint §6, "yield sentence at text-2xl";
 * ux-notes §1's Number-slot/Label columns). `produced`/`empty`/`degraded`
 * render the same yield number the list row shows (`newMatchCount`, the
 * last funnel stage's `jobsOut`) beside its `outcomeLabel` — the exact same
 * label copy `RunsList.tsx` uses, shared via `runOutcome.ts` so the two
 * never drift into duplicate strings. `failed`/`crashed` keep the pinned
 * "Failed at stage: …" text unchanged. The timestamp/status/duration/kind
 * that used to be the headline move into a right-aligned meta cluster.
 */
function OutcomeHeader({
  run,
  kind,
  failedStage,
  failureError,
}: {
  run: RunDetail;
  kind: OutcomeKind;
  failedStage: string | null;
  failureError: string | null;
}) {
  const now = new Date();
  const isFailedHeadline = FAILED_HEADLINE_KINDS.has(kind);
  return (
    <div
      data-testid="rundetail-outcome-header"
      className="flex flex-wrap items-start justify-between gap-3"
    >
      {isFailedHeadline ? (
        <div className="text-sm text-destructive">
          Failed at stage: {failedStage}
          {failureError != null && ` — ${failureError}`}
        </div>
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="font-heading text-2xl">{newMatchCount(run.result)}</span>
          <span className="text-sm text-muted-foreground">{outcomeLabel(kind, run)}</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Badge variant={statusVariant(run.status)}>{statusLabel(run.status)}</Badge>
        <span>·</span>
        <span>{formatDuration(run.startedAt, run.finishedAt)}</span>
        <span>·</span>
        <span className="capitalize">{run.kind}</span>
        {run.resumedFrom != null && (
          <>
            <span>·</span>
            <span>resumed from run #{run.resumedFrom}</span>
          </>
        )}
        <span>·</span>
        <span title={formatInstantTitle(run.startedAt, now)}>
          {formatInstant(run.startedAt, now)}
        </span>
      </div>
    </div>
  );
}

/**
 * B20 (plan.md) — the fixed 5-panel composer (blueprint §6's S3–S7
 * pseudocode): outcome header → diagnosis (conditional) → stage rail →
 * funnel table → evidence, in that DOM order, for every non-`'unrecorded'`
 * outcome kind. `kind === 'unrecorded'` short-circuits to the dashed S7
 * card ALONE — no outcome header, no other panel — per A6's live-path
 * amendment: "the absence is the disclosure."
 */
export function RunDetailView({
  run,
  events,
  softErrors,
  profile,
  onRun,
}: {
  run: RunDetail;
  events: RunEventRow[];
  softErrors: SoftErrorSummary | undefined;
  profile: string;
  onRun: () => void;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const kind = classifyOutcome(run, softErrors);

  if (kind === 'unrecorded') {
    return <UnrecordedCard />;
  }

  const failedStage = getFailedStage(run.failure);
  const failureError = getFailureError(run.failure);
  const funnelStages = getFunnelStages(run.result);
  const railStages = buildStageRailStages(run, failedStage);

  return (
    <div className="flex flex-col">
      {/* Evidence's mt-3 (below) must NOT compound with this stack's own
       * gap-6 — see the SPACING note on `rundetail-evidence-section`. */}
      <div className="flex flex-col gap-6">
        <OutcomeHeader
          run={run}
          kind={kind}
          failedStage={failedStage}
          failureError={failureError}
        />

        {DIAGNOSIS_KINDS.has(kind) && (
          <div data-testid="rundetail-diagnosis-panel">
            <DiagnosisPanel
              verdict={classifyFailure({ run, softErrors, events, profile })}
              onRun={onRun}
              onReveal={() => setEvidenceOpen(true)}
            />
          </div>
        )}

        <div data-testid="rundetail-stage-rail">
          <StageRail variant="detail" stages={railStages} failedStage={failedStage} />
        </div>

        <div data-testid="rundetail-funnel-table">
          <div className="mb-2 text-sm font-medium">Funnel</div>
          <FunnelTable stages={funnelStages} failedStage={failedStage} />
        </div>
      </div>

      {/* Mockup's `.disclosure{margin-top:12px}` — kept OUT of the gap-6
       * stack above so this margin doesn't compound with the flex gap. */}
      <div data-testid="rundetail-evidence-section" className="mt-3">
        <EvidenceSection
          summary={softErrors ?? EMPTY_SOFT_ERRORS}
          events={events}
          open={evidenceOpen}
          onOpenChange={setEvidenceOpen}
        />
      </div>
    </div>
  );
}
