import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { getConfigDoc } from '../../settings/config.api';
import { deriveFilter } from '../deriveFilter';
import { serializeFilter, serializeResume } from '../serialize';
import { validateAbout } from '../validate';
import { getPersonas, writeConfigDocText } from '../wizard.api';
import { wizardKeys } from '../wizard.queries';
import type {
  AboutAnswers,
  WizardLocation,
  WizardStepProps,
  WorkType,
} from '../wizard.types';

const WORK_TYPES: WorkType[] = ['onsite', 'hybrid', 'remote'];
const WORK_TYPE_LABEL: Record<WorkType, string> = {
  onsite: 'Onsite',
  hybrid: 'Hybrid',
  remote: 'Remote',
};
// Fallback pool when no persona is picked (the 'scratch' persona pre-fills
// nothing, and the catalog may still be loading) — a generic seniority
// ladder, not tied to any one persona.
const DEFAULT_SENIORITY_OPTIONS = [
  'Junior',
  'Mid',
  'Senior',
  'Staff',
  'Lead',
  'Principal',
];

/** A doc counts as "real pre-existing config" once its trimmed text is
 * neither empty nor the seeded `'{}'` placeholder — shared by the
 * never-clobber guard's filter.json AND resume.json reads so a
 * /setup-seeded resume.json with real content blocks the save exactly
 * like a hand-edited filter.json would. */
function hasExistingContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== '' && trimmed !== '{}';
}

type ChipListKey = 'coreSkills' | 'secondarySkills' | 'domainExperience';

/** A removable-chip list with a free-text add row. Composed from Badge +
 * Input + Button — no new `components/ui` primitive is added. */
