import { Check, CircleSlash, Star } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { BoardJobRow } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { TRIAGE_ACTION_LABELS } from '../../lib/vocabulary';
import { DECIDE_STATUS, type DecideAction } from './decide';

/** The triage detail pane's decide-and-advance controls (T7). Shows the
 * current status as a `Badge` once the job has been decided — the buttons
 * stay available so a decision can still be changed. Rewritten per blueprint
 * step 17 (ui-design-system task 6): Apply/Lead/Pass labels via
 * `TRIAGE_ACTION_LABELS` (R11 — no raw jargon like "Skip"/"Save"), `decide-pass`
 * uses `variant="outline"`, never `destructive` (a whole action styled as
 * an error was the collision this closes).
 *
 * QA round 1 bug 5: `mockup.html`'s `.decide-bar` is `justify-content:
 * space-between` with the three buttons as one flex child and the status
 * badge as its sibling, pushing the badge to the far right — the root here
 * needs the same `justify-between` (sticky-bottom classes unchanged). */
export function DecideBar({
  job,
  onDecide,
}: {
  job: BoardJobRow;
  onDecide: (action: DecideAction) => void;
}) {
  const status = job.tracking?.status ?? null;

  const isActive = (action: DecideAction) => status === DECIDE_STATUS[action];

  return (
    <div
      className="sticky bottom-0 z-10 -mx-(--card-spacing) -mb-(--card-spacing) flex items-center justify-between gap-2 border-t bg-card px-4 py-2.5"
      data-qa="decide-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="default"
          data-qa="decide-apply"
          aria-pressed={isActive('apply')}
          className={cn(isActive('apply') && 'bg-accent text-accent-foreground')}
          onClick={() => onDecide('apply')}
        >
          <Check aria-hidden="true" />
          {TRIAGE_ACTION_LABELS.apply}
          <kbd className="text-micro rounded-sm bg-muted px-1">a</kbd>
        </Button>
        <Button
          type="button"
          variant="outline"
          data-qa="decide-lead"
          aria-pressed={isActive('save')}
          className={cn(isActive('save') && 'bg-accent text-accent-foreground')}
          onClick={() => onDecide('save')}
        >
          <Star aria-hidden="true" />
          {TRIAGE_ACTION_LABELS.save}
          <kbd className="text-micro rounded-sm bg-muted px-1">s</kbd>
        </Button>
        <Button
          type="button"
          variant="outline"
          data-qa="decide-pass"
          aria-pressed={isActive('skip')}
          className={cn(isActive('skip') && 'bg-accent text-accent-foreground')}
          onClick={() => onDecide('skip')}
        >
          <CircleSlash aria-hidden="true" />
          {TRIAGE_ACTION_LABELS.skip}
          <kbd className="text-micro rounded-sm bg-muted px-1">x</kbd>
        </Button>
      </div>
      <Badge variant="outline" data-qa="decide-status-badge">
        {job.tracking?.status ?? 'Not decided'}
      </Badge>
    </div>
  );
}
