import { useQuery } from '@tanstack/react-query';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { daemonQuery } from '../wizard/wizard.queries';
import type { DaemonProfileSchedule } from '../wizard/wizard.types';
import { usePutSkipNext, useSetScheduleEnabled } from './operate.queries';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Local `YYYY-MM-DD` for "today" — matches the local wall-clock semantics
 * of `schedule.times` entries (e.g. `"09:00"`), never UTC, which could
 * disagree with the user's local calendar day near midnight. */
export function todayISODate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Blueprint step 33's `nextSlotFor` — derives the `{date, slot}` pair
 * written to `schedule.skipNext` from a profile's `nextRunAt` (an absolute
 * ISO instant): `slot` is that instant's local `HH:MM` (the same format
 * `schedule.times` entries use elsewhere), `date` is today's local date.
 * `null` when there's no next run to skip — a profile that's paused or has
 * no configured times reports `nextRunAt: null`. */
export function nextSlotFor(
  nextRunAt: string | null,
): { date: string; slot: string } | null {
  if (nextRunAt === null) return null;
  const parsed = new Date(nextRunAt);
  if (Number.isNaN(parsed.getTime())) return null;
  const slot = `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
  return { date: todayISODate(), slot };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One row — a private, per-row component so each row owns its own
 * skip-next / pause mutation state; a shared mutation object would make one
 * row's pending/success state bleed into every other row.
 *
 * Pause is a ONE-WAY action, deliberately not a two-way switch (fix-round
 * finding): `daemon.profiles[]` is built from `scanProfileSchedules`
 * (`src/ops/daemon/scan/scan.ts`), which — by its own documented contract —
 * SKIPS any profile with `schedule.enabled === false`. The API can
 * therefore never return a row with `enabled: false`, so a two-way
 * `checked={schedule.enabled}` switch was always showing `true` and,
 * worse, clicking it off made the row disappear from this card on the next
 * refetch with no way back in from here. Pausing a profile removes its row
 * on the next refresh; re-enabling it is Settings → Schedule's job (its own
 * `enabled` toggle there is the real two-way control), pointed at by the
 * footer note below.
 *
 * Re-review finding: unlike `schedule-skip-next` (still `data-qa`'d only on
 * the ACTIVE row — its own test covers that), the Pause button's `data-qa`
 * and accessible name are PER-ROW (`schedule-pause-${profile}`, `aria-label
 * ="Pause schedule — ${profile}"`) — a card listing several profiles had
 * every row's button share the bare name "Pause", so assistive tech and any
 * selector reaching for a specific profile's Pause action had no way to
 * disambiguate rows. */
function ScheduleRow({
  schedule,
  active,
}: {
  schedule: DaemonProfileSchedule;
  active: boolean;
}) {
  const skipNextMutation = usePutSkipNext(schedule.profile);
  const pauseMutation = useSetScheduleEnabled(schedule.profile);
  const nextSlot = nextSlotFor(schedule.nextRunAt);

  return (
    <div
      data-qa={`schedule-row-${schedule.profile}`}
      className={`flex flex-wrap items-center gap-2 rounded-lg p-2 ${active ? 'bg-accent' : ''}`}
    >
      <span className="text-sm font-medium">{schedule.profile}</span>
      <span className="text-xs text-muted-foreground">
        next run {nextSlot?.slot ?? '—'}
      </span>
      <Button
        type="button"
        data-qa={active ? 'schedule-skip-next' : undefined}
        variant="outline"
        size="sm"
        disabled={nextSlot === null || skipNextMutation.isPending}
        onClick={() => {
          if (nextSlot) skipNextMutation.mutate(nextSlot);
        }}
      >
        Skip next
      </Button>
      {skipNextMutation.isSuccess && <Badge variant="success">Next run skipped</Badge>}
      {skipNextMutation.isError && (
        <span className="text-xs text-destructive">
          Couldn't skip: {getErrorMessage(skipNextMutation.error)}
        </span>
      )}
      <Button
        type="button"
        data-qa={`schedule-pause-${schedule.profile}`}
        aria-label={`Pause schedule — ${schedule.profile}`}
        variant="outline"
        size="sm"
        disabled={pauseMutation.isPending || pauseMutation.isSuccess}
        onClick={() => pauseMutation.mutate(false)}
      >
        Pause
      </Button>
      {pauseMutation.isSuccess && <Badge variant="success">Paused</Badge>}
      {pauseMutation.isError && (
        <span className="text-xs text-destructive">
          Couldn't pause: {getErrorMessage(pauseMutation.error)}
        </span>
      )}
    </div>
  );
}

/** The Operate page's Scheduled runs card (blueprint step 33). One row per
 * `daemon.profiles[]` entry, reading the SAME `wizardKeys.daemon()` cache
 * entry `DaemonCard` reads — no second daemon query. `profile` is the
 * currently-selected sidebar profile, read the same way (a plain prop) that
 * `ProfileSwitcher.tsx` itself receives it — not a second notion of
 * "active". */
export function ScheduledRunsCard({ profile }: { profile: string }) {
  const daemon = useQuery(daemonQuery());

  if (daemon.isError) {
    return (
      <Card data-qa="card-scheduled-runs" size="sm">
        <CardHeader>
          <CardTitle>Scheduled runs</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Can't reach the daemon API</p>
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
      <Card data-qa="card-scheduled-runs" size="sm">
        <CardHeader>
          <CardTitle>Scheduled runs</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-qa="card-scheduled-runs" size="sm">
      <CardHeader>
        <CardTitle>Scheduled runs</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {daemon.data.profiles.map((schedule) => (
          <ScheduleRow
            key={schedule.profile}
            schedule={schedule}
            active={schedule.profile === profile}
          />
        ))}
        <p className="text-xs text-muted-foreground">
          Active profile row highlighted. Pausing here removes a profile from this list —
          to resume it, or edit its times,{' '}
          <a href="#/settings/schedule" className="text-primary hover:underline">
            Edit times in Settings →
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
