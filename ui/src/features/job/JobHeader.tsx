import { ExternalLink } from 'lucide-react';
import {
  formatInstant,
  formatInstantTitle,
} from '../../../../src/core/datetime/index.ts';
import type { BoardJobRow } from '../../lib/api/types';
import { laneIcon, laneLabel } from '../../lib/vocabulary';
import { ArchivedStrip } from './ArchivedStrip';
import { MatchScore } from './MatchScore';

/**
 * `ux-notes.md` §5 Zone 1 verdict-header — shared by the triage detail pane
 * (T6) and the full-page job view (T10). Composes `MatchScore` (task 3) and
 * `ArchivedStrip` (task 4) rather than re-implementing either. Padding/
 * border for the eventual pane box belong to `DetailPane` (blueprint steps
 * 19–20, a later task) — this component stays a flat, unwrapped block so it
 * drops straight into both of today's call sites unchanged.
 *
 * QA round 1 bug 7: `ArchivedStrip` renders as a SIBLING before the
 * `verdict-header` div, not nested inside it — blueprint §3 orders the pane
 * "`ArchivedStrip` (conditional) → `JobHeader` (verdict-header…)" and
 * `mockup.html`'s S6 frame places `archived-strip` immediately before
 * `verdict-header` as two sibling elements, never one nested in the other.
 * `ArchivedStrip` still lives INSIDE `JobHeader.tsx` (so both the triage
 * pane and `#/job/:id` get it for free, per blueprint step 14's resolved
 * contradiction) — only its position relative to the header moved.
 */
export function JobHeader({ job }: { job: BoardJobRow }) {
  const now = new Date();
  const LaneIcon = laneIcon(job.lane);
  return (
    <>
      <ArchivedStrip archived={job.archived} />
      <div className="flex flex-col gap-2" data-qa="verdict-header">
        <div className="flex items-start justify-between gap-4">
          <h1 className="line-clamp-2 flex-1 font-heading text-lg font-semibold leading-snug">
            {job.title}
          </h1>
          <MatchScore score={job.score} />
        </div>
        <div
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          data-qa="provenance-line"
        >
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-foreground hover:underline"
          >
            {job.company}
            <ExternalLink className="size-3" />
          </a>
          <span>·</span>
          <span className="flex items-center gap-1" data-qa="lane-label">
            <LaneIcon className="size-3" />
            {laneLabel(job.lane)}
          </span>
          <span>·</span>
          <span className="tabular-nums" title={formatInstantTitle(job.dateFound, now)}>
            Found {formatInstant(job.dateFound, now)}
          </span>
        </div>
      </div>
    </>
  );
}
