import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';
import { Switch } from '../../../components/ui/switch';
import { useStoredProfile } from '../../../lib/profile';
import { navigate } from '../../../lib/router';
import { cn } from '../../../lib/utils';
import { clearDraft } from '../draftStore';
import { validateLaunch } from '../validate';
import type { RunIntentOutcome } from '../wizard.api';
import { getDaemonStatus, patchProfileConfig, requestRunIntent } from '../wizard.api';
import { wizardKeys } from '../wizard.queries';
import type {
  DaemonState,
  LaunchAnswers,
  SchedulePreset,
  WizardStepProps,
} from '../wizard.types';

export type { WizardStepProps };

const PRESETS: SchedulePreset[] = ['morning', 'morning-afternoon', 'custom', 'manual'];

const PRESET_LABELS: Record<SchedulePreset, string> = {
  morning: 'Morning (9:00)',
  'morning-afternoon': 'Morning + afternoon (9:00, 14:00)',
  custom: 'Custom',
  manual: 'Manual only',
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The frozen preset -> written-times mapping (spec §3.4). `custom` is
 * de-duplicated and sorted ascending — plain string sort is correct here
 * because every entry is a zero-padded 24-hour HH:MM string. */
function presetTimes(preset: SchedulePreset, customTimes: string[]): string[] {
  switch (preset) {
    case 'morning':
      return ['09:00'];
    case 'morning-afternoon':
      return ['09:00', '14:00'];
    case 'custom':
      return [...new Set(customTimes)].sort();
    case 'manual':
      return [];
  }
}

/** Every preset enables the schedule except `manual`, which is the
 * explicit "I will trigger runs myself" choice. */
function presetEnabled(preset: SchedulePreset): boolean {
  return preset !== 'manual';
}

type IntentDataState = 'queued' | 'deduped' | 'run_in_progress' | 'error';

function intentDataState(outcome: RunIntentOutcome): IntentDataState {
  if (outcome.kind === 'queued') return outcome.deduped ? 'deduped' : 'queued';
  return outcome.kind;
}

function intentMessage(
  outcome: RunIntentOutcome,
  daemonState: DaemonState | undefined,
): string {
  switch (outcome.kind) {
    case 'queued': {
      if (outcome.deduped) return 'Already queued';
      const base = 'Queued — waiting for the daemon';
      return daemonState === 'running'
        ? base
        : `${base}. Start it with jobbunny serve start.`;
    }
    case 'run_in_progress':
      return outcome.runId == null
        ? 'A run is already in progress'
        : `A run is already in progress (run #${outcome.runId})`;
    case 'error':
      return outcome.message;
  }
}

/** The copy-paste command block shown whenever the daemon is not
 * `running`. Starting the daemon stays a CLI action — the board never
 * spawns a process, which is a hard architectural rule (see this task's
 * brief rationale), not a limitation this component works around. */
function DaemonStartHint() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText('jobbunny serve start');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser sandbox; the
      // command is still visible to copy by hand, so this never throws.
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
      <code className="font-mono text-sm">jobbunny serve start</code>
      <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export function Step6Launch({ draft, onDraftChange, registerSubmit }: WizardStepProps) {
  const profile = draft.profile;
  const launch = draft.launch;
  const [preset, setPreset] = useState<SchedulePreset>(launch.preset);
  const [customTimes, setCustomTimes] = useState<string[]>(launch.customTimes);
  const [weekdays, setWeekdays] = useState<number[]>(launch.weekdays);
  const [newTime, setNewTime] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [intentOutcome, setIntentOutcome] = useState<RunIntentOutcome | null>(null);
  const [requestingRun, setRequestingRun] = useState(false);
  const [, choose] = useStoredProfile();

  const daemonQuery = useQuery({
    queryKey: wizardKeys.daemon(),
    queryFn: getDaemonStatus,
  });

  /** Folds a changed `LaunchAnswers` slice back into the full `WizardDraft`
   * and reports it upward immediately — every field edit, never only on
   * submit (design ledger, "Step component contract"). */
  function emit(next: LaunchAnswers) {
    onDraftChange({ ...draft, launch: next });
  }

  function selectPreset(next: SchedulePreset) {
    setPreset(next);
    setErrors({});
    emit({ preset: next, customTimes, weekdays });
  }

  function addTime() {
    const trimmed = newTime.trim();
    if (trimmed === '') return;
    const next = [...customTimes, trimmed];
    setCustomTimes(next);
    emit({ preset, customTimes: next, weekdays });
    setNewTime('');
  }

  function removeTime(time: string) {
    const next = customTimes.filter((t) => t !== time);
    setCustomTimes(next);
    emit({ preset, customTimes: next, weekdays });
  }

  function toggleWeekday(day: number) {
    const next = weekdays.includes(day)
      ? weekdays.filter((d) => d !== day)
      : [...weekdays, day].sort((a, b) => a - b);
    setWeekdays(next);
    emit({ preset, customTimes, weekdays: next });
  }

  async function handleRunNow() {
    setRequestingRun(true);
    const outcome = await requestRunIntent(profile);
    setIntentOutcome(outcome);
    setRequestingRun(false);
  }

  // Registers this step's submit handler with WizardPage, which invokes it
  // from the one shared `wizard-next` button. A validation failure resolves
  // `false` (the message is already visible inline via `FieldError`, so
  // nothing further needs to reach WizardPage's `wizard-error` alert). A
  // failed `patchProfileConfig` write is left to throw and propagate —
  // WizardPage catches it and renders the message in `wizard-error` — which
  // is also why the draft is only cleared and navigation only fires after
  // that `await` resolves without throwing.
  useEffect(() => {
    registerSubmit(async () => {
      const fieldErrors = validateLaunch({
        preset,
        times: preset === 'custom' ? customTimes : [],
      });
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length > 0) return false;

      await patchProfileConfig(profile, (cfg) => {
        cfg.schedule = {
          times: presetTimes(preset, customTimes),
          enabled: presetEnabled(preset),
          weekdays,
        };
      });

      clearDraft(profile);
      choose(profile);
      navigate({ name: 'runs' });
      return true;
    });

    return () => registerSubmit(null);
  }, [profile, preset, customTimes, weekdays, registerSubmit, choose]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-heading text-lg font-medium">Launch</h2>
        <p className="text-sm text-muted-foreground">
          Choose when Job Bunny should run, then optionally start the first run right now.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Schedule</h3>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              data-testid="wizard-preset"
              data-preset={p}
              aria-pressed={preset === p}
              onClick={() => selectPreset(p)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                preset === p
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-card text-foreground hover:bg-muted',
              )}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex flex-col gap-2">
            <Field invalid={Boolean(errors.times)}>
              <FieldLabel>Run time</FieldLabel>
              <div className="flex items-center gap-2">
                <FieldControl>
                  <Input
                    type="text"
                    placeholder="HH:MM"
                    value={newTime}
                    onChange={(e) => setNewTime(e.target.value)}
                  />
                </FieldControl>
                <Button type="button" variant="outline" size="sm" onClick={addTime}>
                  Add time
                </Button>
              </div>
              <FieldError>{errors.times}</FieldError>
            </Field>
            <ul className="flex flex-wrap gap-2">
              {customTimes.map((time) => (
                <li key={time}>
                  <Badge variant="outline">
                    {time}
                    <button
                      type="button"
                      aria-label={`Remove ${time}`}
                      onClick={() => removeTime(time)}
                      className="ml-1"
                    >
                      ×
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Run on</span>
          <div className="flex flex-wrap gap-3">
            {WEEKDAY_LABELS.map((label, day) => (
              <label
                key={label}
                htmlFor={`wizard-weekday-${day}`}
                className="flex items-center gap-1.5 text-sm"
              >
                <Switch
                  id={`wizard-weekday-${day}`}
                  data-testid="wizard-weekday"
                  data-weekday={day}
                  checked={weekdays.includes(day)}
                  onCheckedChange={() => toggleWeekday(day)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Daemon</h3>
        {daemonQuery.isPending ? (
          <Skeleton className="h-8 w-40" />
        ) : daemonQuery.isSuccess ? (
          <div
            data-testid="wizard-daemon-state"
            data-state={daemonQuery.data.state}
            className="flex flex-col gap-2"
          >
            <Badge
              variant={daemonQuery.data.state === 'running' ? 'success' : 'destructive'}
            >
              {daemonQuery.data.state === 'running'
                ? 'Running'
                : daemonQuery.data.state === 'stale'
                  ? 'Stale'
                  : 'Stopped'}
            </Badge>
            {daemonQuery.data.state !== 'running' && (
              <>
                <p className="text-sm text-muted-foreground">
                  Job Bunny's daemon is the only thing that starts runs — the board never
                  starts it for you. A queued run waits until the daemon is running.
                </p>
                <DaemonStartHint />
              </>
            )}
          </div>
        ) : (
          <p className="text-sm text-destructive">Couldn't load daemon status.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Run now</h3>
        <p className="text-sm text-muted-foreground">
          Optional — you can finish without running now.
        </p>
        <Button
          type="button"
          variant="outline"
          data-testid="wizard-run-now"
          disabled={requestingRun}
          onClick={handleRunNow}
        >
          {requestingRun ? 'Requesting…' : 'Run now'}
        </Button>
        {intentOutcome && (
          <p
            data-testid="wizard-intent-state"
            data-state={intentDataState(intentOutcome)}
            className={cn(
              'text-sm',
              intentOutcome.kind === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {intentMessage(intentOutcome, daemonQuery.data?.state)}
          </p>
        )}
      </section>
    </div>
  );
}
