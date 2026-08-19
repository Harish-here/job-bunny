import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  formatInstant,
  formatInstantTitle,
} from '../../../../../src/core/datetime/index.ts';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { navigate } from '../../../lib/router';
import { daemonStatusWord } from '../../shell/daemonState';
import { daemonQuery } from '../../wizard/wizard.queries';
import type { DaemonStatus } from '../../wizard/wizard.types';
import { DocFormGate } from '../DocFormGate';
import { useDocForm } from '../useDocForm';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_GRACE_MINUTES = 90;

// Static class strings only — Tailwind's scanner needs literal candidates,
// not a template-interpolated `text-${tone}-strong`. `destructive`/`muted`
// use the repo's existing plain (non `-strong`) treatment: `--destructive`
// already clears 4.5:1 as text (ux-notes §14), so it needs no `-strong`
// variant; `muted` isn't hit by any of `daemonStatusWord`'s four branches
// today but is kept for exhaustiveness against `DaemonStatusTone`.
const TONE_WORD_CLASS: Record<ReturnType<typeof daemonStatusWord>['tone'], string> = {
  success: 'text-success-strong',
  attention: 'text-attention-strong',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}
function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((v): v is number => typeof v === 'number')
    : [];
}

/** The compact daemon bridge line (blueprint.md:798-812, step 18). Owns its
 * own `isLoading`/`isError` branches; otherwise defers the word/tone/detail
 * derivation entirely to `daemonStatusWord()` (task 16) — the six-branch
 * full-markup treatment this replaced now lives in `DaemonCard` (a later
 * Operate brief). Deliberately NOT itself a mockup-mapped region — no
 * dedicated `data-qa`. */
function DaemonBridgeLine({
  profile,
  daemon,
}: {
  profile: string;
  daemon: UseQueryResult<DaemonStatus>;
}) {
  let body: ReactNode;
  if (daemon.isLoading) {
    body = <span className="text-sm text-muted-foreground">Loading…</span>;
  } else if (daemon.isError) {
    body = <span className="text-sm text-destructive">Can't reach the daemon API</span>;
  } else if (daemon.data) {
    const status = daemonStatusWord(daemon.data, profile);
    body = (
      <span className="text-sm">
        <span className={`font-medium ${TONE_WORD_CLASS[status.tone]}`}>
          {status.word}
        </span>
        {status.detail ? (
          <span className="text-muted-foreground"> {status.detail}</span>
        ) : null}
      </span>
    );
  } else {
    body = null;
  }

  return (
    <div className="flex items-center gap-2">
      {body}
      <button
        type="button"
        className="text-sm text-primary hover:underline"
        onClick={() => navigate({ name: 'setup' })}
      >
        Manage the daemon on Operate →
      </button>
    </div>
  );
}

