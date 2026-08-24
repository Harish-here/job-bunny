import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { Switch } from '../../components/ui/switch';
import type {
  AutostartOutcome,
  StartDaemonOutcome,
  StopDaemonOutcome,
} from '../../lib/api/types';
import { configDocQuery } from '../settings/config.queries';
import { type DaemonStatusTone, daemonStatusWord } from '../shell/daemonState';
import { daemonQuery } from '../wizard/wizard.queries';
import { scheduleWarning } from './operate.model';
import { worstSeverity } from './severityOrder';
import { useSetAutostart, useStartDaemon, useStopDaemon } from './useDaemonControl';
import { type PauseAllResult, usePauseAll } from './usePauseAll';

const RUN_COMMAND = 'jobbunny serve start';

// `ScheduleSection.tsx`'s (now-removed) inline TONE_WORD_CLASS idiom:
// `success`/`attention` need `-strong` (plain fails 4.5:1 as text);
// `destructive`/`muted` are already fine plain.
const TONE_WORD_CLASS: Record<DaemonStatusTone, string> = {
  success: 'text-success-strong',
  attention: 'text-attention-strong',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};
const TONE_DOT_CLASS: Record<DaemonStatusTone, string> = {
  success: 'bg-success',
  attention: 'bg-attention',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LineTone = 'success' | 'destructive' | 'muted';

const LINE_TONE_CLASS: Record<LineTone, string> = {
  success: 'text-success-strong',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** One distinct, named status line — never a silent re-render. */
function StatusLine({ tone, children }: { tone: LineTone; children: ReactNode }) {
  return <p className={`text-xs ${LINE_TONE_CLASS[tone]}`}>{children}</p>;
}

/** Local duplicate of `HubPage.tsx`'s `readSchedule` — malformed reads as "no schedule". */
function readSchedule(text: string | undefined): { enabled: boolean; times: string[] } {
  if (text === undefined || text.trim() === '') return { enabled: false, times: [] };
  try {
    const parsed = JSON.parse(text) as {
      schedule?: { enabled?: boolean; times?: string[] };
    };
    const schedule = parsed.schedule;
    return {
      enabled: schedule?.enabled === true,
      times: Array.isArray(schedule?.times) ? schedule.times : [],
    };
  } catch {
    return { enabled: false, times: [] };
  }
}

/** `12s ago` / `14m ago` — finer than `core/datetime`'s `formatRelative`. */
function formatAgo(iso: string | null): string {
  if (iso == null) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ago`;
  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ago`;
  const totalDays = Math.round(totalHours / 24);
  return `${totalDays}d ago`;
}

/** `3d 4h` / `4h 12m` / `12m` — mockup:11's `3d 4h` form. */
function formatUptime(startedAt: string | null): string {
  if (startedAt == null) return '—';
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `StopDaemonOutcome`'s 5 branches — `stopped`/`already_stopped` both
 * reached the target state; the other 3 are distinct, visible failures,
 * never styled as success. `child_unresponsive` renders its `childPid` —
 * the payload is used, not discarded. Exhaustive switch, explicit return
 * type: TS flags a missing branch if the union ever grows a 6th variant. */
function stopOutcomeMessage(outcome: StopDaemonOutcome): {
  text: string;
  tone: 'success' | 'destructive';
} {
  switch (outcome.outcome) {
    case 'stopped':
      return { text: 'Daemon stopped.', tone: 'success' };
    case 'already_stopped':
      return { text: 'Daemon was already stopped.', tone: 'success' };
    case 'daemon_unresponsive':
      return {
        text: "The daemon didn't respond to the stop signal — check it manually.",
        tone: 'destructive',
      };
    case 'child_unresponsive':
      return {
        text: `The in-flight run (pid ${outcome.childPid}) didn't stop — check it manually.`,
        tone: 'destructive',
      };
    case 'stale_pidfile':
      return {
        text: 'The pidfile was stale — no daemon was actually running.',
        tone: 'destructive',
      };
  }
}

/** `StartDaemonOutcome`'s 3 branches — `started`/`already_running` both
 * reach the target state; `spawn_failed` is a distinct, visible failure. */
function startOutcomeMessage(outcome: StartDaemonOutcome): {
  text: string;
  tone: 'success' | 'destructive';
} {
  switch (outcome.outcome) {
    case 'started':
      return { text: 'Daemon started.', tone: 'success' };
    case 'already_running':
      return { text: 'Daemon was already running.', tone: 'success' };
    case 'spawn_failed':
      return { text: 'Failed to start the daemon.', tone: 'destructive' };
  }
}

/** "Paused 3 of 4 profiles — rajni failed: <message>" — never a bare
 * boolean "done". Multiple failures join with "; ", each still named. */
function pauseAllMessage(result: PauseAllResult): string {
  const total = result.succeeded.length + result.failed.length;
  const base = `Paused ${result.succeeded.length} of ${total} profiles`;
  if (result.failed.length === 0) return `${base}.`;
  const failures = result.failed
    .map((f) => `${f.profile} failed: ${f.message}`)
    .join('; ');
  return `${base} — ${failures}`;
}

function pauseAllTone(result: PauseAllResult): LineTone {
  return result.failed.length > 0 ? 'destructive' : 'success';
}

/** The Operate page's Daemon card. Owns loading/`api-unreachable`. */
export function DaemonCard({ profile }: { profile: string }) {
  const daemon = useQuery(daemonQuery());
  const profileConfig = useQuery(configDocQuery(profile, 'profile.json'));
  const stopMutation = useStopDaemon();
  const startMutation = useStartDaemon();
  const autostartMutation = useSetAutostart();
  const pauseAllMutation = usePauseAll();

  // No GET exists for "current autostart enabled" or "OS platform" — the
  // switch renders live by default (unchecked) and a click's resolved
  // `AutostartOutcome.outcome` converts it after the fact: `checked` for
  // `'ok'`, the static disabled-look row for `'unsupported_platform'`.
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [platformUnsupported, setPlatformUnsupported] = useState(false);

  async function handleAutostartClick() {
    const nextValue = !autostartEnabled;
    try {
      const result: AutostartOutcome = await autostartMutation.mutateAsync(nextValue);
      if (result.outcome === 'ok') {
        setAutostartEnabled(nextValue);
      } else {
        setPlatformUnsupported(true);
      }
    } catch {
      // A 409 `autostart_conflict` or a network failure — rendered from
      // `autostartMutation.isError` below. The switch's checked state is
      // left untouched, not optimistically flipped.
    }
  }

  if (daemon.isError) {
    return (
      <Card data-qa="card-daemon" size="sm">
        <CardHeader>
          <CardTitle>Daemon</CardTitle>
          <CardAction>
            <span
              data-qa="daemon-state"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground"
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber" />
              Can't reach the daemon API
            </span>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => daemon.refetch()}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!daemon.data) {
    return (
      <Card data-qa="card-daemon" size="sm">
        <CardHeader>
          <CardTitle>Daemon</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-7 w-64" />
        </CardContent>
      </Card>
    );
  }

  const status = daemon.data;
  const statusWord = daemonStatusWord(status, profile);
  const troubled = statusWord.tone !== 'success';
  const isWorst = worstSeverity(troubled ? ['daemon-down'] : []) === 'daemon-down';
  const accentClass = !isWorst
    ? ''
    : statusWord.tone === 'destructive'
      ? 'border-l-2 border-destructive bg-destructive/10'
      : 'border-l-2 border-attention bg-attention/10';

  const schedule = readSchedule(profileConfig.data?.text);
  const banner = profileConfig.isSuccess
    ? scheduleWarning({
        daemonState: status.state,
        scheduleEnabled: schedule.enabled,
        times: schedule.times,
      })
    : null;

  const startStopLabel = status.state === 'running' ? 'Stop' : 'Start';
  const handleStartStopClick = () =>
    startStopLabel === 'Stop' ? stopMutation.mutate() : startMutation.mutate();

  return (
    <Card data-qa="card-daemon" size="sm" className={accentClass}>
      <CardHeader>
        <CardTitle>Daemon</CardTitle>
        <CardAction>
          <span
            data-qa="daemon-state"
            className={`inline-flex items-center gap-1.5 text-sm font-medium ${TONE_WORD_CLASS[statusWord.tone]}`}
          >
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${TONE_DOT_CLASS[statusWord.tone]}`}
            />
            {statusWord.word}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          last tick <code className="font-mono">{formatAgo(status.lastTickAt)}</code> ·
          pid <code className="font-mono">{status.pid ?? '—'}</code> · uptime{' '}
          <code className="font-mono">{formatUptime(status.startedAt)}</code>
        </p>

        {banner && (
          <div
            role="alert"
            className="flex flex-col gap-1 rounded-lg border border-attention bg-attention/10 p-3 text-sm"
          >
            <p>Scheduled for {banner.firstTime} but the daemon isn't running</p>
            <code className="font-mono text-xs">{RUN_COMMAND}</code>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            data-qa="daemon-start-stop"
            variant="outline"
            size="sm"
            disabled={stopMutation.isPending || startMutation.isPending}
            onClick={handleStartStopClick}
          >
            {startStopLabel}
          </Button>
          <Button
            type="button"
            data-qa="daemon-pause-all"
            variant="outline"
            size="sm"
            disabled={pauseAllMutation.isPending}
            onClick={() => pauseAllMutation.mutate()}
          >
            Pause all
          </Button>
          {platformUnsupported ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch
                data-qa="daemon-autostart"
                aria-label="Autostart"
                checked={false}
                disabled
              />
              <span>Autostart is darwin-only</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <Switch
                data-qa="daemon-autostart"
                aria-label="Autostart"
                checked={autostartEnabled}
                disabled={autostartMutation.isPending}
                onCheckedChange={handleAutostartClick}
              />
              <span>Autostart</span>
            </div>
          )}
        </div>

        {startMutation.isPending && (
          <StatusLine tone="muted">
            <Loader2 aria-hidden className="mr-1.5 inline size-3.5 animate-spin" />
            Starting… this can take up to 35 seconds
          </StatusLine>
        )}
        {startMutation.isSuccess && startMutation.data && (
          <StatusLine tone={startOutcomeMessage(startMutation.data).tone}>
            {startOutcomeMessage(startMutation.data).text}
          </StatusLine>
        )}
        {startMutation.isError && (
          <StatusLine tone="destructive">
            Couldn't reach the start endpoint: {getErrorMessage(startMutation.error)}
          </StatusLine>
        )}

        {stopMutation.isPending && <StatusLine tone="muted">Stopping…</StatusLine>}
        {stopMutation.isSuccess && stopMutation.data && (
          <StatusLine tone={stopOutcomeMessage(stopMutation.data).tone}>
            {stopOutcomeMessage(stopMutation.data).text}
          </StatusLine>
        )}
        {stopMutation.isError && (
          <StatusLine tone="destructive">
            Couldn't reach the stop endpoint: {getErrorMessage(stopMutation.error)}
          </StatusLine>
        )}

        {pauseAllMutation.isPending && (
          <StatusLine tone="muted">Pausing all profiles…</StatusLine>
        )}
        {pauseAllMutation.isSuccess && pauseAllMutation.data && (
          <StatusLine tone={pauseAllTone(pauseAllMutation.data)}>
            {pauseAllMessage(pauseAllMutation.data)}
          </StatusLine>
        )}
        {pauseAllMutation.isError && (
          <StatusLine tone="destructive">
            Pause all failed: {getErrorMessage(pauseAllMutation.error)}
          </StatusLine>
        )}

        {autostartMutation.isError && (
          <StatusLine tone="destructive">
            Autostart error: {getErrorMessage(autostartMutation.error)}
          </StatusLine>
        )}
      </CardContent>
    </Card>
  );
}
