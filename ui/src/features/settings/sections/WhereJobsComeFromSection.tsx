/**
 * "Where jobs come from" section (blueprint.md:790-797, step 17's component
 * half) — merges TWO pieces of existing UI into one section: the lane
 * checkboxes that used to live on the old per-profile section
 * (profile.json's `lanes` field) and the search-URL row editor that lives on
 * `SearchUrlsSection.tsx` (search_urls.md, plain markdown text — not JSON,
 * so it round-trips via `configDocQuery`/`useConfigMutation` directly, same
 * seam `SearchUrlsSection.tsx` already uses, never `useDocForm`). The old
 * per-profile section is now deleted (task 23); `SearchUrlsSection.tsx`
 * itself stays UNCHANGED and unmounted-but-not-deleted — see
 * task-17-brief's TASK section.
 *
 * Spans TWO documents like `WhereYouWorkSection.tsx` (task 11) does, so this
 * follows the same shape: one combined editor state, nested `DocFormGate`s
 * (never a skeleton shaped like the real form), one `useSectionSaveState` +
 * `SaveBar` for both cards together.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { configDocQuery } from '../config.queries';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useRegisterSettingsSave } from '../save/SettingsSaveContext';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { ValidationSummary } from '../save/ValidationSummary';
import { useConfigMutation } from '../useConfigMutation';
import { useDocForm } from '../useDocForm';
import type { SearchUrlRow } from './searchUrls.model';
import {
  isSlugCovered,
  parseSearchUrlRows,
  serializeSearchUrlRows,
} from './searchUrls.model';

// Lifted UNCHANGED from the old (now-deleted) per-profile section's lane list.
const LANES = ['linkedin', 'greenhouse', 'keka'] as const;

const DEFAULT_SLUG = 'linkedin__jobs-search';
const PROTOCOL_MESSAGE = 'Enter a LinkedIn URL starting with https://';
const HOST_MESSAGE = 'That URL is not a linkedin.com address.';
const LABEL_MESSAGE = 'Give this search a short label.';
const COVERAGE_MESSAGE =
  'No page inventory exists for this page type yet — run /page-analyse.';

// Lifted UNCHANGED from the old (now-deleted) per-profile section's array-coercion helper.
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

interface WhereJobsComeFromState {
  lanes: string[];
  rows: SearchUrlRow[];
}

const EMPTY_STATE: WhereJobsComeFromState = { lanes: [], rows: [] };

// Lifted UNCHANGED from `SearchUrlsSection.tsx`'s own `validateRow`.
function validateRow(row: SearchUrlRow): string | undefined {
  const url = row.url.trim();
  if (url === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return PROTOCOL_MESSAGE;
  }
  if (parsed.protocol !== 'https:') return PROTOCOL_MESSAGE;
  if (parsed.hostname !== 'linkedin.com' && !parsed.hostname.endsWith('.linkedin.com')) {
    return HOST_MESSAGE;
  }
  if (row.label.trim() === '') return LABEL_MESSAGE;
  return undefined;
}

// Keyed `where-jobs-search-urls.{i}` — the lanes card has nothing to
// validate (a checkbox is valid by construction).
function validateState(state: WhereJobsComeFromState): Record<string, string> {
  const errors: Record<string, string> = {};
  state.rows.forEach((row, i) => {
    const message = validateRow(row);
    if (message) errors[`where-jobs-search-urls.${i}`] = message;
  });
  return errors;
}

export function WhereJobsComeFromSection({ profile }: { profile: string }) {
  const profileForm = useDocForm(profile, 'profile.json');
  const searchUrlsQuery = useQuery(configDocQuery(profile, 'search_urls.md'));
  const searchUrlsMutation = useConfigMutation(profile, 'search_urls.md');

  const [state, setState] = useState<WhereJobsComeFromState>(EMPTY_STATE);
  const [savedState, setSavedState] = useState<WhereJobsComeFromState>(EMPTY_STATE);
  // B1/B2 fix (QA settings-overhaul): bumped only on a real failed Save
  // click — see `ValidationSummary`'s own `attempt` doc comment.
  const [attempt, setAttempt] = useState(0);

  // Same "seed once both docs have loaded, never on a later background
  // refetch" posture as `WhereYouWorkSection.tsx`.
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (profileForm.isLoading || profileForm.value == null) return;
    if (!searchUrlsQuery.isSuccess) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const parsed: WhereJobsComeFromState = {
      lanes: asStringArray(profileForm.value.lanes).filter((l) =>
        (LANES as readonly string[]).includes(l),
      ),
      rows: parseSearchUrlRows(searchUrlsQuery.data.text),
    };
    setState(parsed);
    setSavedState(parsed);
  }, [
    profile,
    profileForm.isLoading,
    profileForm.value,
    searchUrlsQuery.isSuccess,
    searchUrlsQuery.data,
  ]);

  function toggleLane(lane: string) {
    setState((prev) => ({
      ...prev,
      lanes: prev.lanes.includes(lane)
        ? prev.lanes.filter((l) => l !== lane)
        : [...prev.lanes, lane],
    }));
  }

  function updateRow(index: number, patch: Partial<SearchUrlRow>) {
    setState((prev) => ({
      ...prev,
      rows: prev.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  }

  function addRow() {
    setState((prev) => ({
      ...prev,
      rows: [...prev.rows, { slug: DEFAULT_SLUG, label: '', url: '' }],
    }));
  }

  function removeRow(index: number) {
    setState((prev) => ({ ...prev, rows: prev.rows.filter((_, i) => i !== index) }));
  }

  // Mirrors `SearchUrlsSection.tsx`'s own `handleSave`: swallow the
  // rejection here (`mutation.error` already carries it for the render
  // below) so `useSectionSaveState`'s `Promise.all` never rejects.
  async function saveSearchUrls(text: string): Promise<boolean> {
    try {
      await searchUrlsMutation.mutateAsync(text);
      return true;
    } catch {
      return false;
    }
  }

  const saveState = useSectionSaveState({
    profile,
    initialValue: savedState,
    currentValue: state,
    validate: validateState,
    onSave: async (value) => {
      const [profileOk, searchUrlsOk] = await Promise.all([
        // Same "keep any unknown lane name, replace only the three known
        // ones" split the old (now-deleted) profile section's `handleSave` used to do.
        profileForm.save((cfg) => {
          const otherLanes = asStringArray(cfg.lanes).filter(
            (l) => !(LANES as readonly string[]).includes(l),
          );
          cfg.lanes = [...otherLanes, ...value.lanes];
        }),
        saveSearchUrls(serializeSearchUrlRows(value.rows)),
      ]);
      const ok = profileOk && searchUrlsOk;
      if (ok) setSavedState(value);
      return ok;
    },
  });

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

  const serverError =
    profileForm.serverError ?? searchUrlsMutation.error?.message ?? null;

  return (
    <DocFormGate
      doc="profile.json"
      isLoading={profileForm.isLoading}
      loadError={profileForm.loadError}
      parseError={profileForm.parseError}
    >
      <DocFormGate
        doc="search_urls.md"
        isLoading={searchUrlsQuery.isPending}
        loadError={searchUrlsQuery.error}
        parseError={false}
      >
        <div className="flex flex-col gap-4">
          <ValidationSummary errors={saveState.errors} attempt={attempt} />

          <Card data-qa="where-jobs-lanes-card">
            <CardHeader>
              <CardTitle>Lanes</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              {LANES.map((lane) => (
                <label key={lane} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={state.lanes.includes(lane)}
                    onChange={() => toggleLane(lane)}
                  />
                  {lane}
                </label>
              ))}
            </CardContent>
          </Card>

          <Card data-qa="where-jobs-search-urls-card">
            <CardHeader>
              <CardTitle>Search URLs</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-3">
                {state.rows.map((row, index) => {
                  const rowError = validateRow(row);
                  return (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: SearchUrlRow carries no stable id in the model
                      key={index}
                      className="flex flex-col gap-1 rounded-lg border border-border p-3"
                    >
                      <div className="flex gap-2">
                        <Field
                          id={`where-jobs-search-urls.${index}`}
                          invalid={Boolean(rowError)}
                          className="flex-1"
                        >
                          <FieldLabel>Search URL</FieldLabel>
                          <FieldControl>
                            <Input
                              value={row.url}
                              onChange={(e) => updateRow(index, { url: e.target.value })}
                            />
                          </FieldControl>
                          <FieldError>{rowError}</FieldError>
                        </Field>
                        <Field className="w-48">
                          <FieldLabel>Label</FieldLabel>
                          <FieldControl>
                            <Input
                              value={row.label}
                              onChange={(e) =>
                                updateRow(index, { label: e.target.value })
                              }
                            />
                          </FieldControl>
                        </Field>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove search URL"
                          onClick={() => removeRow(index)}
                        >
                          <span aria-hidden="true">×</span>
                        </Button>
                      </div>
                      {row.url.trim() !== '' && !isSlugCovered(row.slug) && (
                        <p className="text-sm text-attention-strong">
                          {COVERAGE_MESSAGE}
                        </p>
                      )}
                      <Badge variant="outline">{row.slug}</Badge>
                    </div>
                  );
                })}
              </div>
              <Button type="button" variant="outline" onClick={addRow}>
                Add another search URL
              </Button>
            </CardContent>
          </Card>

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
