import { Progress } from '../../components/ui/progress';
import type { RunSummary } from '../../lib/api/types';
import { heartbeatFreshness, stageProgressFrom } from './runProgress';

const HEARTBEAT_LABEL: Record<'fresh' | 'stale' | 'unknown', string> = {
  fresh: 'Alive',
  stale: 'No heartbeat for over 10 minutes',
  unknown: 'No heartbeat yet',
};

/** Elapsed time from `startedAt` to `now` — no `setInterval`: the parent
 * `RunsPage`'s own runs-list poll (LIVE_POLL_MS, active while a run is
 * running) re-renders this component on that cadence, which is what keeps
 * this honest without a second timer here. */
function formatElapsed(startedAt: string, now: number): string {
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return '—';
  const totalSeconds = Math.max(0, Math.round((now - startedMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Live header for the currently-running run (spec §3.6, §2.5). Reads
 * progress straight off the passed-in `run` (R3's precomputed
 * `run.progress`) — no more events polling to re-derive it. */
export function LiveRunHeader({ run }: { profile: string; run: RunSummary }) {
  const progress = stageProgressFrom(run);
  const now = Date.now();
  const percent = progress ? (progress.stageIndex / progress.stageTotal) * 100 : 0;
  const heartbeat = heartbeatFreshness(run, now);

  return (
    <div
      data-testid="live-run-header"
      className="flex flex-col gap-2 border-b border-border bg-muted/30 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span data-testid="live-run-stage" className="text-sm font-medium">
          {progress
            ? `Running — ${progress.stage} ${progress.stageIndex}/${progress.stageTotal}`
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
