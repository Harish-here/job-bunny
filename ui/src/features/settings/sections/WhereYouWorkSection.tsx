/**
 * "Where you'll work" screen (blueprint.md:683-706, step 11) — the first
 * appearance of the repeated "Rules vs Preferences" Aim idiom (later reused
 * by Roles & companies, task 13). Spans TWO documents: filter.json (Rules
 * card, `WhereYouWorkRulesCard.tsx`) and profile.json (Preferences card,
 * `WhereYouWorkPrefsCard.tsx`) — split into sibling files per the brief's
 * own file-size contingency; this file owns the composition, the
 * connective line and the conflict notice (the one piece that genuinely
 * spans both cards).
 *
 * The conflict notice never skeletons: it mounts only once BOTH docs have
 * resolved (nested `DocFormGate`s below), never as a placeholder mid-load —
 * a red/amber-shaped skeleton would misrepresent severity before the real
 * data has even arrived.
 */
import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '../../../components/ui/alert';
import { Button } from '../../../components/ui/button';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { useDocForm } from '../useDocForm';
import { WhereYouWorkPrefsCard } from './WhereYouWorkPrefsCard';
import { WhereYouWorkRulesCard } from './WhereYouWorkRulesCard';
import {
  applyWhereYouWorkFilterState,
  applyWhereYouWorkProfileState,
  computeTimezoneConflict,
  parseWhereYouWorkDoc,
  validateWhereYouWorkEditorState,
  type WhereYouWorkEditorState,
} from './whereYouWork.model';

const EMPTY_STATE = parseWhereYouWorkDoc({}, {});

const HARD_CONFLICT_ACTIONS = ['Add to rule', 'Remove from preference'] as const;

export function WhereYouWorkSection({ profile }: { profile: string }) {
  const filterForm = useDocForm(profile, 'filter.json');
  const profileForm = useDocForm(profile, 'profile.json');

  const [state, setState] = useState<WhereYouWorkEditorState>(EMPTY_STATE);
  const [savedState, setSavedState] = useState<WhereYouWorkEditorState>(EMPTY_STATE);

  // Mirrors FiltersSection's own `initialized` ref pattern, extended to
  // BOTH docs: seeds the draft (and its saved baseline) once both have
  // loaded, never on a later background refetch — an external `jobbunny
  // config set` never stomps an in-progress edit.
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (filterForm.isLoading || filterForm.value == null) return;
    if (profileForm.isLoading || profileForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const parsed = parseWhereYouWorkDoc(filterForm.value, profileForm.value);
    setState(parsed);
    setSavedState(parsed);
  }, [
    profile,
    filterForm.isLoading,
    filterForm.value,
    profileForm.isLoading,
    profileForm.value,
  ]);

  const conflicts = computeTimezoneConflict(state.timezonesRule, {
    acceptableTimezones: state.acceptableTimezones,
    borderlineTimezones: state.borderlineTimezones,
  });
  const hasConflict = conflicts.length > 0;

  const saveState = useSectionSaveState({
    profile,
    initialValue: savedState,
    currentValue: state,
    validate: validateWhereYouWorkEditorState,
    onSave: async (value) => {
      const [filterOk, profileOk] = await Promise.all([
        filterForm.save((doc) => applyWhereYouWorkFilterState(doc, value)),
        profileForm.save((doc) => applyWhereYouWorkProfileState(doc, value)),
      ]);
      if (filterOk && profileOk) setSavedState(value);
    },
  });

  function addToRule(tz: string) {
    setState((prev) => {
      const accept = prev.timezonesRule?.accept ?? [];
      if (accept.includes(tz)) return prev;
      return {
        ...prev,
        timezonesRule: {
          accept: [...accept, tz],
          severity: prev.timezonesRule?.severity ?? 'hard',
        },
      };
    });
  }
  function removeFromPreference(tz: string) {
    setState((prev) => ({
      ...prev,
      acceptableTimezones: prev.acceptableTimezones.filter((t) => t !== tz),
      borderlineTimezones: prev.borderlineTimezones.filter((t) => t !== tz),
    }));
  }

  const serverError = filterForm.serverError ?? profileForm.serverError;

  return (
    <DocFormGate
      doc="filter.json"
      isLoading={filterForm.isLoading}
      loadError={filterForm.loadError}
      parseError={filterForm.parseError}
    >
      <DocFormGate
        doc="profile.json"
        isLoading={profileForm.isLoading}
        loadError={profileForm.loadError}
        parseError={profileForm.parseError}
      >
        <div className="flex flex-col gap-4">
          <WhereYouWorkRulesCard
            locations={state.locations}
            onLocationsChange={(locations) =>
              setState((prev) => ({ ...prev, locations }))
            }
            timezonesRule={state.timezonesRule}
            onTimezonesRuleChange={(timezonesRule) =>
              setState((prev) => ({ ...prev, timezonesRule }))
            }
            errors={saveState.errors}
          />

          <p data-qa="geo-connective-line" className="text-sm">
            The same timezone can appear in both. As a rule it decides <b>whether</b> a
            job reaches you. As a preference it decides <b>where in the list</b> it lands.
          </p>

          {hasConflict && (
            <Alert
              data-qa="geo-conflict-notice"
              className="border-l-2 border-attention bg-attention/10"
            >
              <AlertTriangle className="text-attention" />
              <AlertDescription>
                <div className="flex flex-col gap-3">
                  {conflicts.map((conflict) => (
                    <div key={conflict.tz} className="flex flex-col gap-1.5">
                      <p className="text-sm">
                        <code>{conflict.tz}</code>{' '}
                        {conflict.severity === 'hard' ? (
                          <>
                            is ranked as acceptable, but your rule drops remote roles
                            outside the allowed timezones — so no job from it can reach
                            the board. Add it to the rule, or remove it from the
                            preference.
                          </>
                        ) : (
                          <>
                            is ranked as acceptable, but your rule only soft-flags
                            timezones outside the allowed list — it still reaches the
                            board, ranked lower.
                          </>
                        )}
                      </p>
                      {conflict.severity === 'hard' && (
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => addToRule(conflict.tz)}
                          >
                            {HARD_CONFLICT_ACTIONS[0]}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removeFromPreference(conflict.tz)}
                          >
                            {HARD_CONFLICT_ACTIONS[1]}
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </AlertDescription>
            </Alert>
          )}

          <WhereYouWorkPrefsCard
            homeCities={state.homeCities}
            onHomeCitiesChange={(homeCities) =>
              setState((prev) => ({ ...prev, homeCities }))
            }
            acceptableTimezones={state.acceptableTimezones}
            onAcceptableTimezonesChange={(acceptableTimezones) =>
              setState((prev) => ({ ...prev, acceptableTimezones }))
            }
            borderlineTimezones={state.borderlineTimezones}
            onBorderlineTimezonesChange={(borderlineTimezones) =>
              setState((prev) => ({ ...prev, borderlineTimezones }))
            }
            workTypePreference={state.workTypePreference}
            onWorkTypePreferenceChange={(workTypePreference) =>
              setState((prev) => ({ ...prev, workTypePreference }))
            }
          />

          {serverError && (
            <p data-testid="settings-error" className="text-sm text-destructive">
              {serverError}
            </p>
          )}

          <SaveBar
            isDirty={saveState.isDirty}
            errors={saveState.errors}
            successMessage={saveState.successMessage}
            onSave={saveState.save}
            onDiscard={() => setState(saveState.discard())}
            saveButtonVariant={hasConflict ? 'outline' : 'default'}
          />
        </div>
      </DocFormGate>
    </DocFormGate>
  );
}