function ChipListEditor({
  legend,
  values,
  onAdd,
  onRemove,
}: {
  legend: string;
  values: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm leading-none font-medium">{legend}</span>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Badge key={value} variant="secondary">
            <span>{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onRemove(value)}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          aria-label={`Add to ${legend}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onAdd(draft);
            setDraft('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

export function Step3About({ draft, onDraftChange, registerSubmit }: WizardStepProps) {
  const profile = draft.profile;

  // WizardStepProps carries no resolved `persona` — this step owns its own
  // GET /api/personas query (see Rationale), sharing task 10's Step2Persona
  // query key so this is a cache hit, not a second network round trip.
  const personasQuery = useQuery({
    queryKey: wizardKeys.personas(),
    queryFn: getPersonas,
  });
  const persona = useMemo(
    () => personasQuery.data?.personas.find((p) => p.id === draft.personaId) ?? null,
    [personasQuery.data, draft.personaId],
  );

  const [about, setAbout] = useState<AboutAnswers>(draft.about);
  const [yoeText, setYoeText] = useState(
    draft.about.yoe == null ? '' : String(draft.about.yoe),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [existingConfig, setExistingConfig] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  function update(next: AboutAnswers) {
    setAbout(next);
    // Every field edit persists into the draft immediately — never only on
    // a successful submit — which is what makes "Back never loses input"
    // true (progress.md's frozen "Back and resume" rule).
    onDraftChange({ ...draft, about: next });
  }

  // Pre-fill core/secondary skill chips from the persona chosen in step 2,
  // once the catalog resolves — never re-applied on a later persona change
  // or after the user has deliberately cleared the chips.
  const prefilled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefill fires once, when persona resolves
  useEffect(() => {
    if (prefilled.current || persona == null) return;
    prefilled.current = true;
    if (about.coreSkills.length === 0 && about.secondarySkills.length === 0) {
      update({
        ...about,
        coreSkills: persona.coreSkills,
        secondarySkills: persona.secondarySkills,
      });
    }
  }, [persona]);

  function addToChipList(key: ChipListKey, value: string) {
    const trimmed = value.trim();
    if (trimmed === '' || about[key].includes(trimmed)) return;
    update({ ...about, [key]: [...about[key], trimmed] } as AboutAnswers);
  }

  function removeFromChipList(key: ChipListKey, value: string) {
    update({
      ...about,
      [key]: about[key].filter((v) => v !== value),
    } as AboutAnswers);
  }

  function toggleSeniority(value: string) {
    const has = about.seniority.includes(value);
    update({
      ...about,
      seniority: has
        ? about.seniority.filter((v) => v !== value)
        : [...about.seniority, value],
    });
  }

  function toggleWorkType(wt: WorkType) {
    const has = about.workTypes.includes(wt);
    update({
      ...about,
      workTypes: has ? about.workTypes.filter((w) => w !== wt) : [...about.workTypes, wt],
    });
  }

  function handleYoeChange(value: string) {
    setYoeText(value);
    const trimmed = value.trim();
    const isValid = /^\d+$/.test(trimmed) && Number(trimmed) <= 60;
    update({ ...about, yoe: isValid ? Number(trimmed) : null });
  }

  const homeLocation: WizardLocation = about.locations[0] ?? { city: '', country: '' };
  const additionalLocations = about.locations.slice(1);

  function updateHome(patch: Partial<WizardLocation>) {
    const home = { ...homeLocation, ...patch };
    update({ ...about, locations: [home, ...about.locations.slice(1)] });
  }

  function updateAdditional(index: number, patch: Partial<WizardLocation>) {
    const next = about.locations.map((loc, i) =>
      i === index ? { ...loc, ...patch } : loc,
    );
    update({ ...about, locations: next });
  }

  function addLocation() {
    const base = about.locations.length > 0 ? about.locations : [homeLocation];
    update({ ...about, locations: [...base, { city: '', country: '' }] });
  }

  function removeLocationAt(index: number) {
    update({ ...about, locations: about.locations.filter((_, i) => i !== index) });
  }

  const seniorityPool = useMemo(() => {
    const base =
      persona != null && persona.seniorityOptions.length > 0
        ? persona.seniorityOptions
        : DEFAULT_SENIORITY_OPTIONS;
    const extra = about.seniority.filter((value) => !base.includes(value));
    return [...base, ...extra];
  }, [persona, about.seniority]);

  // Pure and synchronous — recomputed on every render from the live `about`
  // state, so the advanced disclosure is always exactly what a save would
  // write. No debounce, no separate "preview" state to drift.
  const derived = useMemo(() => deriveFilter({ persona, about }), [persona, about]);
  const derivedText = useMemo(() => serializeFilter(derived), [derived]);

  // Registered with the shell via `registerSubmit`; `WizardPage`'s Next
  // button calls this, advances on `true`, and renders any rejection's
  // message in the single shell-level `wizard-error` alert. Field-level
  // validation and the never-clobber guard's own stop resolve `false` and
  // stay entirely inside this step's own `FieldError`s / the
  // `wizard-existing-config` notice — only a write failure is a "shell"
  // failure, surfaced by letting the rejection propagate uncaught.
  const handleSubmit = useCallback(async (): Promise<boolean> => {
    const errors = validateAbout({
      yoe: yoeText,
      homeCity: homeLocation.city,
      workTypes: about.workTypes,
    });
    // flushSync: handleSubmit is invoked imperatively by WizardPage's Next
    // handler (and directly by tests), outside any React-controlled event,
    // so a plain setState here would otherwise flush on React's own
    // scheduler timing — after the caller's single `await` already
    // resumed. flushSync guarantees the field-error DOM is committed
    // before this function's returned promise settles.
    flushSync(() => setFieldErrors(errors));
    if (Object.keys(errors).length > 0) return false;

    setExistingConfig(false);
    // Never-clobber guard: read filter.json AND resume.json BEFORE either
    // write, so a blocked save issues zero PUTs, not a half-written
    // resume.json — this step writes both, and resume.json is written
    // first, so either document already carrying real content must block
    // the save. Skipped once THIS session has already written them once
    // (`draft.wroteAbout`): re-reading after our own prior write would
    // otherwise see our own non-empty documents and block forever, which
    // is exactly what made Back-then-Next unable to ever advance again.
    if (!draft.wroteAbout) {
      const [filterDoc, resumeDoc] = await Promise.all([
        getConfigDoc(profile, 'filter.json'),
        getConfigDoc(profile, 'resume.json'),
      ]);
      if (hasExistingContent(filterDoc.text) || hasExistingContent(resumeDoc.text)) {
        flushSync(() => setExistingConfig(true));
        return false;
      }
    }
    await writeConfigDocText(profile, 'resume.json', serializeResume(about));
    await writeConfigDocText(profile, 'filter.json', derivedText);
    onDraftChange({ ...draft, about, wroteAbout: true });
    return true;
  }, [draft, onDraftChange, profile, about, yoeText, homeLocation.city, derivedText]);

  useEffect(() => {
    registerSubmit(handleSubmit);
    return () => registerSubmit(null);
  }, [handleSubmit, registerSubmit]);

  return (
    <div className="flex flex-col gap-6">
      <ChipListEditor
        legend="Core skills"
        values={about.coreSkills}
        onAdd={(value) => addToChipList('coreSkills', value)}
        onRemove={(value) => removeFromChipList('coreSkills', value)}
      />
      <ChipListEditor
        legend="Secondary skills"
        values={about.secondarySkills}
        onAdd={(value) => addToChipList('secondarySkills', value)}
        onRemove={(value) => removeFromChipList('secondarySkills', value)}
      />
      <ChipListEditor
        legend="Domain experience"
        values={about.domainExperience}
        onAdd={(value) => addToChipList('domainExperience', value)}
        onRemove={(value) => removeFromChipList('domainExperience', value)}
      />

      <div className="flex flex-col gap-1.5">
        <span className="text-sm leading-none font-medium">Seniority</span>
        <div className="flex flex-wrap gap-1.5">
          {seniorityPool.map((value) => (
            <Badge
              key={value}
              asChild
              variant={about.seniority.includes(value) ? 'default' : 'outline'}
            >
              <button
                type="button"
                aria-pressed={about.seniority.includes(value)}
                onClick={() => toggleSeniority(value)}
              >
                {value}
              </button>
            </Badge>
          ))}
        </div>
      </div>

      <Field invalid={Boolean(fieldErrors.yoe)}>
        <FieldLabel>Years of experience</FieldLabel>
        <FieldControl>
          <Input value={yoeText} onChange={(e) => handleYoeChange(e.target.value)} />
        </FieldControl>
        <FieldError>{fieldErrors.yoe}</FieldError>
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm leading-none font-medium">Work type</span>
        <div className="flex flex-wrap gap-3">
          {/* Frozen (progress.md, "Frozen UI labels and controls"): checkboxes
              labelled exactly Onsite / Hybrid / Remote — task 9's e2e suite
              queries them by role="checkbox" and this exact accessible name. */}
          {WORK_TYPES.map((wt) => (
            <label key={wt} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={about.workTypes.includes(wt)}
                onChange={() => toggleWorkType(wt)}
              />
              {WORK_TYPE_LABEL[wt]}
            </label>
          ))}
        </div>
        {fieldErrors.workTypes && (
          <p className="text-sm text-destructive">{fieldErrors.workTypes}</p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <Field invalid={Boolean(fieldErrors.homeCity)} className="flex-1">
            <FieldLabel>Home city</FieldLabel>
            <FieldControl>
              <Input
                value={homeLocation.city}
                onChange={(e) => updateHome({ city: e.target.value })}
              />
            </FieldControl>
            <FieldError>{fieldErrors.homeCity}</FieldError>
          </Field>
          <Field className="flex-1">
            <FieldLabel>Country</FieldLabel>
            <FieldControl>
              <Input
                value={homeLocation.country}
                onChange={(e) => updateHome({ country: e.target.value })}
              />
            </FieldControl>
          </Field>
        </div>

        {additionalLocations.map((loc, i) => {
          const index = i + 1;
          return (
            <div key={index} className="flex items-end gap-3">
              <Field className="flex-1">
                <FieldLabel>{`Additional city ${index}`}</FieldLabel>
                <FieldControl>
                  <Input
                    value={loc.city}
                    onChange={(e) => updateAdditional(index, { city: e.target.value })}
                  />
                </FieldControl>
              </Field>
              <Field className="flex-1">
                <FieldLabel>{`Additional country ${index}`}</FieldLabel>
                <FieldControl>
                  <Input
                    value={loc.country}
                    onChange={(e) => updateAdditional(index, { country: e.target.value })}
                  />
                </FieldControl>
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeLocationAt(index)}
              >
                Remove
              </Button>
            </div>
          );
        })}

        <Button type="button" variant="outline" size="sm" onClick={addLocation}>
          Add another location
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? 'Hide derived filter rules' : 'Show derived filter rules'}
        </Button>
        {showAdvanced && (
          <pre
            data-testid="wizard-derived-json"
            className="rounded-lg border border-border bg-card p-3 text-xs"
          >
            {derivedText}
          </pre>
        )}
      </div>

      {existingConfig && (
        <p data-testid="wizard-existing-config" className="text-sm text-destructive">
          This profile already has filter rules. Edit them in Settings.
        </p>
      )}
    </div>
  );
}
