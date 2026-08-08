import { Badge } from '../../components/ui/badge';
import type { BoardJobRow } from '../../lib/api/types';
import { cn } from '../../lib/utils';

/** Shared by the triage detail pane (T6) and the full-page job view (T10). */
export function JobHeader({ job }: { job: BoardJobRow }) {
  return (
    <div className={cn('flex flex-col gap-1', job.archived && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold font-heading leading-tight">
            {job.title}
          </h1>
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground hover:underline"
          >
            {job.company}
          </a>
        </div>
        {job.score != null && <Badge variant="secondary">{job.score}</Badge>}
      </div>
      <div className="text-xs text-muted-foreground">
        Found {job.dateFound.slice(0, 10)}
        {job.archived && ' · Archived'}
      </div>
    </div>
  );
}
