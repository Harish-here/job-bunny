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
import { Skeleton } from '../../../components/ui/skeleton';
import { ChipInput } from '../ChipInput';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useGuardedNavigate, useRegisterSettingsSave } from '../save/SettingsSaveContext';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { ValidationSummary } from '../save/ValidationSummary';
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

// B9 fix (QA settings-overhaul, round 2): this screen still rendered the
// bare `DocFormGate` default "Loading…" line — mirrors the three real
// `Card`s below (`roles-rules-card`, `roles-prefs-card`,
// `companies-avoid-card`) field-for-field, same posture as
// `WhereYouWorkSection.tsx`'s own `WhereYouWorkSkeleton`.
function RolesCompaniesSkeleton() {
  return (
    <div data-testid="roles-companies-skeleton" className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-72" />
          <Skeleton className="h-3 w-56" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-80" />
          <Skeleton className="h-3 w-64" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

export function RolesCompaniesSection({ profile }: { profile: string }) {
  const filterForm = useDocForm(profile, 'filter.json');
  const profileForm = useDocForm(profile, 'profile.json');
  const guardedNavigate = useGuardedNavigate();

  const [state, setState] = useState<RolesCompaniesEditorState>(EMPTY_STATE);
  const [savedState, setSavedState] = useState<RolesCompaniesEditorState>(EMPTY_STATE);
  // B1/B2 fix (QA settings-overhaul): bumped only on a real failed Save
  // click — see `ValidationSummary`'s own `attempt` doc comment. This
  // section's own `validate` never fails, so it is wired only for
  // consistency with every other `SaveBar` consumer.
  const [attempt, setAttempt] = useState(0);

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
      const ok = filterOk && profileOk;
      if (ok) setSavedState(value);
      return ok;
    },
  });

  // Lifts this section's live dirty state into the shared
  // `SettingsSaveContext` — `SettingsShell`'s nav guard and `Shell.tsx`'s
  // sidebar guard both read it. See that module's own doc comment.
  useRegisterSettingsSave({
    isDirty: saveState.isDirty,
    save: saveState.save,
    discard: () => setState(saveState.discard()),
  });

  async function handleSaveClick(): Promise<boolean> {
    const ok = await saveState.save();
    if (!ok) setAttempt((n) => n + 1);
    return ok;
  }

  const serverError = filterForm.serverError ?? profileForm.serverError;

  return (
    <DocFormGate
      doc="filter.json"
      isLoading={filterForm.isLoading}
      loadError={filterForm.loadError}
      parseError={filterForm.parseError}
      loadingFallback={<RolesCompaniesSkeleton />}
    >
      <DocFormGate
        doc="profile.json"
        isLoading={profileForm.isLoading}
        loadError={profileForm.loadError}
        parseError={profileForm.parseError}
        loadingFallback={<RolesCompaniesSkeleton />}
      >
        <div className="flex flex-col gap-4">
          <ValidationSummary errors={saveState.errors} attempt={attempt} />

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
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() =>
                    guardedNavigate({ name: 'settings', section: 'raw-config' })
                  }
                >
                  Raw config →
                </button>
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

          {/* `filterForm.value ?? {}` is defensive only — this render path
           * is nested inside `filterForm`'s own `DocFormGate` above, which
           * never renders `children` while `filterForm.value` is `null`
           * (loading/error/parse-error all short-circuit first). */}
          <RulePreviewStrip
            profile={profile}
            baseDoc={filterForm.value ?? {}}
            draft={state}
          />

          {serverError && (
            <p data-testid="settings-error" className="text-sm text-destructive">
              {serverError}
            </p>
          )}

          <SaveBar
            isDirty={saveState.isDirty}
            successMessage={saveState.successMessage}
            onSave={handleSaveClick}
            onDiscard={() => setState(saveState.discard())}
          />
        </div>
      </DocFormGate>
    </DocFormGate>
  );
}
