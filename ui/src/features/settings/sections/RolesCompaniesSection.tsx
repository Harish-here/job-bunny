/**
 * "Roles & companies" screen (blueprint.md:729-747, step 13) — the second
 * appearance of the "Rules vs Preferences" Aim idiom task 11 established
 * for "Where you'll work". Three `Card`s: `roles-rules-card` (filter.json's
 * `title`, reused UNCHANGED via FiltersSection's own exported
 * `TitleRuleEditor` — same reuse discipline task 12 applies to the skills
 * block), `roles-prefs-card` (NEW fields: profile.json's
 * `settings.rank.title.domainKeywords` / `.seniority.targets`, currently
 * unsurfaced anywhere else, edited with the shared `ChipInput`),
 * `companies-avoid-card` (NEW field: filter.json's `companies.avoid`, a
 * deliberate pass-through per `filters.model.ts`'s own doc comment — this
 * section is the first to read/write it).
 *
 * Point weights and denominators (`title.maxPoints`/`.neutralPoints`,
 * `seniority.maxPoints`) are raw-only (R8's scope boundary) — this section
 * never form-edits them; `rolesCompanies.model.ts`'s apply function
 * preserves them by spreading, never overwriting.
 *
 * `RulePreviewStrip.tsx` (task 14, `data-qa="rule-preview-strip"`) mounts
 * here, right after `companies-avoid-card` and before the save bar — the
 * position the mockup fragment (task 27's `mockup-fragment.html`) renders
 * it in, fed the current (unsaved) draft `state` so it always previews what
 * the user is about to save, not the last-saved value.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { ChipInput } from '../ChipInput';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { useDocForm } from '../useDocForm';
import { TitleRuleEditor } from './FiltersSection';
import { TITLE_RULE_KEYS } from './filters.model';
import { RulePreviewStrip } from './RulePreviewStrip';
import {
  applyRolesCompaniesEditorState,
  parseRolesCompaniesDoc,
  type RolesCompaniesEditorState,
} from './rolesCompanies.model';

const EMPTY_STATE = parseRolesCompaniesDoc({}, {});

// Every field owned by this screen is a plain chip list (or the reused,
// already-valid title rule) — there is nothing here that can be invalid by
// construction, same posture as WhereYouWorkSection's own Preferences card.
function validateRolesCompaniesEditorState(): Record<string, string> {
  return {};
}

function isRulesEmpty(title: RolesCompaniesEditorState['title']): boolean {
  return TITLE_RULE_KEYS.every(
    (key) => title[key].match.length === 0 && title[key].reject.length === 0,
  );
}

export function RolesCompaniesSection({ profile }: { profile: string }) {
  const filterForm = useDocForm(profile, 'filter.json');
  const profileForm = useDocForm(profile, 'profile.json');

  const [state, setState] = useState<RolesCompaniesEditorState>(EMPTY_STATE);
  const [savedState, setSavedState] = useState<RolesCompaniesEditorState>(EMPTY_STATE);

  // Mirrors WhereYouWorkSection's own `initialized` ref pattern, extended
  // to BOTH docs: seeds the draft (and its saved baseline) once both have
  // loaded, never on a later background refetch.
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (filterForm.isLoading || filterForm.value == null) return;
    if (profileForm.isLoading || profileForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const parsed = parseRolesCompaniesDoc(filterForm.value, profileForm.value);
    setState(parsed);
    setSavedState(parsed);
  }, [
    profile,
    filterForm.isLoading,
    filterForm.value,
    profileForm.isLoading,
    profileForm.value,
  ]);

  // Empty state (ux-notes §12): when every title match/reject list is
  // empty, a blank rule set reads ambiguously — "no rule at all" vs "a
  // permissive rule with nothing typed in yet" mean opposite things on a
  // config surface. `rulesRevealed` is UI-only (never written to `state`):
  // clicking [Add] seeds one empty, focused chip input into the DOM
  // without mutating the draft itself, exactly like locations.length === 0
  // reads as an intentional "no location rule" until the user types one.
  const [rulesRevealed, setRulesRevealed] = useState(false);
  const rulesEmpty = isRulesEmpty(state.title);
  const showRuleEditors = !rulesEmpty || rulesRevealed;
  const rulesContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rulesRevealed) return;
    const input = rulesContainerRef.current?.querySelector('input');
    (input as HTMLInputElement | null)?.focus();
  }, [rulesRevealed]);

  const saveState = useSectionSaveState({
    profile,
    initialValue: savedState,
    currentValue: state,
    validate: validateRolesCompaniesEditorState,
    onSave: async (value) => {
      const [filterOk, profileOk] = await Promise.all([
        filterForm.save((doc) => applyRolesCompaniesEditorState('filter', doc, value)),
        profileForm.save((doc) => applyRolesCompaniesEditorState('profile', doc, value)),
      ]);
      if (filterOk && profileOk) setSavedState(value);
    },
  });

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
          <Card data-qa="roles-rules-card">
            <CardHeader>
              <CardTitle>Rules — a job that fails these is dropped</CardTitle>
              <CardDescription>
                Applied during <code>filter</code>. (<code>filter.json.title</code>)
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {showRuleEditors ? (
                <div ref={rulesContainerRef} className="flex flex-col gap-3">
                  {TITLE_RULE_KEYS.map((key) => (
                    <TitleRuleEditor
                      key={key}
                      ruleKey={key}
                      rule={state.title[key]}
                      onChange={(rule) =>
                        setState((prev) => ({
                          ...prev,
                          title: { ...prev.title, [key]: rule },
                        }))
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
                  <span className="text-sm text-muted-foreground">
                    No rules — nothing is dropped for this reason
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRulesRevealed(true)}
                  >
                    Add
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card data-qa="roles-prefs-card">
            <CardHeader>
              <CardTitle>
                Preferences — these change the order, never drop anything
              </CardTitle>
              <CardDescription>
                Applied during <code>rank</code>. (
                <code>profile.json → settings.rank</code>)
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-sm leading-none font-medium">Domain keywords</span>
                <ChipInput
                  ariaLabel="Domain keyword preference"
                  values={state.domainKeywords}
                  onAdd={(v) =>
                    setState((prev) => ({
                      ...prev,
                      domainKeywords: [...prev.domainKeywords, v],
                    }))
                  }
                  onRemove={(v) =>
                    setState((prev) => ({
                      ...prev,
                      domainKeywords: prev.domainKeywords.filter((k) => k !== v),
                    }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm leading-none font-medium">
                  Seniority targets
                </span>
                <ChipInput
                  ariaLabel="Seniority target preference"
                  values={state.seniorityTargets}
                  onAdd={(v) =>
                    setState((prev) => ({
                      ...prev,
                      seniorityTargets: [...prev.seniorityTargets, v],
                    }))
                  }
                  onRemove={(v) =>
                    setState((prev) => ({
                      ...prev,
                      seniorityTargets: prev.seniorityTargets.filter((t) => t !== v),
                    }))
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Point weights for these live in{' '}
                <a href="#/settings/raw-config" className="text-primary hover:underline">
                  Raw config →
                </a>
              </p>
            </CardContent>
          </Card>

          <Card data-qa="companies-avoid-card">
            <CardHeader>
              <CardTitle>Companies to avoid</CardTitle>
              <CardDescription>
                <code>filter.json.companies</code>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChipInput
                ariaLabel="Companies to avoid"
                values={state.companiesAvoid}
                onAdd={(v) =>
                  setState((prev) => ({
                    ...prev,
                    companiesAvoid: [...prev.companiesAvoid, v],
                  }))
                }
                onRemove={(v) =>
                  setState((prev) => ({
                    ...prev,
                    companiesAvoid: prev.companiesAvoid.filter((c) => c !== v),
                  }))
                }
              />
            </CardContent>
          </Card>

          <RulePreviewStrip profile={profile} draft={state} />

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
          />
        </div>
      </DocFormGate>
    </DocFormGate>
  );
}
