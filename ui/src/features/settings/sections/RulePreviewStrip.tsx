/**
 * "Rule preview" strip (blueprint.md:748-761, step 14) — a small,
 * independently-mountable component that previews the CURRENT (unsaved)
 * `RolesCompaniesSection` draft against the last run's data, before the
 * user saves. It is built standalone here; `RolesCompaniesSection.tsx`'s
 * own doc comment already notes it "mounts alongside this section in a
 * later step of the overall build" — task 22's route switchover / task 13's
 * section composition is responsible for actually dropping it between the
 * rule list and the save bar, not this file.
 *
 * Debounced-on-change (mirrors `TriagePage.tsx`'s own `SEARCH_DEBOUNCE_MS`
 * idiom) rather than fire-on-blur — the draft spans three chip-input cards
 * plus the reused `TitleRuleEditor`, several of which have no natural
 * "blur the whole section" moment, so debouncing every draft change is the
 * more reliable of the two implementer-choice triggers the brief allows.
 *
 * The wire body is a FULL clone of `baseDoc` (the section's already-loaded
 * `filter.json`, e.g. `RolesCompaniesSection`'s own `filterForm.value`)
 * with the draft's `title`/`companiesAvoid` applied on top via
 * `applyRolesCompaniesEditorState('filter', ...)` — not a bare `{title,
 * companies}` object built from scratch. `board_preview.ts` evaluates this
 * body STANDALONE (never merged server-side with the stored config), and
 * `core/filter/engine.ts` drops a rule whose config section is absent
 * entirely, rather than treating it as "no restriction" — so a truncated
 * draft silently omitted every geo/timezone/skills drop the CURRENT
 * (baseline) evaluation includes, making the preview's delta wildly wrong
 * for any real profile (filter.json's `locations[]` is the sole geo
 * authority, CLAUDE.md, so every real profile has one). See this brief's
 * own fix-round finding. `domainKeywords`/`seniorityTargets` still never
 * appear in the body — those live in `profile.json`, not `filter.json`,
 * and never factor into `core/filter`'s drop decision.
 */
import { useEffect, useMemo, useState } from 'react';
import { postJson } from '../../../lib/api/client';
import type { FilterPreviewResult } from '../../../lib/api/types';
import {
  applyRolesCompaniesEditorState,
  type RolesCompaniesEditorState,
} from './rolesCompanies.model';

const PREVIEW_DEBOUNCE_MS = 300;

// `structuredClone` (not a shallow `{ ...baseDoc }`) — `applyRolesCompaniesEditorState`
// mutates `current.companies` via its own spread but assigns `current.title`
// wholesale; a shallow clone would still risk the caller's nested objects
// being shared if that ever changes. Cloning defensively here costs nothing
// on a doc this size and guarantees the caller's own `baseDoc` (e.g.
// `filterForm.value`, which other code may still be reading) is never
// mutated by this component.
function buildDraftFilterBody(
  baseDoc: Record<string, unknown>,
  draft: RolesCompaniesEditorState,
): Record<string, unknown> {
  const body = structuredClone(baseDoc);
  applyRolesCompaniesEditorState('filter', body, draft);
  return body;
}

export function RulePreviewStrip({
  profile,
  baseDoc,
  draft,
}: {
  profile: string;
  /** The section's already-loaded `filter.json` (e.g.
   * `RolesCompaniesSection`'s `filterForm.value`) — the preview body is
   * built as a full clone of this with the draft applied on top, never a
   * bare `{title, companies}` object. See this file's own doc comment. */
  baseDoc: Record<string, unknown>;
  draft: RolesCompaniesEditorState;
}) {
  // `null` until the first response lands — the "request not yet made"
  // state (c) is this literal initial value, never a loading skeleton.
  const [result, setResult] = useState<FilterPreviewResult | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Keyed on the SERIALIZED body, not `baseDoc`/`draft` object identity.
  // `RolesCompaniesSection`'s `baseDoc` prop is `useDocForm.value`, a fresh
  // `JSON.parse(rawText)` on every render of that section (even ones that
  // change nothing about the draft, e.g. an unrelated react-query refetch)
  // — an effect keyed on that object directly re-fires this debounced POST
  // on every such unrelated re-render (re-review finding). Re-running
  // `buildDraftFilterBody`/`JSON.stringify` themselves on every render is
  // cheap; what must NOT happen on unrelated churn is the network call, and
  // gating the effect on this string (structurally, not referentially,
  // stable across content-equal re-renders) achieves exactly that.
  const requestBodyKey = useMemo(
    () => JSON.stringify(buildDraftFilterBody(baseDoc, draft)),
    [baseDoc, draft],
  );

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      postJson<FilterPreviewResult>(
        `/api/profiles/${encodeURIComponent(profile)}/preview/filter`,
        JSON.parse(requestBodyKey) as Record<string, unknown>,
      )
        .then((data) => {
          if (!cancelled) setResult(data);
        })
        .catch(() => {
          // A preview failing is a narrow casualty (SoftError posture) —
          // the strip simply keeps showing whatever it last had (or stays
          // unmounted on a first-request failure), never a hard error for
          // the whole section.
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [profile, requestBodyKey]);

  if (result === null) return null;

  if (!result.available) {
    // Both `no_recent_run` and `checkpoint_expired` render the same muted
    // copy — the brief specs only one string, and both reasons mean the
    // same thing to the user: there is nothing to preview against.
    return (
      <div
        data-qa="rule-preview-strip"
        className="bg-muted p-3 rounded-lg text-sm text-muted-foreground"
      >
        No recent run to preview against.
      </div>
    );
  }

  const delta = result.draftDrops - result.baselineDrops;
  const deltaWord = delta >= 0 ? 'more' : 'fewer';

  return (
    <div data-qa="rule-preview-strip" className="bg-muted p-3 rounded-lg text-sm">
      <span>
        Against your last run ({result.totalJobs} jobs): this rule set would drop{' '}
        <b>{result.draftDrops}</b> — {Math.abs(delta)} {deltaWord} than the current one.{' '}
      </span>
      <button
        type="button"
        className="text-primary hover:underline"
        onClick={() => setExpanded((prev) => !prev)}
      >
        see which {result.newlyDropped.length} →
      </button>
      {expanded && (
        <ul className="mt-2 flex flex-col gap-1">
          {result.newlyDropped.map((job) => (
            <li key={`${job.title}::${job.company}`} className="text-muted-foreground">
              {job.title} — {job.company}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
