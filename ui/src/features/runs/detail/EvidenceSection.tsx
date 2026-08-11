import { useMemo, useState } from 'react';
import { formatInstantFull } from '../../../../../src/core/datetime/index.ts';
import { Badge } from '../../../components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import type { RunEventRow, SoftErrorSummary } from '../../../lib/api/types';

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
type LevelFilter = (typeof LEVELS)[number];

export interface EvidenceSectionProps {
  summary: SoftErrorSummary;
  events: RunEventRow[];
}

/** Moved verbatim from `RunDetailView.tsx` (B19, plan.md/blueprint §8 step
 * 19) — unchanged body, only relocated. `RunDetailView.tsx` still owns its
 * own copy until Task 15/B20's composition rewrite removes it. */
function EventsList({ events }: { events: RunEventRow[] }) {
  const [level, setLevel] = useState<LevelFilter>('all');
  const filtered = useMemo(
    () => (level === 'all' ? events : events.filter((e) => e.level === level)),
    [events, level],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Events</span>
        <Select value={level} onValueChange={(v) => setLevel(v as LevelFilter)}>
          <SelectTrigger size="sm" aria-label="Filter by level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {l === 'all' ? 'All levels' : l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events match.</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="run-events">
          {filtered.map((event) => (
            <div
              key={`${event.ts}-${event.level}-${event.msg}`}
              data-testid="run-event-row"
              data-level={event.level}
              className="flex items-start gap-2 border-b py-1 text-sm last:border-b-0"
            >
              <span className="w-40 shrink-0 font-mono text-xs text-muted-foreground">
                {formatInstantFull(event.ts)}
              </span>
              <Badge variant="outline" className="shrink-0 uppercase">
                {event.level}
              </Badge>
              <span className="flex-1">{event.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** ux-notes §6 position 5's summary line: a compact one-line rollup of
 * `SoftErrorSummary`, distinct from `DiagnosisPanel.tsx`'s top-three
 * breakdown (§6's evidence clause, position 2) — this line never duplicates
 * that. No literal copy is named by ux-notes/blueprint for this line, so the
 * exact wording is this file's own judgment call: name the total plus the
 * single biggest group's label when there is one soft error to report, or a
 * calm "no soft errors" line when `total` is 0 (never a bare "0" per the
 * repo's "never render a misleading literal 0" convention). */
function summaryLine(summary: SoftErrorSummary): string {
  if (summary.total === 0) {
    return 'No soft errors recorded for this run.';
  }
  const top = summary.groups[0];
  if (top === undefined) {
    return `${summary.total} soft error(s) recorded.`;
  }
  return `${summary.total} soft error(s) recorded — most common: ${top.label} (${top.count}).`;
}

/** B19 (plan.md) — ux-notes §6 position 5, "Evidence": the soft-error
 * summary line plus the existing `EventsList` (moved unchanged, above)
 * behind a disclosure, closed by default (ux-notes §9's Event log row).
 * Trigger is a `<button aria-expanded>` per §11's a11y note, not a bare
 * `<details>` element (the idiom `TrackingPanel.tsx` uses elsewhere in this
 * codebase is deliberately NOT followed here, per this brief's step 2).
 * The trigger label's count is `summary.total` (AC14) — NOT `events.length`,
 * since `events` may include debug/info rows `SoftErrorSummary` excludes. */
export function EvidenceSection({ summary, events }: EvidenceSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <p data-testid="evidence-summary-line" className="text-sm text-muted-foreground">
        {summaryLine(summary)}
      </p>
      <button
        type="button"
        data-testid="evidence-disclosure-trigger"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="self-start text-sm text-primary underline-offset-4 hover:underline"
      >
        {open ? 'Hide full log' : `Show full log (${summary.total} events)`}
      </button>
      {open && <EventsList events={events} />}
    </div>
  );
}