// Schedule → profile.json's `schedule` block only. "Next run" reads
// GET /api/daemon rather than reimplementing the daemon's own scheduling
// predicate client-side — see Rationale.
export function ScheduleSection({ profile }: { profile: string }) {
  const docForm = useDocForm(profile, 'profile.json');
  const daemon = useQuery(daemonQuery());

  const [times, setTimes] = useState<string[]>([]);
  const [newTime, setNewTime] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [weekdays, setWeekdays] = useState<number[]>(DEFAULT_WEEKDAYS);
  const [graceMinutes, setGraceMinutes] = useState(DEFAULT_GRACE_MINUTES);
  const [graceError, setGraceError] = useState<string | null>(null);

  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (docForm.isLoading || docForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const schedule =
      (docForm.value.schedule as Record<string, unknown> | undefined) ?? {};
    setTimes(asStringArray(schedule.times));
    setEnabled(typeof schedule.enabled === 'boolean' ? schedule.enabled : true);
    const weekdayValues = asNumberArray(schedule.weekdays);
    setWeekdays(weekdayValues.length > 0 ? weekdayValues : DEFAULT_WEEKDAYS);
    setGraceMinutes(
      typeof schedule.graceMinutes === 'number'
        ? schedule.graceMinutes
        : DEFAULT_GRACE_MINUTES,
    );
  }, [profile, docForm.isLoading, docForm.value]);

  function addTime() {
    const trimmed = newTime.trim();
    if (!TIME_RE.test(trimmed)) {
      setTimeError('Enter a time as HH:MM (24-hour).');
      return;
    }
    setTimeError(null);
    if (!times.includes(trimmed)) setTimes((prev) => [...prev, trimmed]);
    setNewTime('');
  }
  function removeTime(time: string) {
    setTimes((prev) => prev.filter((t) => t !== time));
  }
  function toggleWeekday(day: number) {
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  }

  async function handleSave() {
    if (!Number.isInteger(graceMinutes) || graceMinutes <= 0) {
      setGraceError('Grace minutes must be a positive whole number.');
      return;
    }
    setGraceError(null);
    await docForm.save((cfg) => {
      const schedule = (cfg.schedule as Record<string, unknown> | undefined) ?? {};
      cfg.schedule = { ...schedule, times, enabled, weekdays, graceMinutes };
    });
  }

  const entry = daemon.data?.profiles.find((p) => p.profile === profile);
  const now = new Date();
  const nextRunLabel =
    entry?.nextRunAt != null
      ? `Next run (saved): ${formatInstant(entry.nextRunAt, now)}`
      : 'Next run (saved): no upcoming run';
  const nextRunTitle =
    entry?.nextRunAt != null ? formatInstantTitle(entry.nextRunAt, now) : undefined;

  return (
    <DocFormGate
      doc="profile.json"
      isLoading={docForm.isLoading}
      loadError={docForm.loadError}
      parseError={docForm.parseError}
    >
      <div className="flex flex-col gap-4">
        <p
          data-testid="schedule-next-run"
          className="text-sm text-muted-foreground"
          title={nextRunTitle}
        >
          {nextRunLabel}
        </p>
        <DaemonBridgeLine profile={profile} daemon={daemon} />
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>Enabled</FieldLabel>
            <FieldControl>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </FieldControl>
          </div>
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm leading-none font-medium">Run times</span>
          <div className="flex flex-wrap gap-1.5">
            {times.map((time) => (
              <Badge key={time} variant="secondary">
                <span>{time}</span>
                <button
                  type="button"
                  aria-label={`Remove ${time}`}
                  onClick={() => removeTime(time)}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Input
              aria-label="Add a run time"
              placeholder="HH:MM"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
            />
            <Button type="button" variant="outline" size="sm" onClick={addTime}>
              Add
            </Button>
          </div>
          {timeError && <p className="text-sm text-destructive">{timeError}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm leading-none font-medium">Weekdays</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_LABELS.map((label, day) => (
              <Badge
                key={label}
                asChild
                variant={weekdays.includes(day) ? 'default' : 'outline'}
              >
                <button
                  type="button"
                  aria-pressed={weekdays.includes(day)}
                  onClick={() => toggleWeekday(day)}
                >
                  {label}
                </button>
              </Badge>
            ))}
          </div>
        </div>
        <Field invalid={graceError != null}>
          <FieldLabel>Grace minutes</FieldLabel>
          <FieldControl>
            <Input
              type="number"
              value={String(graceMinutes)}
              onChange={(e) => setGraceMinutes(Number(e.target.value))}
            />
          </FieldControl>
          <FieldError>{graceError}</FieldError>
        </Field>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={docForm.isSaving}
            onClick={handleSave}
          >
            Save
          </Button>
          {docForm.isSaving && (
            <span className="text-xs text-muted-foreground">Saving…</span>
          )}
        </div>
        {docForm.serverError && (
          <p data-testid="settings-error" className="text-sm text-destructive">
            {docForm.serverError}
          </p>
        )}
      </div>
    </DocFormGate>
  );
}
