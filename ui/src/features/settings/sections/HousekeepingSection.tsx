/**
 * "Housekeeping" settings section (blueprint.md:862-867, step 22's
 * component half). Two cards over `profile.json`: cleanup TTLs
 * (`settings.cleanup.*` — new fields, currently unsurfaced anywhere in the
 * UI) and routines (extracted unchanged from the old per-profile section's
 * chip list, now rendered with the shared `ChipInput`).
 *
 * Defaults mirror `src/routines/cleanup/cleanup.ts`'s own zod schema
 * (`passedOlderThanDays: 7`, `untouchedOlderThanDays: 30`,
 * `runsOlderThanDays: 30`, `checkpointsOlderThanDays: 2`) — a profile with
 * no `settings.cleanup` block at all still shows the real in-force numbers,
 * never a blank/zero, matching `FetchingSection.tsx`'s own posture.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { ChipInput } from '../ChipInput';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useRegisterSettingsSave } from '../save/SettingsSaveContext';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { useDocForm } from '../useDocForm';

interface CleanupState {
  runsOlderThanDays: number;
  checkpointsOlderThanDays: number;
  passedOlderThanDays: number;
  untouchedOlderThanDays: number;
}

interface HousekeepingState {
  cleanup: CleanupState;
  routines: string[];
}

const CLEANUP_DEFAULTS: CleanupState = {
  runsOlderThanDays: 30,
  checkpointsOlderThanDays: 2,
  passedOlderThanDays: 7,
  untouchedOlderThanDays: 30,
};

const EMPTY_STATE: HousekeepingState = { cleanup: CLEANUP_DEFAULTS, routines: [] };

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function parseHousekeepingState(profileDoc: Record<string, unknown>): HousekeepingState {
  const settings = asRecord(profileDoc.settings);
  const cleanup = asRecord(settings.cleanup);
  return {
    cleanup: {
      runsOlderThanDays: nonNegativeInteger(
        cleanup.runsOlderThanDays,
        CLEANUP_DEFAULTS.runsOlderThanDays,
      ),
      checkpointsOlderThanDays: nonNegativeInteger(
        cleanup.checkpointsOlderThanDays,
        CLEANUP_DEFAULTS.checkpointsOlderThanDays,
      ),
      passedOlderThanDays: nonNegativeInteger(
        cleanup.passedOlderThanDays,
        CLEANUP_DEFAULTS.passedOlderThanDays,
      ),
      untouchedOlderThanDays: nonNegativeInteger(
        cleanup.untouchedOlderThanDays,
        CLEANUP_DEFAULTS.untouchedOlderThanDays,
      ),
    },
    routines: asStringArray(profileDoc.routines),
  };
}

interface CleanupFieldDef {
  key: keyof CleanupState;
  label: string;
  dataQa: string;
  description: string;
}

const CLEANUP_FIELDS: CleanupFieldDef[] = [
  {
    key: 'runsOlderThanDays',
    label: 'Runs older than (days)',
    dataQa: 'cleanup-runs-older-than-days',
    description: 'Local run folders and the runs table are pruned past this age.',
  },
  {
    key: 'checkpointsOlderThanDays',
    label: 'Checkpoints older than (days)',
    dataQa: 'cleanup-checkpoints-older-than-days',
    description:
      'Checkpoints are only ever read same-day, so this stays much shorter than runs.',
  },
  {
    key: 'passedOlderThanDays',
    label: 'Passed jobs older than (days)',
    dataQa: 'cleanup-passed-older-than-days',
    description: 'Status=Passed rows are archived past this age.',
  },
  {
    key: 'untouchedOlderThanDays',
    label: 'Untouched jobs older than (days)',
    dataQa: 'cleanup-untouched-older-than-days',
    description: 'Rows with no status set are archived past this age.',
  },
];

function validateState(state: HousekeepingState): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of CLEANUP_FIELDS) {
    const value = state.cleanup[field.key];
    if (!Number.isInteger(value) || value < 0) {
      errors[`housekeeping.${field.key}`] =
        `${field.label} must be a whole number, 0 or more.`;
    }
  }
  return errors;
}

// Housekeeping → profile.json's `settings.cleanup.*` (four new TTL fields)
// and `routines` only. `lanes` live on Where jobs come from and
// connector/Notion/Telegram live on Delivery — the old profile section that
// used to own all of this is deleted (task 23).
export function HousekeepingSection({ profile }: { profile: string }) {
  const docForm = useDocForm(profile, 'profile.json');

  const [state, setState] = useState<HousekeepingState>(EMPTY_STATE);
  const [savedState, setSavedState] = useState<HousekeepingState>(EMPTY_STATE);

  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (docForm.isLoading || docForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const parsed = parseHousekeepingState(docForm.value);
    setState(parsed);
    setSavedState(parsed);
  }, [profile, docForm.isLoading, docForm.value]);

  function updateCleanupField(key: keyof CleanupState, raw: string) {
    setState((prev) => ({ ...prev, cleanup: { ...prev.cleanup, [key]: Number(raw) } }));
  }

  function addRoutine(name: string) {
    setState((prev) => ({ ...prev, routines: [...prev.routines, name] }));
  }

  function removeRoutine(name: string) {
    setState((prev) => ({
      ...prev,
      routines: prev.routines.filter((r) => r !== name),
    }));
  }

  function handleSave(value: HousekeepingState): Promise<boolean> {
    return docForm.save((cfg) => {
      const settings = asRecord(cfg.settings);
      cfg.settings = { ...settings, cleanup: { ...value.cleanup } };
      cfg.routines = value.routines;
    });
  }

  const saveState = useSectionSaveState({
    profile,
    initialValue: savedState,
    currentValue: state,
    validate: validateState,
    onSave: async (value) => {
      const ok = await handleSave(value);
      if (ok) setSavedState(value);
      return ok;
    },
  });

  useRegisterSettingsSave({
    isDirty: saveState.isDirty,
    save: saveState.save,
    discard: () => setState(saveState.discard()),
  });

  return (
    <DocFormGate
      doc="profile.json"
      isLoading={docForm.isLoading}
      loadError={docForm.loadError}
      parseError={docForm.parseError}
    >
      <div className="flex flex-col gap-4">
        <Card data-qa="cleanup-ttls-card">
          <CardHeader>
            <CardTitle>Cleanup TTLs</CardTitle>
            <CardDescription>
              How long finished runs, checkpoints, and tracked jobs stick around before
              routine cleanup archives or prunes them.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            {CLEANUP_FIELDS.map((field) => {
              const value = state.cleanup[field.key];
              const error = saveState.errors[`housekeeping.${field.key}`];
              return (
                <Field key={field.key} data-qa={field.dataQa} invalid={Boolean(error)}>
                  <FieldLabel>{field.label}</FieldLabel>
                  <FieldControl>
                    <Input
                      type="number"
                      value={String(value)}
                      onChange={(e) => updateCleanupField(field.key, e.target.value)}
                    />
                  </FieldControl>
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                  <FieldError>{error}</FieldError>
                </Field>
              );
            })}
          </CardContent>
        </Card>

        <Card data-qa="routines-card">
          <CardHeader>
            <CardTitle>Routines</CardTitle>
            <CardDescription>
              Maintenance routines run alongside the pipeline.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChipInput
              values={state.routines}
              onAdd={addRoutine}
              onRemove={removeRoutine}
              ariaLabel="Routines"
            />
          </CardContent>
        </Card>

        {docForm.serverError && (
          <p data-testid="settings-error" className="text-sm text-destructive">
            {docForm.serverError}
          </p>
        )}

        <SaveBar
          isDirty={saveState.isDirty}
          errors={saveState.errors}
          successMessage={saveState.successMessage}
          onSave={saveState.save}
          onDiscard={() => setState(saveState.discard())}
        />
      </div>
    </DocFormGate>
  );
}
