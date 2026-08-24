/**
 * Skills screen (blueprint.md:719-728, step 12) — an extraction, not a
 * redesign: the core-skills chip input, `minMatch` field and severity
 * select are lifted VERBATIM from `FiltersSection.tsx`'s own skills block.
 * The one substitution is the shared `ChipInput` (task 2) in place of that
 * file's inline `ChipRow`; everything else about the fields, labels and
 * behavior is unchanged. `FiltersSection.tsx` itself is untouched — its
 * own skills block stays where it is.
 *
 * Model reuse is non-negotiable: `parseFilterDoc`/`applyFilterEditorState`/
 * `validateFilterEditorState` are the SAME functions `FiltersSection.tsx`
 * already calls, unchanged. Title rules and locations are part of that
 * same `FilterEditorState`, so this section carries them through state
 * unedited (never rendered here) so a save never clobbers them — exactly
 * how `WhereYouWorkSection.tsx` (task 11) carries `title`/`companies`/
 * `timezones` in `filter.json` untouched.
 *
 * Single-card layout: unlike "Where you'll work"'s Rules/Preferences
 * split across two documents and two pipeline stages, every field here
 * lives in filter.json and applies during one stage (`filter`) — so this
 * follows the same titled-Card-with-subtitle-naming-the-stage heading
 * convention (task 11's reference shape) as a single card, not two.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { ChipInput } from '../ChipInput';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useRegisterSettingsSave } from '../save/SettingsSaveContext';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { useDocForm } from '../useDocForm';
import {
  applyFilterEditorState,
  type FilterEditorState,
  parseFilterDoc,
  type Severity,
  validateFilterEditorState,
} from './filters.model';

const EMPTY_STATE = parseFilterDoc({});

export function SkillsSection({ profile }: { profile: string }) {
  const docForm = useDocForm(profile, 'filter.json');

  const [state, setState] = useState<FilterEditorState>(EMPTY_STATE);
  const [savedState, setSavedState] = useState<FilterEditorState>(EMPTY_STATE);

  // Mirrors FiltersSection's own `initialized` ref pattern: seeds the
  // draft (and its saved baseline) once the doc has loaded, never on a
  // later background refetch — an external `jobbunny config set` never
  // stomps an in-progress edit.
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (docForm.isLoading || docForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const parsed = parseFilterDoc(docForm.value);
    setState(parsed);
    setSavedState(parsed);
  }, [profile, docForm.isLoading, docForm.value]);

  const saveState = useSectionSaveState({
    profile,
    initialValue: savedState,
    currentValue: state,
    validate: validateFilterEditorState,
    onSave: async (value) => {
      const ok = await docForm.save((cfg) => applyFilterEditorState(cfg, value));
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
      doc="filter.json"
      isLoading={docForm.isLoading}
      loadError={docForm.loadError}
      parseError={docForm.parseError}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Skills — a job that fails this is dropped</CardTitle>
            <CardDescription>
              Applied during <code>filter</code>. A dropped job never reaches your board.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <span className="text-sm leading-none font-medium">Skills</span>
            <ChipInput
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
                  skills: {
                    ...prev.skills,
                    core: prev.skills.core.filter((c) => c !== v),
                  },
                }))
              }
            />
            <label
              htmlFor="filters-min-match"
              className="flex items-center gap-1.5 text-sm"
            >
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
            {saveState.errors['skills.minMatch'] && (
              <p className="text-sm text-destructive">
                {saveState.errors['skills.minMatch']}
              </p>
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
