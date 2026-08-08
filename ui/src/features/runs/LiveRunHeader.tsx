import { Progress } from '../../components/ui/progress';
import type { RunSummary } from '../../lib/api/types';
import { heartbeatFreshness, parseStageProgress } from './runProgress';
import { useRunEvents } from './useRunsData';

const EVENTS_POLL_MS = 2500;

const HEARTBEAT_LABEL: Record<'fresh' | 'stale' | 'unknown', string> = {
  fresh: 'Alive',
  stale: 'No heartbeat for over 10 minutes',
  unknown: 'No heartbeat yet',
};

/** Elapsed time from `startedAt` to `now` — no `setInterval`: this
 * component's own 2.5s events poll (below) re-renders it on that cadence,
 * which is what keeps this honest without a second timer. */
function formatElapsed(startedAt: string, now: number): string {
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return '—';
  const totalSeconds = Math.max(0, Math.round((now - startedMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Live header for the currently-running run (spec §3.6, §2.5). Polls its
 * own events at EVENTS_POLL_MS — deliberately independent of the detail
 * pane's SELECTED run, which is very often a different run than the one
 * currently in flight. */
export function LiveRunHeader({ profile, run }: { profile: string; run: RunSummary }) {
  const eventsQuery = useRunEvents(profile, run.id, EVENTS_POLL_MS);
  const events = eventsQuery.data?.rows ?? [];
  const progress = parseStageProgress(events);
  const now = Date.now();
  const percent = progress ? (progress.index / progress.total) * 100 : 0;
  const heartbeat = heartbeatFreshness(run, now);

  return (
    <div
      data-testid="live-run-header"
      className="flex flex-col gap-2 border-b border-border bg-muted/30 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span data-testid="live-run-stage" className="text-sm font-medium">
          {progress
            ? `Running — ${progress.stage} ${progress.index}/${progress.total}`
            : 'Running — starting…'}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatElapsed(run.startedAt, now)}
        </span>
      </div>
      <Progress value={percent} />
      <span data-testid="live-run-heartbeat" className="text-xs text-muted-foreground">
        {HEARTBEAT_LABEL[heartbeat]}
      </span>
    </div>
  );
}
