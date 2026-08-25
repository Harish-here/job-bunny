import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { ApiError } from '../../lib/api/client';
import { navigate } from '../../lib/router';
import { rememberSelection } from '../../lib/selection-memo';
import { useJob } from '../board/useBoardData';
import { EligibilityGrid } from './EligibilityGrid';
import { JdText } from './JdText';
import { JobHeader } from './JobHeader';
import { JobSignals } from './JobSignals';
import { SkillsList } from './SkillsList';
import { TrackingPanel } from './TrackingPanel';

const SKELETON_LINE_KEYS = ['s1', 's2', 's3'];

/** Back navigation: remembers the current job (so triage/tracker can
 * restore selection) then prefers browser history over a hard reroute —
 * only falling back to the triage route when there's nowhere to go back
 * to (e.g. the job page was opened directly). */
function goBack(id: string): void {
  rememberSelection(id);
  if (history.length > 1) {
    history.back();
  } else {
    navigate({ name: 'triage' });
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'not_found';
}

/** Full-page job detail (T10) — the same shared components as the triage
 * detail pane (T6/T8), laid out two-column: JD prose on the left, signals +
 * eligibility + skills + tracking form on the right. */
export function JobPage({ profile, id }: { profile: string; id: string }) {
  const jobQuery = useJob(profile, id);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="hop"
          onClick={() => goBack(id)}
        >
          <ArrowLeft className="size-4" /> Back
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {jobQuery.isPending ? (
          <div className="flex flex-col gap-3">
            {SKELETON_LINE_KEYS.map((key) => (
              <Skeleton key={key} className="h-6 w-2/3" />
            ))}
          </div>
        ) : isNotFound(jobQuery.error) ? (
          <div className="text-muted-foreground">Job not found.</div>
        ) : jobQuery.isError ? (
          <div className="text-muted-foreground">Couldn't load this job.</div>
        ) : (
          <div className="grid grid-cols-[1fr_360px] gap-6">
            <div className="flex w-full max-w-[72ch] flex-col gap-4">
              <JobHeader job={jobQuery.data} />
              <JdText
                jd={jobQuery.data.jd}
                url={jobQuery.data.url}
                expanded={expanded}
                onToggleExpanded={() => setExpanded((v) => !v)}
              />
            </div>
            <div className="flex flex-col gap-4">
              <JobSignals
                matchReasons={jobQuery.data.matchReasons}
                reviewFlags={jobQuery.data.reviewFlags}
              />
              <EligibilityGrid
                locationCity={jobQuery.data.locationCity}
                workType={jobQuery.data.workType}
                seniority={jobQuery.data.seniority}
                timezone={jobQuery.data.timezone}
              />
              <SkillsList skills={jobQuery.data.skills} />
              <TrackingPanel profile={profile} job={jobQuery.data} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
