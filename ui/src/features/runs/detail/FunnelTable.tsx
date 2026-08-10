import { Badge } from '../../../components/ui/badge';
import { STAGE_ORDER } from '../runProgress';
import { computeRetention, type FunnelStage } from '../runResult';

/** ux-notes.md §5, verbatim — asserted against exactly by
 * FunnelTable.test.tsx, so a wording tweak there must land here too. */
const FARM_INFO_TEXT =
  'farm is additive — it discovers companies and adds jobs, so there is no input to measure.';

/** ux-notes.md §5's generalised-rule copy for `reconcile`, a state-sync
 * stage with no meaningful in→out yield (same exception class as `farm`,
 * rendered as `n/a` text rather than an outward bar since reconcile has no
 * growth story). */
const RECONCILE_TEXT = 'n/a · state-sync only';

/** This brief's own judgment-call copy (no exact string named by
 * plan.md/ux-notes.md) for a stage past a run's failure point — consistent
 * with ux-notes §5's generalised "n/a plus a one-word reason, never `0`"
 * rule, applied to the "never ran at all" case. */
const NOT_REACHED_TEXT = 'not reached';

export interface FunnelTableProps {
  /** `getFunnelStages(run.result)` — `null` when the result blob is
   * absent/malformed (nothing recorded at all). A run that failed partway
   * legitimately reports FEWER than 10 entries here; the remaining
   * `STAGE_ORDER` names are synthesized as "not reached" rows below. */
  stages: FunnelStage[] | null;
  /** `getFailedStage(run.failure)` — used only to highlight the row the run
   * stopped at (rows past it render as "not reached" purely because they're
   * absent from `stages`, independent of this prop). */
  failedStage: string | null;
}

function retentionPct(stage: FunnelStage): number {
  if (stage.jobsIn <= 0) return 0;
  return Math.max(0, Math.min(100, (stage.jobsOut / stage.jobsIn) * 100));
}

function DropsCell({ dropsByRule }: { dropsByRule: Record<string, number> }) {
  const entries = Object.entries(dropsByRule);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([rule, count]) => (
        <Badge key={rule} variant="outline">
          {rule}: {count}
        </Badge>
      ))}
    </div>
  );
}

function StageCell({ name, failed }: { name: string; failed: boolean }) {
  return (
    <td className={`py-1.5 pr-2 font-medium ${failed ? 'text-destructive' : ''}`}>
      {name}
    </td>
  );
}

function OrdinaryRow({ stage, failed }: { stage: FunnelStage; failed: boolean }) {
  const pct = retentionPct(stage);
  return (
    <tr className="border-b last:border-b-0">
      <StageCell name={stage.name} failed={failed} />
      <td className="relative py-1.5 pr-2 whitespace-nowrap font-heading text-muted-foreground">
        <div
          data-testid="retention-bar"
          data-bar-direction="inward"
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-primary/15"
          style={{ width: `${pct}%` }}
        />
        <span className="relative">
          {stage.jobsIn} → {stage.jobsOut}
        </span>
      </td>
      <td className="py-1.5">
        <DropsCell dropsByRule={stage.dropsByRule} />
      </td>
    </tr>
  );
}

/** `farm` is additive (R8): `jobsIn` is always `0` but that is never a
 * shrink to render literally — the in-cell reads `—`, the bar renders
 * OUTWARD (growth, not shrink) from the left edge, and an info marker
 * carries the exact accessible explanation (ux-notes §5). */
function FarmRow({ stage, failed }: { stage: FunnelStage; failed: boolean }) {
  return (
    <tr className="border-b last:border-b-0">
      <StageCell name={stage.name} failed={failed} />
      <td className="relative py-1.5 pr-2 whitespace-nowrap font-heading text-muted-foreground">
        <div
          data-testid="retention-bar"
          data-bar-direction="outward"
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-primary/25"
          style={{ width: '100%' }}
        />
        <span className="relative inline-flex items-center gap-1">
          — → {stage.jobsOut}
          <button
            type="button"
            data-testid="funnel-farm-info"
            title={FARM_INFO_TEXT}
            aria-label={FARM_INFO_TEXT}
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted align-super text-[9px] font-normal text-muted-foreground"
          >
            i
          </button>
        </span>
      </td>
      <td className="py-1.5">
        <DropsCell dropsByRule={stage.dropsByRule} />
      </td>
    </tr>
  );
}

/** `reconcile` is a state-sync stage with no meaningful in→out yield — same
 * exception class as `farm`, rendered as `n/a` text with no bar (no growth
 * story, unlike farm) per ux-notes §5's generalised rule. */
function ReconcileRow({ stage, failed }: { stage: FunnelStage; failed: boolean }) {
  return (
    <tr className="border-b last:border-b-0">
      <StageCell name={stage.name} failed={failed} />
      <td className="py-1.5 pr-2 whitespace-nowrap text-muted-foreground">
        {RECONCILE_TEXT}
      </td>
      <td className="py-1.5">
        <DropsCell dropsByRule={stage.dropsByRule} />
      </td>
    </tr>
  );
}

/** A `STAGE_ORDER` entry absent from `stages` — a run that failed partway
 * legitimately reports fewer than 10 recorded stages; every name past that
 * point never ran at all. */
function NotReachedRow({ name, failed }: { name: string; failed: boolean }) {
  return (
    <tr className="border-b text-muted-foreground last:border-b-0">
      <StageCell name={name} failed={failed} />
      <td className="py-1.5 pr-2 whitespace-nowrap">{NOT_REACHED_TEXT}</td>
      <td className="py-1.5">{NOT_REACHED_TEXT}</td>
    </tr>
  );
}

/** The per-run funnel table (ux-notes.md §5, extracted+upgraded from
 * `RunDetailView.tsx`'s former inline `FunnelTable`): a plain table with a
 * Tailwind background-width retention bar (zero new charting dependency),
 * plus explicit `farm`/`reconcile`/`not reached` special-casing so no row
 * ever renders a misleading literal `0`. */
export function FunnelTable({ stages, failedStage }: FunnelTableProps) {
  if (stages === null) {
    return <p className="text-sm text-muted-foreground">No funnel recorded.</p>;
  }

  const byName = new Map(stages.map((s) => [s.name, s]));
  const retention = computeRetention(stages);

  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Stage</th>
            <th className="py-1 pr-2 font-medium">Jobs</th>
            <th className="py-1 font-medium">Drops by rule</th>
          </tr>
        </thead>
        <tbody>
          {STAGE_ORDER.map((name) => {
            const failed = name === failedStage;
            const stage = byName.get(name);
            if (stage === undefined) {
              return <NotReachedRow key={name} name={name} failed={failed} />;
            }
            if (name === 'farm')
              return <FarmRow key={name} stage={stage} failed={failed} />;
            if (name === 'reconcile') {
              return <ReconcileRow key={name} stage={stage} failed={failed} />;
            }
            return <OrdinaryRow key={name} stage={stage} failed={failed} />;
          })}
        </tbody>
      </table>
      {stages.length > 0 && (
        <p
          data-testid="funnel-retention-summary"
          className="text-xs text-muted-foreground"
        >
          Retained {Math.round(retention.retainedPct)}% overall ({retention.startCount} →{' '}
          {retention.endCount})
        </p>
      )}
    </div>
  );
}
