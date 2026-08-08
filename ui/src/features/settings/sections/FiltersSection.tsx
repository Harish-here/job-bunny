import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useDocForm } from '../useDocForm';
import {
  applyFilterEditorState,
  type FilterEditorState,
  type FilterLocation,
  parseFilterDoc,
  type Severity,
  TITLE_RULE_KEYS,
  type TitleRuleKey,
  validateFilterEditorState,
  type WorkType,
} from './filters.model';

const WORK_TYPES: WorkType[] = ['onsite', 'hybrid', 'remote'];
const TITLE_RULE_LABEL: Record<TitleRuleKey, string> = {
  domain: 'Domain',
  function: 'Function',
  seniority: 'Seniority',
};

function ChipRow({
  values,
  onAdd,
  onRemove,
  ariaLabel,
}: {
  values: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex flex-col gap-1.5">
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
          aria-label={ariaLabel}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const trimmed = draft.trim();
            if (trimmed !== '' && !values.includes(trimmed)) onAdd(trimmed);
            setDraft('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function TitleRuleEditor({
  ruleKey,
  rule,
  onChange,
}: {
  ruleKey: TitleRuleKey;
  rule: FilterEditorState['title'][TitleRuleKey];
  onChange: (next: FilterEditorState['title'][TitleRuleKey]) => void;
}) {
  const label = TITLE_RULE_LABEL[ruleKey];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <span className="text-sm leading-none font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">Match</span>
      <ChipRow
        ariaLabel={`Add to ${label} match`}
        values={rule.match}
        onAdd={(v) => onChange({ ...rule, match: [...rule.match, v] })}
        onRemove={(v) => onChange({ ...rule, match: rule.match.filter((m) => m !== v) })}
      />
      <span className="text-xs text-muted-foreground">Reject</span>
      <ChipRow
        ariaLabel={`Add to ${label} reject`}
        values={rule.reject}
        onAdd={(v) => onChange({ ...rule, reject: [...rule.reject, v] })}
        onRemove={(v) =>
          onChange({ ...rule, reject: rule.reject.filter((m) => m !== v) })
        }
      />
      <label className="flex items-center gap-1.5 text-sm">
        Severity
        <select
          aria-label={`${label} severity`}
          value={rule.severity}
          onChange={(e) => onChange({ ...rule, severity: e.target.value as Severity })}
          className="h-7 rounded-lg border border-input bg-transparent px-2 text-sm"
        >
          <option value="hard">hard</option>
          <option value="soft">soft</option>
        </select>
      </label>
    </div>
  );
}

function LocationRow({
  location,
  onChange,
  onRemove,
  cityError,
  workTypesError,
}: {
  location: FilterLocation;
  onChange: (next: FilterLocation) => void;
  onRemove: () => void;
  cityError?: string;
  workTypesError?: string;
}) {
  function toggleWorkType(wt: WorkType) {
    const has = location.workTypes.includes(wt);
    onChange({
      ...location,
      workTypes: has
        ? location.workTypes.filter((w) => w !== wt)
        : [...location.workTypes, wt],
    });
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex gap-2">
        <Input
          aria-label="Location city"
          value={location.city}
          onChange={(e) => onChange({ ...location, city: e.target.value })}
        />
        <Input
          aria-label="Location country"
          value={location.country}
          onChange={(e) => onChange({ ...location, country: e.target.value })}
        />
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {cityError && <p className="text-sm text-destructive">{cityError}</p>}
      <div className="flex gap-3">
        {WORK_TYPES.map((wt) => (
          <label key={wt} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={location.workTypes.includes(wt)}
              onChange={() => toggleWorkType(wt)}
            />
            {wt}
          </label>
        ))}
      </div>
      {workTypesError && <p className="text-sm text-destructive">{workTypesError}</p>}
    </div>
  );
}

// Filters → filter.json's title/locations/skills; companies and
// timezones are preserved untouched (filters.model.ts never reads
// them). filter.json's locations[] is the sole geo authority in this
// system — see Rationale for why this is a first-class form, not JSON.
export function FiltersSection({ profile }: { profile: string }) {
  const docForm = useDocForm(profile, 'filter.json');
  const [state, setState] = useState<FilterEditorState>(() => parseFilterDoc({}));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (docForm.isLoading || docForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    setState(parseFilterDoc(docForm.value));
  }, [profile, docForm.isLoading, docForm.value]);

  function updateTitleRule(
    key: TitleRuleKey,
    rule: FilterEditorState['title'][TitleRuleKey],
  ) {
    setState((prev) => ({ ...prev, title: { ...prev.title, [key]: rule } }));
  }
  function updateLocation(index: number, next: FilterLocation) {
    setState((prev) => ({
      ...prev,
      locations: prev.locations.map((l, i) => (i === index ? next : l)),
    }));
  }
  function addLocation() {
    setState((prev) => ({
      ...prev,
      locations: [...prev.locations, { city: '', country: '', workTypes: [] }],
    }));
  }
  function removeLocation(index: number) {
    setState((prev) => ({
      ...prev,
      locations: prev.locations.filter((_, i) => i !== index),
    }));
  }

  async function handleSave() {
    const fieldErrors = validateFilterEditorState(state);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;
    await docForm.save((cfg) => applyFilterEditorState(cfg, state));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <span className="text-sm leading-none font-medium">Title rules</span>
        {TITLE_RULE_KEYS.map((key) => (
          <TitleRuleEditor
            key={key}
            ruleKey={key}
            rule={state.title[key]}
            onChange={(rule) => updateTitleRule(key, rule)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm leading-none font-medium">Locations</span>
        {state.locations.map((location, i) => (
          <LocationRow
            // biome-ignore lint/suspicious/noArrayIndexKey: FilterLocation carries no stable id in the model
            key={i}
            location={location}
            onChange={(next) => updateLocation(i, next)}
            onRemove={() => removeLocation(i)}
            cityError={errors[`locations.${i}.city`]}
            workTypesError={errors[`locations.${i}.workTypes`]}
          />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addLocation}>
          Add location
        </Button>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <span className="text-sm leading-none font-medium">Skills</span>
        <ChipRow
          ariaLabel="Add a core skill"
          values={state.skills.core}
          onAdd={(v) =>
            setState((prev) => ({
              ...prev,
              skills: { ...prev.skills, core: [...prev.skills.core, v] },
            }))
          }
          onRemove={(v) =>
            setState((prev) => ({
              ...prev,
              skills: { ...prev.skills, core: prev.skills.core.filter((c) => c !== v) },
            }))
          }
        />
        <label htmlFor="filters-min-match" className="flex items-center gap-1.5 text-sm">
          Minimum skill matches
          <Input
            id="filters-min-match"
            type="number"
            aria-label="Minimum skill matches"
            value={String(state.skills.minMatch)}
            onChange={(e) =>
              setState((prev) => ({
                ...prev,
                skills: { ...prev.skills, minMatch: Number(e.target.value) },
              }))
            }
          />
        </label>
        {errors['skills.minMatch'] && (
          <p className="text-sm text-destructive">{errors['skills.minMatch']}</p>
        )}
        <label className="flex items-center gap-1.5 text-sm">
          Severity
          <select
            aria-label="Skills severity"
            value={state.skills.severity}
            onChange={(e) =>
              setState((prev) => ({
                ...prev,
                skills: { ...prev.skills, severity: e.target.value as Severity },
              }))
            }
            className="h-7 rounded-lg border border-input bg-transparent px-2 text-sm"
          >
            <option value="hard">hard</option>
            <option value="soft">soft</option>
          </select>
        </label>
      </div>
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
