import { Badge } from '../../components/ui/badge';
import type { BoardJobRow } from '../../lib/api/types';

/** Structured facts below the header — read-only, including `excitement`
 * (spec correction: excitement is pipeline-owned, never an editable
 * control on the board's tracking-only write surface). */
export function JobFacts({ job }: { job: BoardJobRow }) {
  const locationLine = [job.locationCity, job.workType].filter(Boolean).join(' — ');
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-sm">
      <div className="text-muted-foreground">
        {locationLine || 'Location unknown'}
        {job.timezone && ` · ${job.timezone}`}
        {job.seniority && ` · ${job.seniority}`}
      </div>
      {job.skills.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {job.skills.map((skill) => (
            <Badge key={skill} variant="outline">
              {skill}
            </Badge>
          ))}
        </div>
      )}
      {job.matchReasons.length > 0 && (
        <div>
          <div className="font-medium">Why it matches</div>
          <ul className="list-disc pl-5 text-muted-foreground">
            {job.matchReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {job.reviewFlags.length > 0 && (
        <div>
          <div className="font-medium">Review flags</div>
          <ul className="list-disc pl-5 text-muted-foreground">
            {job.reviewFlags.map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
          </ul>
        </div>
      )}
      {job.excitement && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Excitement</span>
          <Badge variant="secondary">{job.excitement}</Badge>
        </div>
      )}
    </div>
  );
}
