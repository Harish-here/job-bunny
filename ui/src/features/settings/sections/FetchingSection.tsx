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
import { useSectionSaveState } from '../save/useSectionSaveState';
import { useDocForm } from '../useDocForm';
import {
  type PacingPresetName,
  presetFromRanges,
  rangesFromPreset,
} from './fetching.model';
import { PacingAdvancedDisclosure, PacingPresetCard } from './PacingPresetCard';

interface FetchingState {
  maxNewPerLane: number;
  maxProbesPerRun: number;
  maxCardsPerUrl: number;
  maxAgeDays: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  interUrlDelayMinMs: number;
  interUrlDelayMaxMs: number;
}

// Same shipped defaults `LandingCapsTable.tsx`/`core/config/linkedin_pacing/
// index.ts` use — a profile with no `settings` block at all still shows the
// real in-force numbers, never a blank/zero.
const DEFAULTS: FetchingState = {
  maxNewPerLane: 40,
  maxProbesPerRun: 25,
  maxCardsPerUrl: 40,
  maxAgeDays: 30,
  jitterMinMs: 5_000,
  jitterMaxMs: 12_000,
  interUrlDelayMinMs: 20_000,
  interUrlDelayMaxMs: 45_000,
};

const EMPTY_STATE: FetchingState = DEFAULTS;

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

// Mirrors `LandingCapsTable.tsx`'s own resolver posture: anything other
// than a positive finite number falls back to the shipped default rather
// than a wrong/blank field.
function parseFetchingState(profileDoc: Record<string, unknown>): FetchingState {
  const settings = asRecord(profileDoc.settings);
  const source = asRecord(settings.source);
  const linkedin = asRecord(settings.linkedin);
  return {
    maxNewPerLane: positiveNumber(source.maxNewPerLane, DEFAULTS.maxNewPerLane),
    maxProbesPerRun: positiveNumber(source.maxProbesPerRun, DEFAULTS.maxProbesPerRun),
    maxCardsPerUrl: positiveNumber(linkedin.maxCardsPerUrl, DEFAULTS.maxCardsPerUrl),
    maxAgeDays: positiveNumber(linkedin.maxAgeDays, DEFAULTS.maxAgeDays),
    jitterMinMs: positiveNumber(linkedin.jitterMinMs, DEFAULTS.jitterMinMs),
    jitterMaxMs: positiveNumber(linkedin.jitterMaxMs, DEFAULTS.jitterMaxMs),
    interUrlDelayMinMs: positiveNumber(
      linkedin.interUrlDelayMinMs,
      DEFAULTS.interUrlDelayMinMs,
    ),
    interUrlDelayMaxMs: positiveNumber(
      linkedin.interUrlDelayMaxMs,
      DEFAULTS.interUrlDelayMaxMs,
    ),
  };
}

interface CapFieldDef {
  key: 'maxNewPerLane' | 'maxProbesPerRun' | 'maxCardsPerUrl' | 'maxAgeDays';
  dataQa: string;
  bounds: string;
  min: number;
  max: number;
  effect: (value: number) => string;
  /** Only `maxNewPerLane`/`maxCardsPerUrl` have a real hit signal on the
   * soft-errors response (`SoftErrorSummary.capsHit`) — `maxProbesPerRun`
   * and `maxAgeDays` never render the binding-marker clause. */
  hitKey: 'maxNewPerLane' | 'maxCardsPerUrl' | null;
}

const CAP_FIELDS: CapFieldDef[] = [
  {
    key: 'maxNewPerLane',
    dataQa: 'fetch-cap-max-new-per-lane',
    bounds: '1–500',
    min: 1,
    max: 500,
    effect: (v) => `At most ${v} new jobs from each lane per run.`,
    hitKey: 'maxNewPerLane',
  },
  {
    key: 'maxProbesPerRun',
    dataQa: 'fetch-cap-max-probes-per-run',
    bounds: '1–200',
    min: 1,
    max: 200,
    effect: (v) => `At most ${v} ATS probes per run.`,
    hitKey: null,
  },
  {
    key: 'maxCardsPerUrl',
    dataQa: 'fetch-cap-max-cards-per-url',
    bounds: '1–200',
    min: 1,
    max: 200,
    effect: (v) => `At most ${v} cards read per saved-search URL.`,
    hitKey: 'maxCardsPerUrl',
  },
  {
    key: 'maxAgeDays',
    dataQa: 'fetch-cap-max-age-days',
    bounds: '1–90',
    min: 1,
    max: 90,
    // Gates LinkedIn page-inventory freshness — NEVER "limits job count" (F10).
    effect: (v) => `Postings older than ${v} days are skipped.`,
    hitKey: null,
  },
];

function validateState(state: FetchingState): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of CAP_FIELDS) {
    const value = state[field.key];
    if (!Number.isFinite(value) || value < field.min || value > field.max) {
      errors[`fetching.${field.key}`] =
        `${field.key} must be between ${field.min} and ${field.max}.`;
    }
  }
  return errors;
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
    },
  });

  return (
    <DocFormGate
      doc="profile.json"
      isLoading={docForm.isLoading}
      loadError={docForm.loadError}
      parseError={docForm.parseError}
    >
      <div className="flex flex-col gap-4">
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
                <Field key={field.key} data-qa={field.dataQa} invalid={Boolean(error)}>
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
