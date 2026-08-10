import { HeartOff, WifiOff } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import type { RunSummary } from '../../lib/api/types';
import { heartbeatFreshness, stageProgressFrom } from './runProgress';

type Liveness = 'alive' | 'stalled' | 'disconnected';

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

function minutesSince(iso: string, now: number): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.round((now - ms) / 60000));
}

function secondsSince(ms: number, now: number): number {
  return Math.max(0, Math.round((now - ms) / 1000));
}

/** `pollError` decides `disconnected` vs. the heartbeat-derived states —
 * "we cannot tell" (disconnected) always outranks a stale-but-cached
 * heartbeat, since a failing poll means we no longer trust anything we're
 * reading off `run` either (ux-notes §9, R11: stalled ≠ disconnected). */
function livenessFor(run: RunSummary, pollError: boolean, now: number): Liveness {
  if (pollError) return 'disconnected';
  return heartbeatFreshness(run, now) === 'fresh' ? 'alive' : 'stalled';
}

export interface LiveRunHeaderProps {
  profile: string;
  run: RunSummary;
  /** True when the parent's runs-list poll — the *only* poll this strip's
   * data rides on (R12: no dedicated events poll of its own) — most
   * recently failed. Drives the `disconnected` liveness state ("we cannot
   * tell"), kept visibly distinct from `stalled` ("we are connected and the
   * run is not beating"). Defaults to `false` (the common case: no caller
   * wired up yet, or the poll is healthy). */
  pollError?: boolean;
  /** Wall-clock ms of the parent poll's last successful fetch, for the
   * "Disconnected — last update Ns ago" copy. `null` only before any
   * successful fetch has ever landed — in practice this strip only mounts
   * once a running row's data already exists, so that's not reachable from
   * `RunsPage`, but the prop stays optional for callers/tests that don't
   * care about the disconnected copy's exact wording. */
  lastUpdatedAt?: number | null;
  /** Wired to the parent poll's own `refetch()` — the strip's `[Retry]`
   * control re-triggers that existing poll, never starts a new one (R12). */
  onRetry?: () => void;
}

/** Live strip for the currently-running run (spec §3.6, §2.5, plan.md B22):
 * reads stage/position straight off the passed-in `run.progress` (R3's
 * precomputed field, via `stageProgressFrom`) — no events polling of its
 * own to re-derive it. Renders one of three liveness states with a distinct
 * icon + text pair each: `alive` (pulsing dot), `stalled` (connected, no
 * heartbeat), `disconnected` (poll itself is failing — "we cannot tell"). */
export function LiveRunHeader({
  run,
  pollError = false,
  lastUpdatedAt = null,
  onRetry,
}: LiveRunHeaderProps) {
  const progress = stageProgressFrom(run);
  const now = Date.now();
  const percent = progress ? (progress.stageIndex / progress.stageTotal) * 100 : 0;
  const liveness = livenessFor(run, pollError, now);

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
      <div data-testid="live-run-heartbeat" className="flex items-center gap-2 text-xs">
        {liveness === 'alive' && (
          <>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-primary animate-pulse"
            />
            <span className="text-muted-foreground">Alive</span>
          </>
        )}
        {liveness === 'stalled' && (
          <>
            <HeartOff aria-hidden className="size-3.5 shrink-0 text-amber" />
            <span className="text-amber">
              {run.heartbeatAt === null
                ? 'No heartbeat yet'
                : `No heartbeat for ${minutesSince(run.heartbeatAt, now)}m`}
            </span>
          </>
        )}
        {liveness === 'disconnected' && (
          <>
            <WifiOff aria-hidden className="size-3.5 shrink-0 text-amber" />
            <span className="text-amber">
              {lastUpdatedAt === null
                ? 'Disconnected — last update unavailable'
                : `Disconnected — last update ${secondsSince(lastUpdatedAt, now)}s ago`}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="live-run-retry"
              onClick={onRetry}
            >
              Retry
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
