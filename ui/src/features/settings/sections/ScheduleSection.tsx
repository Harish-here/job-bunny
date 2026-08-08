import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { daemonQuery } from '../../wizard/wizard.queries';
import { useDocForm } from '../useDocForm';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_GRACE_MINUTES = 90;

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
  const nextRunLabel =
    entry?.nextRunAt != null
      ? `Next run (saved): ${new Date(entry.nextRunAt).toLocaleString()}`
      : 'Next run (saved): no upcoming run';

  return (
    <div className="flex flex-col gap-4">
      <p data-testid="schedule-next-run" className="text-sm text-muted-foreground">
        {nextRunLabel}
      </p>
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
        <Button type="button" size="sm" disabled={docForm.isSaving} onClick={handleSave}>
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
  );
}
