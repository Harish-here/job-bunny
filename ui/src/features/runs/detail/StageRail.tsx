import { cn } from '@/lib/utils';

/** Exactly four segment states — a TypeScript-level guarantee. Per plan.md's
 * B16 override of ux-notes §4 (which describes a fifth `skipped` state), a
 * `skipped` segment is deliberately unrepresentable: `RunResult.stages` never
 * legitimately reports a stage as "skipped" as a unit (blueprint §9), so
 * there is no runtime branch to add for it. */
export type StageState = 'done' | 'current' | 'pending' | 'failed';

export interface StageRailStage {
  name: string;
  state: StageState;
  /** Wall-clock time spent in this stage so far, or `null` when it hasn't
   * started (pending) or hasn't produced a duration yet (current, mid-run). */
  elapsedMs: number | null;
}

export interface StageRailProps {
  /** All 10 stages, in `STAGE_ORDER` order — one entry per pipeline stage. */
  stages: StageRailStage[];
  /** The stage the run failed at, or `null` for a run that hasn't failed. */
  failedStage: string | null;
  /** The stage currently running, or `null`/`undefined` when nothing is
   * (the run finished, or hasn't started). Only meaningful in `variant="detail"`. */
  currentStage?: string | null;
  variant: 'detail' | 'strip';
}

const GROUPS: { label: string; size: number }[] = [
  { label: 'acquire', size: 3 },
  { label: 'understand', size: 3 },
  { label: 'decide', size: 4 },
];

/** Duration convention: `—` when no elapsed time is known yet (pending, or a
 * current/failed stage whose caller has none to report) — matches
 * `runFormat.ts`'s `formatDuration`'s existing `—` convention for the same
 * "nothing to show yet" case, applied here to a raw ms value instead of a
 * start/finish ISO pair. */
function formatElapsed(ms: number | null): string {
  if (ms === null) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function segmentClasses(state: StageState): string {
  switch (state) {
    case 'done':
      return 'bg-muted-foreground/40';
    case 'current':
      return 'bg-primary animate-pulse';
    case 'pending':
      return 'bg-muted border border-border';
    case 'failed':
      return 'bg-destructive';
    default:
      return state satisfies never;
  }
}

function segmentLabel(stage: StageRailStage, index: number, total: number): string {
  return `stage ${index + 1} of ${total}, ${stage.name}, ${stage.state}, ${formatElapsed(stage.elapsedMs)}`;
}

/** Which stage the "text partner" sentence and the strip's summary
 * `aria-label` describe: the failed stage if the run has failed, else the
 * currently running stage, else (a finished-clean run) the last stage. */
function focusStage(
  stages: StageRailStage[],
  failedStage: string | null,
  currentStage: string | null | undefined,
): { name: string; position: number } | null {
  const focusName =
    failedStage ?? currentStage ?? stages[stages.length - 1]?.name ?? null;
  if (focusName === null) return null;
  const index = stages.findIndex((s) => s.name === focusName);
  return { name: focusName, position: index === -1 ? stages.length : index + 1 };
}

function groupStages(
  stages: StageRailStage[],
): { label: string; stages: StageRailStage[] }[] {
  const groups: { label: string; stages: StageRailStage[] }[] = [];
  let offset = 0;
  for (const group of GROUPS) {
    groups.push({
      label: group.label,
      stages: stages.slice(offset, offset + group.size),
    });
    offset += group.size;
  }
  return groups;
}

function DetailRail({ stages, failedStage, currentStage }: StageRailProps) {
  const total = stages.length;
  const groups = groupStages(stages);
  const focus = focusStage(stages, failedStage, currentStage);

  let indexOffset = 0;
  return (
    <div className="flex flex-col gap-1">
      <ol data-testid="stage-rail" className="flex items-end gap-3">
        {groups.map((group) => {
          const startIndex = indexOffset;
          indexOffset += group.stages.length;
          return (
            <li
              key={group.label}
              data-testid="stage-rail-group"
              className="flex flex-1 flex-col gap-1"
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {group.label}
              </span>
              <div className="flex gap-1">
                {group.stages.map((stage, i) => {
                  const index = startIndex + i;
                  return (
                    <button
                      key={stage.name}
                      type="button"
                      className={cn(
                        'h-1.5 flex-1 rounded-full',
                        segmentClasses(stage.state),
                      )}
                      aria-label={segmentLabel(stage, index, total)}
                      aria-current={stage.state === 'current' ? 'step' : undefined}
                    />
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
      {focus !== null && (
        <p
          data-testid="stage-rail-text-partner"
          className="text-xs text-muted-foreground"
        >
          stage {focus.position} of {total} — {focus.name}
        </p>
      )}
    </div>
  );
}

function StripRail({ stages, failedStage, currentStage }: StageRailProps) {
  const total = stages.length;
  const focus = focusStage(stages, failedStage, currentStage ?? null);
  const ariaLabel =
    focus === null
      ? `0 of ${total} stages complete`
      : `stage ${focus.position} of ${total} — ${focus.name}`;

  return (
    <div role="img" aria-label={ariaLabel} className="flex items-center gap-1">
      {stages.map((stage) => (
        <div
          key={stage.name}
          aria-hidden="true"
          className={cn('h-1.5 flex-1 rounded-full', segmentClasses(stage.state))}
        />
      ))}
    </div>
  );
}

/** The pipeline stage rail (ux-notes §4). Ten segments grouped 3/3/4
 * (acquire · understand · decide). `variant="detail"` is an accessible
 * `<ol>` of `<button>`s with group labels and a text-partner sentence;
 * `variant="strip"` is a non-interactive `role="img"` summary for the live
 * header, with no group labels and nothing focusable. */
export function StageRail(props: StageRailProps) {
  return props.variant === 'detail' ? (
    <DetailRail {...props} />
  ) : (
    <StripRail {...props} />
  );
}
