import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { BoardJobRow } from '../../lib/api/types';
import type { DecideAction } from './decide';

/** The triage detail pane's decide-and-advance controls (T7). Shows the
 * current status as a `Badge` once the job has been decided — the buttons
 * stay available so a decision can still be changed. */
export function DecideBar({
  job,
  onDecide,
}: {
  job: BoardJobRow;
  onDecide: (action: DecideAction) => void;
}) {
  const status = job.tracking?.status ?? null;
  return (
    <div className="flex items-center gap-2">
      <Button type="button" onClick={() => onDecide('apply')}>
        ✓ Apply (a)
      </Button>
      <Button type="button" variant="destructive" onClick={() => onDecide('skip')}>
        ✗ Skip (x)
      </Button>
      <Button type="button" variant="secondary" onClick={() => onDecide('save')}>
        ☆ Save (s)
      </Button>
      {status && <Badge variant="outline">{status}</Badge>}
    </div>
  );
}
