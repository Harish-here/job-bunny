import { useMemo, useState } from 'react';
import { formatInstantFull } from '../../../../../src/core/datetime/index.ts';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../../components/ui/accordion';
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

/** The single disclosure's item value — an accordion of type="single" only
 * ever has this one item, so the literal is never surfaced to callers. */
const EVIDENCE_ITEM = 'evidence';

export interface EvidenceSectionProps {
  summary: SoftErrorSummary;
  events: RunEventRow[];
  /** Controlled disclosure state (mockup fix, docs/product/run-experience-
   * overhaul/mockup.html lines ~627-630/735-743) — the parent
   * (`RunDetailView`) owns whether this is open, so a `DiagnosisPanel`
   * "Review run events" action can open it too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Moved verbatim from `RunDetailView.tsx` (B19, plan.md/blueprint §8 step
 * 19) — unchanged body, only relocated. */
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

/** The disclosure trigger's label — the mockup's "Evidence — N soft
 * errors" (docs/product/run-experience-overhaul/mockup.html ~line 628).
 * Keyed off `summary.total`, not `events.length` (AC14): `events` may
 * include debug/info rows `SoftErrorSummary` excludes. */
function triggerLabel(summary: SoftErrorSummary): string {
  return `Evidence — ${summary.total} soft error${summary.total === 1 ? '' : 's'}`;
}

/**
 * B19 (plan.md), amended by the mockup-drift fix: ONE disclosure (the
 * shadcn `Accordion`), controlled by the parent. Its content carries BOTH
 * the soft-error summary line and the full event log (the moved
 * `EventsList`, unchanged) — the shipped drift this fix corrects had the
 * summary line rendered as an always-visible sibling above a second,
 * separately-toggled "Show full log" control; the mockup pairs them inside
 * one disclosure instead.
 */
export function EvidenceSection({
  summary,
  events,
  open,
  onOpenChange,
}: EvidenceSectionProps) {
  return (
    <Accordion
      type="single"
      collapsible
      value={open ? EVIDENCE_ITEM : ''}
      onValueChange={(value) => onOpenChange(value === EVIDENCE_ITEM)}
    >
      <AccordionItem value={EVIDENCE_ITEM}>
        <AccordionTrigger data-testid="evidence-disclosure-trigger">
          {triggerLabel(summary)}
        </AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-2">
            <p
              data-testid="evidence-summary-line"
              className="text-sm text-muted-foreground"
            >
              {summaryLine(summary)}
            </p>
            <EventsList events={events} />
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
