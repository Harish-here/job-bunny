/**
 * "Where jobs come from" section (blueprint.md:790-797, step 17's component
 * half) — merges TWO pieces of existing UI into one section: the lane
 * checkboxes that used to live on the old per-profile section
 * (profile.json's `lanes` field) and the search-URL row editor, now
 * `SearchUrlsCard` (task 21) over `search_urls.md`, plain markdown text —
 * not JSON, so it round-trips via `configDocQuery`/`useConfigMutation`
 * directly, same seam `SearchUrlsSection.tsx` already uses, never
 * `useDocForm`. `SearchUrlsSection.tsx` itself stays UNCHANGED and
 * unmounted-but-not-deleted — see task-17-brief's TASK section.
 *
 * Spans TWO documents like `WhereYouWorkSection.tsx` (task 11) does, so this
 * follows the same shape: one combined editor state, nested `DocFormGate`s
 * (never a skeleton shaped like the real form), one `useSectionSaveState` +
 * `SaveBar` for both cards together.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { classifyLinkedInSearchUrl } from '../../../../../src/core/linkedin_url/index.ts';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { laneLabel } from '../../../lib/vocabulary';
import { configDocQuery } from '../config.queries';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useRegisterSettingsSave } from '../save/SettingsSaveContext';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { ValidationSummary } from '../save/ValidationSummary';
import { useConfigMutation } from '../useConfigMutation';
import { useDocForm } from '../useDocForm';
import { SearchUrlsCard } from './SearchUrlsCard';
import {
  buildValidationSummaryRefusalMessage,
  classifyRowsForDisplay,
  PROTOCOL_MESSAGE,
} from './searchUrlRow.classify';
import type { SearchUrlRow } from './searchUrls.model';
import { parseSearchUrlRows, serializeSearchUrlRows } from './searchUrls.model';
import {
  buildSearchUrlsSuccessMessage,
  mergeServerRefusal,
  reseedRowsFromText,
} from './searchUrlsSave';

// Lifted UNCHANGED from the old (now-deleted) per-profile section's lane list.
const LANES = ['linkedin', 'greenhouse', 'keka'] as const;

const LABEL_MESSAGE = 'Give this search a short label.';

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

// task 1's classifier (`classifyLinkedInSearchUrl`) is the single source of
// "is this a recognized LinkedIn search link" — the old HOST_MESSAGE branch
// is gone. PROTOCOL_MESSAGE (ux-notes C4: "keeps the protocol error") stays,
// imported from task 19's `searchUrlRow.classify` rather than duplicated
// locally. This function's return feeds `saveState.errors`/
// `ValidationSummary` only — the inline `FieldError` under each row comes
// from `classifyRowsForDisplay` (task 19/20) via `displayStates` below.
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
  try {
    classifyLinkedInSearchUrl(url);
  } catch {
    return buildValidationSummaryRefusalMessage(row.label);
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
  // refetch" posture as `WhereYouWorkSection.tsx`. ux-notes C12's
  // empty-state auto-add (one row, seeded blank) is folded in here rather
  // than living in its own effect: both effects would otherwise run in the
  // SAME commit off the SAME pre-update `state` closure (React only applies
  // queued `setState` calls after the whole effect flush), so a separate
  // effect reading `state.rows.length` at that point sees the stale
  // pre-seed value (always `0`, whatever the doc actually held) — racing a
  // spurious extra row onto an already non-empty load. Deciding off
  // `parsed.rows.length` directly, before either `setState` call, has no
  // such race, and still runs exactly once per profile (guarded by
  // `initialized` below, same as every other seed-once effect in this
  // codebase).
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (profileForm.isLoading || profileForm.value == null) return;
    if (!searchUrlsQuery.isSuccess) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const parsedRows = parseSearchUrlRows(searchUrlsQuery.data.text);
    const parsed: WhereJobsComeFromState = {
      lanes: asStringArray(profileForm.value.lanes).filter((l) =>
        (LANES as readonly string[]).includes(l),
      ),
      rows:
        parsedRows.length === 0
          ? [{ page: '', label: '', url: '', touched: false }]
          : parsedRows,
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
      rows: [...prev.rows, { page: '', label: '', url: '', touched: false }],
    }));
  }

  function removeRow(index: number) {
    setState((prev) => ({ ...prev, rows: prev.rows.filter((_, i) => i !== index) }));
  }

  // classifyAndRewrite (below) rewrites `row.url` to its OWN cleaned form
  // on success, per Contract — so re-classifying that already-clean value
  // a moment later (`classifyRowsForDisplay`, task 19) always finds zero
  // removedParams and reports `'clean'`, never `'cleaned'`: the "what got
  // removed" signal is otherwise lost the instant the rewrite lands. This
  // keeps it, keyed by the SAME `page|cleanedUrl` classifyRowsForDisplay
  // itself dedupes on (not by row index, which shifts under add/remove) —
  // a stale entry is simply never looked up again once a row's url moves
  // on to a different key.
  const recentlyCleaned = useRef<Map<string, string[]>>(new Map());

  // Shared by `onBlurUrl` and a detected paste (`onChangeUrl`'s `isPaste`
  // branch): classify + rewrite to the cleaned URL and resolved page on
  // success; on a refusal, leave the URL exactly as given (typed or
  // pasted) and just mark the row touched, per Contract.
  function classifyAndRewrite(index: number, url: string) {
    try {
      const classification = classifyLinkedInSearchUrl(url);
      if (classification.removedParams.length > 0) {
        recentlyCleaned.current.set(
          `${classification.page}|${classification.cleanedUrl}`,
          classification.removedParams,
        );
      }
      updateRow(index, {
        url: classification.cleanedUrl,
        page: classification.page,
        touched: true,
      });
    } catch {
      updateRow(index, { url, touched: true });
    }
  }

  function onBlurUrl(index: number) {
    const row = state.rows[index];
    if (!row) return;
    classifyAndRewrite(index, row.url);
  }

  // `isPaste` (from `SearchUrlRow`'s own `InputEvent.inputType ===
  // 'insertFromPaste'` gate) runs the same classify-and-rewrite immediately
  // — using the pasted value directly, never a stale `state` read — rather
  // than waiting for blur; an ordinary keystroke just updates the raw url.
  function onChangeUrl(index: number, url: string, isPaste?: boolean) {
    if (isPaste) {
      classifyAndRewrite(index, url);
      return;
    }
    updateRow(index, { url });
  }

  function onChangeLabel(index: number, label: string) {
    updateRow(index, { label });
  }

  function onRemoveNow(index: number) {
    removeRow(index);
  }

  // PUT-echo re-seed (HIGH — the server may store DIFFERENT text than what
  // was PUT, e.g. re-filed/cleaned/merged): the mutation's own resolved
  // response, never the locally-submitted text, is what `rows` reseeds
  // from. Mirrors `SearchUrlsSection.tsx`'s own `handleSave`: swallow the
  // rejection here (`mutation.error` already carries it for the render
  // below) so `useSectionSaveState`'s `Promise.all` never rejects.
  async function saveSearchUrls(
    text: string,
  ): Promise<{ ok: boolean; rows?: SearchUrlRow[] }> {
    try {
      const response = await searchUrlsMutation.mutateAsync(text);
      return { ok: true, rows: reseedRowsFromText(response.text) };
    } catch {
      return { ok: false };
    }
  }

  const saveState = useSectionSaveState({
    profile,
    initialValue: savedState,
    currentValue: state,
    validate: validateState,
    onSave: async (value) => {
      const [profileOk, searchUrlsResult] = await Promise.all([
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
      const ok = profileOk && searchUrlsResult.ok;
      if (ok) {
        // Both `state` AND `savedState` commit from the search-urls save's
        // returned `rows` — never `value.rows` — so the currently-displayed
        // rows match the DB with no reload required.
        const reseeded = {
          lanes: value.lanes,
          rows: searchUrlsResult.rows ?? value.rows,
        };
        setState(reseeded);
        setSavedState(reseeded);
        // Every reseeded row is server-normalized already — no stale
        // "cleaned" notes should carry over onto whatever these keys
        // happen to collide with next.
        recentlyCleaned.current.clear();
      }
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

  // The raw wire-format `refused: <url> — ...` string is never shown
  // (ux-notes C4) — `searchUrlsMutation.error` only ever feeds
  // `mergeServerRefusal` below, never this plain-text line.
  const serverError = profileForm.serverError ?? null;

  // Defense-in-depth backstop only: in normal operation `validateRow`
  // already blocks Save with identical text before any PUT is attempted.
  const validationErrors = searchUrlsMutation.error
    ? mergeServerRefusal(saveState.errors, state.rows, searchUrlsMutation.error.message)
    : saveState.errors;

  const successMessage = searchUrlsMutation.data?.report
    ? buildSearchUrlsSuccessMessage(searchUrlsMutation.data.report)
    : saveState.successMessage;

  // Re-surfaces the "cleaned" note `recentlyCleaned` captured above — see
  // its own doc comment for why `classifyRowsForDisplay` alone can't.
  const displayStates = classifyRowsForDisplay(state.rows).map((d, i) => {
    if (d.kind !== 'clean') return d;
    const row = state.rows[i];
    if (!row) return d;
    const removedParams = recentlyCleaned.current.get(`${d.page}|${row.url}`);
    return removedParams && removedParams.length > 0
      ? { kind: 'cleaned' as const, page: d.page, label: d.label, removedParams }
      : d;
  });
  const misfiledCount = displayStates.filter((d) => d.kind === 'misfiled').length;

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
          <ValidationSummary errors={validationErrors} attempt={attempt} />

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
                  {laneLabel(lane)}
                </label>
              ))}
            </CardContent>
          </Card>

          <SearchUrlsCard
            rows={state.rows}
            displayStates={displayStates}
            misfiledCount={misfiledCount}
            // R13 re-file wiring lands in task 24, which extends this same
            // file next — no misfiled rows are produced by this task's own
            // flows, so this is an inert stub until then.
            onRefile={() => {}}
            isRefiling={false}
            onChangeUrl={onChangeUrl}
            onChangeLabel={onChangeLabel}
            onBlurUrl={onBlurUrl}
            onRemove={removeRow}
            onRemoveNow={onRemoveNow}
            onAddRow={addRow}
          />

          {serverError && (
            <p data-testid="settings-error" className="text-sm text-destructive">
              {serverError}
            </p>
          )}

          <SaveBar
            isDirty={saveState.isDirty}
            successMessage={successMessage}
            onSave={handleSaveClick}
            onDiscard={() => setState(saveState.discard())}
          />
        </div>
      </DocFormGate>
    </DocFormGate>
  );
}
