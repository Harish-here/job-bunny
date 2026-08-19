/** Edits exactly the seven owned resume.json keys via useDocForm's mutate
 * callback — every other key survives by construction (resume.json has no
 * schema — see this brief's Rationale). The settings-section wrapper and
 * JsonEscapeHatch are SettingsPage-owned (task 7); renders neither. */
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { DocFormGate } from '../DocFormGate';
import { useDocForm } from '../useDocForm';

interface ResumeForm {
  currentYoeText: string;
  targetSeniority: string[];
  coreSkills: string[];
  secondarySkills: string[];
  preferredWorkType: string[];
  location: string[];
  domainExperience: string[];
}

const YOE_MESSAGE = 'Enter years of experience as a whole number from 0 to 60.';

const EMPTY_FORM: ResumeForm = {
  currentYoeText: '',
  targetSeniority: [],
  coreSkills: [],
  secondarySkills: [],
  preferredWorkType: [],
  location: [],
  domainExperience: [],
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function formFromValue(value: Record<string, unknown>): ResumeForm {
  const yoe = value.current_yoe;
  return {
    currentYoeText: typeof yoe === 'number' ? String(yoe) : '',
    targetSeniority: asStringArray(value.target_seniority),
    coreSkills: asStringArray(value.core_skills),
    secondarySkills: asStringArray(value.secondary_skills),
    preferredWorkType: asStringArray(value.preferred_work_type),
    location: asStringArray(value.location),
    domainExperience: asStringArray(value.domain_experience),
  };
}

function applyForm(value: Record<string, unknown>, form: ResumeForm): void {
  const trimmed = form.currentYoeText.trim();
  value.current_yoe = trimmed === '' ? null : Number(trimmed);
  value.target_seniority = form.targetSeniority;
  value.core_skills = form.coreSkills;
  value.secondary_skills = form.secondarySkills;
  value.preferred_work_type = form.preferredWorkType;
  value.location = form.location;
  value.domain_experience = form.domainExperience;
}

function validateResumeForm(form: ResumeForm): string | null {
  const trimmed = form.currentYoeText.trim();
  if (trimmed !== '' && !(/^\d+$/.test(trimmed) && Number(trimmed) <= 60)) {
    return YOE_MESSAGE;
  }
  return null;
}

/** A small, locally-owned chip control on Badge + Input + Button — not
 * extracted from Step3About.tsx. See task-10-brief's Rationale. */
function ChipEditor({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm leading-none font-medium">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Badge key={value} variant="secondary">
            <span>{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((v) => v !== value))}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          aria-label={`Add to ${label}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const trimmed = draft.trim();
            if (trimmed !== '' && !values.includes(trimmed))
              onChange([...values, trimmed]);
            setDraft('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

export function ResumeSection({ profile }: { profile: string }) {
  const doc = useDocForm(profile, 'resume.json');
  const [form, setForm] = useState<ResumeForm>(EMPTY_FORM);

  // Reset only once the doc's initial load completes, mirroring
  // FiltersSection's own ref-guarded precedent: `doc.value` is a fresh
  // object every render (useDocForm re-parses `rawText` on each call), so
  // an effect keyed on it directly without a guard would re-fire and
  // re-`setForm` every render, never settling.
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (doc.isLoading || doc.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    setForm(formFromValue(doc.value));
  }, [profile, doc.isLoading, doc.value]);

  const yoeError = validateResumeForm(form);

  function update(patch: Partial<ResumeForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  async function handleSave() {
    if (yoeError) return;
    await doc.save((value) => applyForm(value, form));
  }

  return (
    <DocFormGate
      doc="resume.json"
      isLoading={doc.isLoading}
      loadError={doc.loadError}
      parseError={doc.parseError}
    >
      <div className="flex flex-col gap-4">
        <Field invalid={Boolean(yoeError)}>
          <FieldLabel>Current years of experience</FieldLabel>
          <FieldControl>
            <Input
              value={form.currentYoeText}
              onChange={(e) => update({ currentYoeText: e.target.value })}
            />
          </FieldControl>
          <FieldError>{yoeError}</FieldError>
        </Field>
        <ChipEditor
          label="Target seniority"
          values={form.targetSeniority}
          onChange={(v) => update({ targetSeniority: v })}
        />
        <ChipEditor
          label="Core skills"
          values={form.coreSkills}
          onChange={(v) => update({ coreSkills: v })}
        />
        <ChipEditor
          label="Secondary skills"
          values={form.secondarySkills}
          onChange={(v) => update({ secondarySkills: v })}
        />
        <ChipEditor
          label="Preferred work type"
          values={form.preferredWorkType}
          onChange={(v) => update({ preferredWorkType: v })}
        />
        <ChipEditor
          label="Location"
          values={form.location}
          onChange={(v) => update({ location: v })}
        />
        <ChipEditor
          label="Domain experience"
          values={form.domainExperience}
          onChange={(v) => update({ domainExperience: v })}
        />
        <Button
          type="button"
          disabled={doc.isSaving || Boolean(yoeError)}
          onClick={handleSave}
        >
          Save
        </Button>
        {doc.serverError && <p data-testid="settings-error">{doc.serverError}</p>}
      </div>
    </DocFormGate>
  );
}
