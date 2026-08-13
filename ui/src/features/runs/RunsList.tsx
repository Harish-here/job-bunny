import {
  Circle,
  CircleAlert,
  CircleCheck,
  DatabaseX,
  type LucideIcon,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import {
  formatInstant,
  formatInstantTitle,
} from '../../../../src/core/datetime/index.ts';
import { Badge } from '../../components/ui/badge';
import type { RunDetail, RunSummary, SoftErrorSummary } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { formatDuration } from './runFormat';
import { classifyOutcome, type OutcomeKind, outcomeLabel } from './runOutcome';
import { STAGE_ORDER } from './runProgress';
import { computeRetention, getFunnelStages } from './runResult';

/** `softErrors` is OPTIONAL here (fix-round finding #4): the real `/runs`
 * list response always attaches it (`RunListRow`, `app/features/runs/
 * routes.ts`), but `RunsPage.tsx`'s hydration into full `RunDetail` rows,
 * plus every existing bare-fixture test in this module, predates that
 * field — making it required would force touching every unrelated
 * fixture. `classifyOutcome`'s second parameter already tolerates
 * `undefined`. */
type Row = (RunSummary | RunDetail) & { softErrors?: SoftErrorSummary };

function isRunDetail(row: Row): row is RunDetail {
  return 'result' in row;
}

interface OutcomeTreatment {
  /** `null` only for `'running'`, which renders a pulsing dot instead of a
   * static lucide icon (ux-notes §1's literal "pulsing dot, primary"). */
  icon: LucideIcon | null;
  iconClassName: string;
  /**
   * Weight-not-hue (ux-notes §1/§11, plan.md B21): the urgent three
   * (`degraded`/`failed`/`crashed`) and `running` are the ONLY kinds with a
   * `border-l-*` class — `running`'s is `border-l-primary`, deliberately a
   * different color family from the urgent three's `border-l-amber` /
   * `border-l-destructive`, so a color-aware assertion can tell them apart
   * without conflating "something is running" with "something is wrong".
   * `produced`/`empty` stay a plain bordered card (no accent); `unrecorded`
   * gets its own dashed-outline-card treatment (no left accent at all).
   */
  cardClassName: string;
}

const TOTAL_STAGES = STAGE_ORDER.length;

const TREATMENT: Record<OutcomeKind, OutcomeTreatment> = {
  produced: {
    icon: CircleCheck,
    iconClassName: 'text-success-strong',
    cardClassName: 'border border-border',
  },
  empty: {
    icon: Circle,
    iconClassName: 'text-muted-foreground',
    cardClassName: 'border border-border',
  },
  degraded: {
    icon: CircleAlert,
    iconClassName: 'text-amber',
    cardClassName: 'border-l-2 border-l-amber',
  },
  failed: {
    icon: TriangleAlert,
    iconClassName: 'text-destructive',
    cardClassName: 'border-l-[3px] border-l-destructive bg-destructive/8',
  },
  crashed: {
    icon: Unplug,
    iconClassName: 'text-destructive',
    cardClassName: 'border-l-[3px] border-dashed border-l-destructive bg-destructive/8',
  },
  running: {
    icon: null,
    iconClassName: 'bg-primary',
    cardClassName: 'border-l-2 border-l-primary bg-primary/5',
  },
  unrecorded: {
    icon: DatabaseX,
    iconClassName: 'text-muted-foreground',
    cardClassName: 'border border-dashed border-border',
  },
};

/** Number-slot content (ux-notes §1). `produced`/`empty`/`degraded` all
 * read the last funnel stage's `jobsOut` (0 for the latter two, by
 * construction of `classifyOutcome`) at full foreground weight — the
 * calm-zero contrast rule is "fewer elements, never fainter text", so this
 * never applies a muted class to the number itself. `failed`/`crashed`/
 * `unrecorded` show `—`, never a literal `0` that would misread as a
 * zero-yield run. `running` shows the live stage count. */
function outcomeNumber(kind: OutcomeKind, row: Row): string {
  switch (kind) {
    case 'produced':
    case 'empty':
    case 'degraded': {
      const stages = isRunDetail(row) ? getFunnelStages(row.result) : null;
      const last = stages && stages.length > 0 ? stages[stages.length - 1] : undefined;
      return String(last?.jobsOut ?? 0);
    }
    case 'failed':
    case 'crashed':
    case 'unrecorded':
      return '—';
    case 'running': {
      const progress = row.progress;
      return progress ? `${progress.stageIndex}/${progress.stageTotal}` : '—';
    }
    default:
      return kind satisfies never;
  }
}

/**
 * The calm-empty row's muted health sentence (ux-notes §1: "Ran clean ·
 * 10/10 stages · 214 scraped, 0 passed filter"). Built from
 * `computeRetention`, which excludes `farm` (and `reconcile`) from its
 * start/end counts by name (`runResult.ts`) — `farm`'s funnel always
 * reports `jobsIn: 0` (CLAUDE.md "Known limitations": additive stage, not a
 * real yield signal), so reading the scraped count from the first
 * *retention-eligible* stage instead of blindly from `stages[0]` is what
 * keeps this subline from ever rendering that misleading literal `0`. */
function emptySubline(row: Row): string | null {
  if (!isRunDetail(row)) return null;
  const stages = getFunnelStages(row.result);
  if (!stages || stages.length === 0) return null;
  const { startCount, endCount } = computeRetention(stages);
  return `${stages.length}/${TOTAL_STAGES} stages · ${startCount} scraped, ${endCount} passed filter`;
}

/** The `'degraded'` row's soft-error-count subline (exact copy: `{n} soft
 * errors`, singular `1 soft error`). `row.softErrors` is the same
 * health-gate input `classifyOutcome` already read to reach `'degraded'` in
 * the first place (commit ed47bb4's row hydration) — `undefined` here means
 * "not yet loaded", not "zero", so this renders no subline rather than a
 * placeholder count. */
function degradedSubline(row: Row): string | null {
  const total = row.softErrors?.total;
  if (total === undefined) return null;
  return `${total} soft error${total === 1 ? '' : 's'}`;
}

function RunningDot() {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full bg-primary animate-pulse"
    />
  );
}

