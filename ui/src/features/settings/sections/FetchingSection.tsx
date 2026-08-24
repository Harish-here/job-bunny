/**
 * "Fetching" settings section — S3 (blueprint.md:790-846, steps 19/19-half
 * + 20). Two cards over `profile.json`'s `settings` block: "How much each
 * run pulls" (`fetch-caps-card`, the four run-yield caps — `settings.
 * source.{maxNewPerLane,maxProbesPerRun}` + `settings.linkedin.
 * {maxCardsPerUrl,maxAgeDays}`, same doc paths `LandingCapsTable.tsx`
 * (task 8) already reads) and "How fast it pulls" (the three
 * `PacingPresetCard`s over `settings.linkedin`'s raw jitter/inter-url ms
 * pair, task 20's own file).
 *
 * `maxAgeDays` gates LinkedIn page-inventory freshness, never a yield cap
 * (F10, pre-closed ruling) — its effect copy must never say "caps jobs".
 */
import { useQuery } from '@tanstack/react-query';
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
import { RadioGroup } from '../../../components/ui/radio-group';
import { runsQuery, softErrorsQuery } from '../../runs/runs.queries';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useRegisterSettingsSave } from '../save/SettingsSaveContext';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { ValidationSummary } from '../save/ValidationSummary';
import { useDocForm } from '../useDocForm';
import {
  type PacingPresetName,
  presetFromRanges,
  rangesFromPreset,
} from './fetching.model';
import {
  CAP_FIELDS,
  type CapFieldDef,
  EMPTY_STATE,
  type FetchingState,
  parseFetchingState,
  validatePacingPairs,
  validateState,
} from './fetching.state';
import { PacingAdvancedDisclosure, PacingPresetCard } from './PacingPresetCard';

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export function FetchingSection({ profile }: { profile: string }) {
  const docForm = useDocForm(profile, 'profile.json');
  const runs = useQuery(runsQuery(profile));
  const latestRunId = runs.data?.rows[0]?.id ?? null;
  const softErrors = useQuery(softErrorsQuery(profile, latestRunId ?? -1));
  const capsHit = softErrors.data?.capsHit;

  const [state, setState] = useState<FetchingState>(EMPTY_STATE);
  const [savedState, setSavedState] = useState<FetchingState>(EMPTY_STATE);
  const [fastAck, setFastAck] = useState(false);
  // B1/B2 fix (QA settings-overhaul): bumped only when a real Save click
  // fails, never on a live-typing re-render — see `ValidationSummary`'s
  // own `attempt` doc comment for why the distinction matters.
  const [attempt, setAttempt] = useState(0);
  // Populated only by an attempted `handleSave` (never live/as-you-type —
  // see `validatePacingPairs`'s own doc comment) and cleared the instant
  // the draft changes again, so a stale post-submit error never survives
  // past the edit that was meant to fix it.
  const [pacingErrors, setPacingErrors] = useState<Record<string, string>>({});

  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (docForm.isLoading || docForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const parsed = parseFetchingState(docForm.value);
    setState(parsed);
    setSavedState(parsed);
    setFastAck(false);
  }, [profile, docForm.isLoading, docForm.value]);

  const selectedPreset = presetFromRanges(
    state.jitterMinMs,
    state.jitterMaxMs,
    state.interUrlDelayMinMs,
    state.interUrlDelayMaxMs,
  );
  const savedPreset = presetFromRanges(
    savedState.jitterMinMs,
    savedState.jitterMaxMs,
    savedState.interUrlDelayMinMs,
    savedState.interUrlDelayMaxMs,
  );

  // The ack is cleared — not merely hidden — the instant the (draft)
  // preset stops being Fast, whether that's a direct card click or a raw
  // ms field hand-edit landing outside Fast's exact values. Re-selecting
  // Fast afterward starts unchecked again, since this is the only place
  // `fastAck` is ever set to `true` — see `PacingPresetCard`'s own doc
  // comment for why this can't live as that card's local state instead.
  function applyRanges(next: FetchingState) {
    setState(next);
    setPacingErrors({});
    const nextPreset = presetFromRanges(
      next.jitterMinMs,
      next.jitterMaxMs,
      next.interUrlDelayMinMs,
      next.interUrlDelayMaxMs,
    );
    if (nextPreset !== 'fast') setFastAck(false);
  }

  function selectPreset(preset: PacingPresetName) {
    applyRanges({ ...state, ...rangesFromPreset(preset) });
  }

  function updateCapField(key: CapFieldDef['key'], raw: string) {
    setState((prev) => ({ ...prev, [key]: Number(raw) }));
  }

  function updateRawField(key: keyof FetchingState, raw: string) {
    applyRanges({ ...state, [key]: Number(raw) });
  }

  function handleSave(value: FetchingState): Promise<boolean> {
    const crossFieldErrors = validatePacingPairs(value);
    if (Object.keys(crossFieldErrors).length > 0) {
      setPacingErrors(crossFieldErrors);
      return Promise.resolve(false);
    }
    setPacingErrors({});
    return docForm.save((cfg) => {
      const settings = asRecord(cfg.settings);
      const source = asRecord(settings.source);
      const linkedin = asRecord(settings.linkedin);
      cfg.settings = {
        ...settings,
        source: {
          ...source,
          maxNewPerLane: value.maxNewPerLane,
          maxProbesPerRun: value.maxProbesPerRun,
        },
        linkedin: {
          ...linkedin,
          maxCardsPerUrl: value.maxCardsPerUrl,
          maxAgeDays: value.maxAgeDays,
          jitterMinMs: value.jitterMinMs,
          jitterMaxMs: value.jitterMaxMs,
          interUrlDelayMinMs: value.interUrlDelayMinMs,
          interUrlDelayMaxMs: value.interUrlDelayMaxMs,
        },
      };
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
    discard: () => {
      setPacingErrors({});
      setState(saveState.discard());
    },
  });

  // B1 fix: wraps `saveState.save` for the SaveBar click specifically —
  // bumping `attempt` only on an actual failed click, never on every
  // render — so `ValidationSummary` moves focus exactly once per failed
  // submit (see its own doc comment).
  async function handleSaveClick(): Promise<boolean> {
    const ok = await saveState.save();
    if (!ok) setAttempt((n) => n + 1);
    return ok;
  }

  const allErrors = { ...saveState.errors, ...pacingErrors };

  return (
    <DocFormGate
      doc="profile.json"
      isLoading={docForm.isLoading}
      loadError={docForm.loadError}
      parseError={docForm.parseError}
    >
      <div className="flex flex-col gap-4">
        <ValidationSummary errors={allErrors} attempt={attempt} />

        <Card data-qa="fetch-caps-card">
          <CardHeader>
            <CardTitle>How much each run pulls</CardTitle>
            <CardDescription>
              Enforced at save. Bounds shown beside each field.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            {CAP_FIELDS.map((field) => {
              const value = state[field.key];
              const error = saveState.errors[`fetching.${field.key}`];
              const hit = field.hitKey ? (capsHit?.[field.hitKey] ?? false) : false;
              return (
                <Field
                  key={field.key}
                  id={`fetching.${field.key}`}
                  data-qa={field.dataQa}
                  invalid={Boolean(error)}
                >
                  <FieldLabel>{field.key}</FieldLabel>
                  <FieldControl>
                    <Input
                      type="number"
                      value={String(value)}
                      onChange={(e) => updateCapField(field.key, e.target.value)}
                    />
                  </FieldControl>
                  <p className="text-xs text-muted-foreground">{field.bounds}</p>
                  <p className="text-xs text-muted-foreground">
                    {field.effect(value)}
                    {hit ? ' Your last run hit this cap.' : ''}
                  </p>
                  <FieldError>{error}</FieldError>
                </Field>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How fast it pulls</CardTitle>
            <CardDescription>
              Three presets, consequences visible at once — not a select.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <RadioGroup
              aria-label="Pacing preset"
              data-qa="pacing-presets"
              value={selectedPreset}
              onValueChange={(value) => selectPreset(value as PacingPresetName)}
              className="grid grid-cols-3 gap-3"
            >
              <PacingPresetCard
                preset="safe"
                isCurrent={savedPreset === 'safe'}
                fastAck={fastAck}
                onFastAckChange={setFastAck}
              />
              <PacingPresetCard
                preset="normal"
                isCurrent={savedPreset === 'normal'}
                fastAck={fastAck}
                onFastAckChange={setFastAck}
              />
              <PacingPresetCard
                preset="fast"
                isCurrent={savedPreset === 'fast'}
                fastAck={fastAck}
                onFastAckChange={setFastAck}
              />
            </RadioGroup>

            <PacingAdvancedDisclosure
              jitterMinMs={state.jitterMinMs}
              jitterMaxMs={state.jitterMaxMs}
              interUrlDelayMinMs={state.interUrlDelayMinMs}
              interUrlDelayMaxMs={state.interUrlDelayMaxMs}
              onFieldChange={updateRawField}
              errors={{
                jitterMinMs: pacingErrors['fetching.jitterMinMs'],
                jitterMaxMs: pacingErrors['fetching.jitterMaxMs'],
                interUrlDelayMinMs: pacingErrors['fetching.interUrlDelayMinMs'],
                interUrlDelayMaxMs: pacingErrors['fetching.interUrlDelayMaxMs'],
              }}
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
          successMessage={saveState.successMessage}
          onSave={handleSaveClick}
          onDiscard={() => {
            setPacingErrors({});
            setState(saveState.discard());
          }}
        />
      </div>
    </DocFormGate>
  );
}
