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
 * Only `title` + `companiesAvoid` are sent — the two `RolesCompaniesEditorState`
 * fields that actually live in `filter.json` (the shape
 * `POST .../preview/filter` validates against, `core/filter`'s
 * `FilterConfigSchema`). `domainKeywords`/`seniorityTargets` live in
 * `profile.json` and never factor into `core/filter`'s drop decision, so
 * they are deliberately not part of the wire body; reusing
 * `applyRolesCompaniesEditorState('filter', ...)` to build it keeps this
 * component from re-deriving that shape by hand (one writer of the
 * draft->filter.json transform).
 */
import { useEffect, useState } from 'react';
import { postJson } from '../../../lib/api/client';
import type { FilterPreviewResult } from '../../../lib/api/types';
import {
  applyRolesCompaniesEditorState,
  type RolesCompaniesEditorState,
} from './rolesCompanies.model';

const PREVIEW_DEBOUNCE_MS = 300;

function buildDraftFilterBody(draft: RolesCompaniesEditorState): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  applyRolesCompaniesEditorState('filter', body, draft);
  return body;
}

export function RulePreviewStrip({
  profile,
  draft,
}: {
  profile: string;
  draft: RolesCompaniesEditorState;
}) {
  // `null` until the first response lands — the "request not yet made"
  // state (c) is this literal initial value, never a loading skeleton.
  const [result, setResult] = useState<FilterPreviewResult | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      postJson<FilterPreviewResult>(
        `/api/profiles/${encodeURIComponent(profile)}/preview/filter`,
        buildDraftFilterBody(draft),
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
  }, [profile, draft]);

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