export function RunsList({
  rows,
  selectedId,
  onSelect,
  insertAfterId = null,
  insertContent = null,
}: {
  rows: Row[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /**
   * BUG 3 (pipeline-stability-hardening QA round 2, 2026-08-14) — threading
   * choice: rather than splitting `rows` at `RunsPage` and rendering two
   * separate `<RunsList/>` instances (doubling the `role="listbox"`
   * container and the "no runs recorded" empty-state special case, for a
   * feature that only ever inserts ONE thing after ONE row), `RunsList`
   * itself accepts an insertion-point slot: `insertContent` renders
   * directly after the row whose `id === insertAfterId`, inside this same
   * listbox. `RunsPage` passes the catch-up row's own id (never assumes
   * "the first row" positionally) — matches the mockup's S1 order
   * (day reassurance -> catch-up row -> deferred group -> older runs)
   * exactly, and degrades safely to "no match, nothing inserted" if the
   * id is ever absent from `rows`.
   */
  insertAfterId?: number | null;
  insertContent?: ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div data-testid="runs-empty" className="p-4 text-sm text-muted-foreground">
        No runs recorded yet — this profile hasn't completed a pipeline run.
      </div>
    );
  }

  const now = new Date();

  return (
    <div role="listbox" aria-label="Runs">
      {rows.map((row) => {
        const kind = classifyOutcome(row, row.softErrors);
        const treatment = TREATMENT[kind];
        const Icon = treatment.icon;
        const selected = row.id === selectedId;
        const label = outcomeLabel(kind, row);
        const number = outcomeNumber(kind, row);
        const subline =
          row.catchupSlots != null
            ? `Stood in for ${row.catchupSlots.length} slot${row.catchupSlots.length === 1 ? '' : 's'}`
            : kind === 'empty'
              ? emptySubline(row)
              : kind === 'degraded'
                ? degradedSubline(row)
                : null;

        return (
          <Fragment key={row.id}>
            <div
              role="option"
              tabIndex={0}
              aria-selected={selected}
              data-testid="run-row"
              data-run-id={row.id}
              data-outcome-kind={kind}
              {...(row.catchupSlots != null ? { 'data-qa': 'run-row-catchup' } : {})}
              onClick={() => onSelect(row.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(row.id);
                }
              }}
              className={cn(
                'flex cursor-pointer flex-col gap-1 rounded-lg bg-card px-3 py-2 hop',
                treatment.cardClassName,
                selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {Icon ? (
                    <Icon
                      aria-hidden="true"
                      strokeWidth={kind === 'empty' ? 1.5 : undefined}
                      className={cn('size-4 shrink-0', treatment.iconClassName)}
                    />
                  ) : (
                    <RunningDot />
                  )}
                  <span
                    className="text-sm font-medium"
                    title={formatInstantTitle(row.startedAt, now)}
                  >
                    {formatInstant(row.startedAt, now)}
                  </span>
                </div>
                <span data-testid="run-row-number" className="text-2xl font-heading">
                  {number}
                </span>
              </div>
              <div
                data-testid="run-row-label"
                className="flex items-baseline gap-2 flex-wrap text-sm font-medium"
              >
                {label}
                {row.catchupSlots != null && (
                  <Badge
                    variant="outline"
                    className="border-transparent bg-accent text-primary"
                  >
                    Catch-up
                  </Badge>
                )}
              </div>
              {subline !== null && (
                <div
                  data-testid="run-row-subline"
                  className="text-xs text-muted-foreground"
                >
                  {subline}
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="capitalize">{row.kind}</span>
                <span>·</span>
                <span>{formatDuration(row.startedAt, row.finishedAt)}</span>
              </div>
            </div>
            {insertAfterId === row.id && insertContent}
          </Fragment>
        );
      })}
    </div>
  );
}
