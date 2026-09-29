/**
 * "Where jobs come from" section — combines the lane checkboxes
 * (profile.json's `lanes` field) with the search-URL row editor
 * (`SearchUrlsCard` over `search_urls.md`, plain markdown text — not
 * JSON, so it round-trips via `configDocQuery`/`useConfigMutation`
 * directly, never `useDocForm`).
 *
 * Spans TWO documents like `WhereYouWorkSection.tsx` does, so this follows
 * the same shape: one combined editor state, nested `DocFormGate`s (never
 * a skeleton shaped like the real form), one `useSectionSaveState` +
 * `SaveBar` for both cards together.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { configDocQuery } from '../config.queries';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useRegisterSettingsSave } from '../save/SettingsSaveContext';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { ValidationSummary } from '../save/ValidationSummary';
import { useConfigMutation } from '../useConfigMutation';
import { useDocForm } from '../useDocForm';
import { LANES, LanesCard } from './LanesCard';
import { SearchUrlsCard } from './SearchUrlsCard';
import { classifyRowsForDisplay } from './searchUrlRow.classify';
import type { SearchUrlRow } from './searchUrls.model';
import { parseSearchUrlRows, serializeSearchUrlRows } from './searchUrls.model';
import {
  buildRefiledRows,
  buildSearchUrlsSuccessMessage,
  reseedRowsFromText,
  splitSearchUrlsSaveError,
} from './searchUrlsSave';
import { validateSearchUrlRows } from './searchUrlsValidate';
import { useSearchUrlRowEditing } from './useSearchUrlRowEditing';

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

export function WhereJobsComeFromSection({ profile }: { profile: string }) {
  const profileForm = useDocForm(profile, 'profile.json');
  const searchUrlsQuery = useQuery(configDocQuery(profile, 'search_urls.md'));
  const searchUrlsMutation = useConfigMutation(profile, 'search_urls.md');

  const [state, setState] = useState<WhereJobsComeFromState>(EMPTY_STATE);
  const [savedState, setSavedState] = useState<WhereJobsComeFromState>(EMPTY_STATE);
  // B1/B2 fix (QA settings-overhaul): bumped only on a real failed Save
  // click — see `ValidationSummary`'s own `attempt` doc comment.
  const [attempt, setAttempt] = useState(0);
  // R13 Re-file: its own local state, separate from `saveState` entirely —
  // `onRefile` calls `searchUrlsMutation` directly, bypassing
  // `saveState.save()` (Contract).
  const [isRefiling, setIsRefiling] = useState(false);
  const [refileSuccessMessage, setRefileSuccessMessage] = useState<string | null>(null);

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

  // B7/B8 fixes (QA search-link-intake) live in this hook — see its own
  // doc comment. Extracted purely to keep this orchestrator under its
  // file-size cap.
  const rowEditing = useSearchUrlRowEditing(state.rows, updateRow);

  function onChangeLabel(index: number, label: string) {
    updateRow(index, { label });
  }

  function onRemoveNow(index: number) {
    removeRow(index);
  }

  // PUT-echo re-seed (HIGH — the server may store DIFFERENT text than what
  // was PUT, e.g. re-filed/cleaned/merged): the mutation's own resolved
  // response, never the locally-submitted text, is what `rows` reseeds
  // from. Swallows the rejection here (`mutation.error` already carries it
  // for the render below) so `useSectionSaveState`'s `Promise.all` never
  // rejects.
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
    validate: (value) => validateSearchUrlRows(value.rows),
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
        rowEditing.clearRecentlyCleaned();
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
    // Clears a lingering Refile success line before a normal Save — see
    // `refileSuccessMessage`'s own priority note below.
    setRefileSuccessMessage(null);
    const ok = await saveState.save();
    if (!ok) setAttempt((n) => n + 1);
    return ok;
  }

  // The raw wire-format `refused: <url> — ...` string is never shown
  // (ux-notes C4) — `searchUrlsMutation.error` only ever feeds
  // `mergeServerRefusal` below, never this plain-text line.
  const serverError = profileForm.serverError ?? null;

  // B3 fix (QA search-link-intake): `splitSearchUrlsSaveError`
  // (searchUrlsSave.ts) is the one place deciding "row error vs general
  // error" — a row-level FieldError/ValidationSummary entry only when the
  // server's message names one of the CURRENT rows' urls (a genuine R4
  // refusal); every other failure (5xx, network, or a 422 naming no
  // current row) becomes `searchUrlsGeneralError` instead, never
  // mis-blamed on a fine link. Covers both Save and Re-file, since both
  // PUT through this same mutation.
  const { validationErrors, generalError: searchUrlsGeneralError } =
    splitSearchUrlsSaveError(saveState.errors, state.rows, searchUrlsMutation.error);

  const successMessage = searchUrlsMutation.data?.report
    ? buildSearchUrlsSuccessMessage(searchUrlsMutation.data.report)
    : saveState.successMessage;

  // Re-surfaces the "cleaned" note `rowEditing`'s own `recentlyCleaned` map
  // captured — see `useSearchUrlRowEditing`'s doc comment for why
  // `classifyRowsForDisplay` alone can't.
  const displayStates = classifyRowsForDisplay(state.rows).map((d, i) => {
    if (d.kind !== 'clean') return d;
    const row = state.rows[i];
    if (!row) return d;
    const removedParams = rowEditing.getRecentlyCleaned(i, d.page, row.url);
    return removedParams && removedParams.length > 0
      ? { kind: 'cleaned' as const, page: d.page, label: d.label, removedParams }
      : d;
  });
  const misfiledCount = displayStates.filter((d) => d.kind === 'misfiled').length;

  // R13 Re-file (spec R13): `buildRefiledRows` (searchUrlsSave.ts) rewrites
  // every misfiled row; PUTs the result directly — bypassing
  // `saveState.save()` entirely, so a Refile never touches `profile.json`
  // or requires the Lanes card to be valid. `rows` re-seed both `state`
  // and `savedState` from the mutation's OWN resolved response (the same
  // PUT-echo fix as the normal save flow: a re-file can itself trigger a
  // merge) — but `lanes` is left out of both updates. Folding `state.lanes`
  // into `savedState` here would silently mark an unsaved lane toggle as
  // "saved" (isDirty/SaveBar both vanish) for a change Re-file never wrote.
  //
  // B2 fix (QA search-link-intake): guarded by `saveState.isDirty` — the
  // button that triggers this is already disabled while dirty
  // (`SearchUrlsCard`'s own `isDirty` prop), this is a defense-in-depth
  // backstop so Re-file can never commit an unsaved edit even if invoked
  // another way. B4 fix: wrapped in try/catch — a failed PUT (422/network)
  // now surfaces through `searchUrlsMutation.error` (the same B3 general-
  // /row-error split above) instead of an unhandled rejection.
  async function onRefile() {
    if (saveState.isDirty) return;
    setIsRefiling(true);
    try {
      const refiledRows = buildRefiledRows(state.rows, displayStates);
      const response = await searchUrlsMutation.mutateAsync(
        serializeSearchUrlRows(refiledRows),
      );
      const rows = reseedRowsFromText(response.text);
      setState((s) => ({ ...s, rows }));
      setSavedState((s) => ({ ...s, rows }));
      setRefileSuccessMessage(
        `Re-filed ${misfiledCount} link${misfiledCount === 1 ? '' : 's'}.`,
      );
    } catch {
      // Swallowed here — `searchUrlsMutation.error` (already set by
      // react-query before this rejection propagates) drives the B3
      // general-save-error alert below.
    } finally {
      setIsRefiling(false);
    }
  }

  return (
    <DocFormGate
      doc="profile.json"
      isLoading={profileForm.isLoading}
      loadError={profileForm.loadError}
      parseError={profileForm.parseError}
    >
      {/* B6 fix (QA search-link-intake): `search_urls.md`'s loading/error
          state is no longer a SECOND `DocFormGate` wrapping this whole
          subtree — that hid the Lanes card and the Search URLs card's own
          title/helper during a load. `SearchUrlsCard` now owns its own
          loading/error branch internally (`isLoading`/`loadError`/
          `onRetryLoad`), so the Lanes card and this card's chrome stay
          mounted the whole time, matching the mockup's S1 Loading view. */}
      <div className="flex flex-col gap-4">
        <ValidationSummary errors={validationErrors} attempt={attempt} />

        <LanesCard lanes={state.lanes} onToggle={toggleLane} />

        <SearchUrlsCard
          rows={state.rows}
          displayStates={displayStates}
          misfiledCount={misfiledCount}
          onRefile={onRefile}
          isRefiling={isRefiling}
          isDirty={saveState.isDirty}
          onChangeUrl={rowEditing.onChangeUrl}
          onChangeLabel={onChangeLabel}
          onBlurUrl={rowEditing.onBlurUrl}
          onRemove={removeRow}
          onRemoveNow={onRemoveNow}
          onAddRow={addRow}
          isLoading={searchUrlsQuery.isPending}
          loadError={searchUrlsQuery.error}
          onRetryLoad={() => searchUrlsQuery.refetch()}
        />

        {searchUrlsGeneralError && (
          <p
            data-qa="search-urls-save-error"
            data-testid="search-urls-save-error"
            className="text-sm text-destructive"
          >
            {searchUrlsGeneralError}
          </p>
        )}

        {serverError && (
          <p data-testid="settings-error" className="text-sm text-destructive">
            {serverError}
          </p>
        )}

        <SaveBar
          isDirty={saveState.isDirty}
          successMessage={refileSuccessMessage ?? successMessage}
          onSave={handleSaveClick}
          onDiscard={() => setState(saveState.discard())}
        />
      </div>
    </DocFormGate>
  );
}
