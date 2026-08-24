/**
 * "Raw config" settings section (blueprint.md:868-885, step 23's component
 * half) — the single consolidated raw-JSON/markdown editor that supersedes
 * the six per-section "Edit as JSON" dialogs the old per-section escape
 * hatch used to render (that escape hatch is deleted as part of this same
 * task). Two-pane layout: a doc list on the left, one inline editor on the
 * right, over the same `configDocQuery` + `useConfigMutation` seam that
 * escape hatch used (its read/write plumbing carried over unchanged,
 * blueprint.md:31-49) — rendered inline in the page instead of inside a
 * `Dialog`.
 *
 * Discoverability stays asymmetric BY DESIGN: this section is reachable in
 * exactly one click from the nav (Advanced group, task 22) and deliberately
 * unpromoted elsewhere. Do not add a call-to-action pointing at it from any
 * other section.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Textarea } from '../../../components/ui/textarea';
import type { SettingsSection } from '../../../lib/router';
import { cn } from '../../../lib/utils';
import type { ConfigDocName } from '../config.api';
import { configDocQuery } from '../config.queries';
import { SaveBar } from '../save/SaveBar';
import { useGuardedNavigate, useRegisterSettingsSave } from '../save/SettingsSaveContext';
import { ValidationSummary } from '../save/ValidationSummary';
import { useConfigMutation } from '../useConfigMutation';

const DOCS: readonly ConfigDocName[] = [
  'profile.json',
  'filter.json',
  'resume.json',
  'search_urls.md',
];

const DOC_DATA_QA: Record<ConfigDocName, string> = {
  'profile.json': 'raw-doc-profile-json',
  'filter.json': 'raw-doc-filter-json',
  'resume.json': 'raw-doc-resume-json',
  'search_urls.md': 'raw-doc-search-urls-md',
};

// Docs whose text is validated as JSON at save time — `search_urls.md`
// stays markdown and is never JSON-parsed or JSON-validated by this
// component.
const JSON_DOCS: ReadonlySet<ConfigDocName> = new Set([
  'profile.json',
  'filter.json',
  'resume.json',
]);

const EMPTY_DOC_MESSAGE = 'Not created yet — saving will create it';

interface RawKeyRoute {
  doc: ConfigDocName;
  key: string;
  dataQa: string;
  section: SettingsSection;
}

// Every key that has a form elsewhere in Settings. `where-you-work`,
// `roles-companies` and `where-jobs-come-from` join `SettingsSection`'s
// union only once the router/shell/nav switchover (task 22) lands — until
// then the literal isn't a member of the union, so the cast is required
// (same precedent as `LandingRulesSummary.tsx`'s `GROUP_SECTION` and
// `LandingCapsTable.tsx`'s `'fetching' as never`).
const RAW_KEY_ROUTES: RawKeyRoute[] = [
  {
    doc: 'profile.json',
    key: 'schedule',
    dataQa: 'raw-key-badge-schedule',
    section: 'schedule',
  },
  {
    doc: 'filter.json',
    key: 'locations',
    dataQa: 'raw-key-badge-locations',
    section: 'where-you-work' as never,
  },
  {
    doc: 'filter.json',
    key: 'companies',
    dataQa: 'raw-key-badge-companies',
    section: 'roles-companies' as never,
  },
  {
    doc: 'profile.json',
    key: 'lanes',
    dataQa: 'raw-key-badge-lanes',
    section: 'where-jobs-come-from' as never,
  },
];

// Cheap, best-effort line-number derivation from `JSON.parse`'s own
// `SyntaxError` message — V8 sometimes includes "line N", sometimes only
// "position N" (from which a line is countable via the draft text),
// sometimes neither. Never throws; falls back to the raw message.
function deriveParseErrorMessage(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lineMatch = message.match(/line (\d+)/i);
  if (lineMatch) return `Invalid JSON (line ${lineMatch[1]}): ${message}`;
  const positionMatch = message.match(/position (\d+)/i);
  if (positionMatch) {
    const position = Number(positionMatch[1]);
    const line = text.slice(0, position).split('\n').length;
    return `Invalid JSON (line ${line}): ${message}`;
  }
  return `Invalid JSON: ${message}`;
}

export function RawConfigSection({ profile }: { profile: string }) {
  const [selectedDoc, setSelectedDoc] = useState<ConfigDocName>('profile.json');
  const [draft, setDraft] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // B1/B2 fix (QA settings-overhaul): bumped only on a real failed Save
  // click — see `ValidationSummary`'s own `attempt` doc comment.
  const [attempt, setAttempt] = useState(0);

  const query = useQuery(configDocQuery(profile, selectedDoc));
  const mutation = useConfigMutation(profile, selectedDoc);
  const guardedNavigate = useGuardedNavigate();

  // Seed only when the selected (profile, doc) pair's text first loads — a
  // background refetch of the currently-selected doc never silently
  // clobbers mid-typing edits — the same anti-clobber rationale the escape
  // hatch this section replaced used to follow. Keyed on the PAIR, not just
  // `selectedDoc`: keying on the doc alone left the guard permanently
  // satisfied across a profile switch (the doc name doesn't change even
  // though the profile did), so the effect below never re-fired and this
  // section kept rendering — and, worse, was willing to PUT — the PRIOR
  // profile's text against the new one. See this brief's cross-profile
  // overwrite finding.
  const initializedFor = useRef<string | null>(null);
  const initializedKey = `${profile}:${selectedDoc}`;
  useEffect(() => {
    if (query.isLoading) return;
    if (initializedFor.current === initializedKey) return;
    initializedFor.current = initializedKey;
    setDraft(query.data?.text ?? '');
    setParseError(null);
    setSuccessMessage(null);
  }, [initializedKey, query.isLoading, query.data]);

  const ready = !query.isLoading && initializedFor.current === initializedKey;
  const savedText = query.data?.text ?? '';
  const isDirty = ready && draft !== savedText;

  /** Returns whether the save actually persisted — `false` on a parse
   * error or a failed PUT, never throws. `DirtyNavGuard`'s "Save and
   * continue" (via `useRegisterSettingsSave` below) only navigates away on
   * `true`, same contract every `useSectionSaveState`-backed section's
   * `save()` carries. */
  async function handleSave(): Promise<boolean> {
    setParseError(null);
    if (JSON_DOCS.has(selectedDoc) && draft.trim() !== '') {
      try {
        JSON.parse(draft);
      } catch (err) {
        setParseError(deriveParseErrorMessage(draft, err));
        return false;
      }
    }
    try {
      await mutation.mutateAsync(draft);
      setSuccessMessage('Saved.');
      return true;
    } catch {
      // mutation.isError renders inline below; rejection leaves the draft
      // in place, never stomping the user's edit.
      return false;
    }
  }

  function handleDiscard(): void {
    setDraft(savedText);
    setParseError(null);
  }

  useRegisterSettingsSave({
    isDirty,
    save: handleSave,
    discard: handleDiscard,
  });

  async function handleSaveClick(): Promise<boolean> {
    const ok = await handleSave();
    if (!ok) setAttempt((n) => n + 1);
    return ok;
  }

  const errors: Record<string, string> = parseError ? { 'raw-editor': parseError } : {};

  return (
    <div className="flex flex-col gap-4">
      <ValidationSummary errors={errors} attempt={attempt} />

      <div
        data-qa="raw-scope-banner"
        className="mb-4 rounded-lg bg-muted p-3 text-xs text-muted-foreground"
      >
        Only these have no form: ranking point weights and denominators, registry health
        thresholds, adapter settings. Everything else on this page has one.
      </div>

      <div className="flex gap-6">
        <div data-qa="raw-doc-list" className="flex shrink-0 flex-col gap-1">
          {DOCS.map((doc) => {
            const routes = RAW_KEY_ROUTES.filter((r) => r.doc === doc);
            return (
              <div
                key={doc}
                data-qa={DOC_DATA_QA[doc]}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm',
                  doc === selectedDoc && 'bg-accent',
                )}
              >
                <button
                  type="button"
                  className="flex-1 text-left"
                  onClick={() => setSelectedDoc(doc)}
                >
                  {doc}
                </button>
                <div className="flex gap-1">
                  {routes.map((route) => (
                    <Badge asChild key={route.dataQa} variant="outline">
                      <button
                        type="button"
                        data-qa={route.dataQa}
                        onClick={() =>
                          guardedNavigate({ name: 'settings', section: route.section })
                        }
                      >
                        has a form →
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Badge variant="outline" data-qa="raw-key-badge-rank-weights">
              raw only
            </Badge>
            <span className="text-xs text-muted-foreground">settings.rank weights</span>
          </div>
        </div>

        <div className="flex-1">
          <label htmlFor="raw-editor" className="mb-1.5 block text-xs font-medium">
            {selectedDoc}
          </label>
          {query.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              Couldn't load {selectedDoc}: {query.error.message}
            </p>
          ) : (
            <Textarea
              id="raw-editor"
              data-qa="raw-editor"
              aria-label={`${selectedDoc} raw text`}
              className="rounded-lg bg-muted p-3 font-mono"
              rows={14}
              placeholder={savedText === '' ? EMPTY_DOC_MESSAGE : undefined}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            Editing raw and reopening a form shows the new value with no reload. Save-time
            validation applies identically here; a JSON parse error renders in the same
            error summary, not as a toast.
          </p>
        </div>
      </div>

      {mutation.isError && (
        <p data-testid="settings-error" className="text-sm text-destructive">
          {mutation.error.message}
        </p>
      )}

      <SaveBar
        isDirty={isDirty}
        successMessage={successMessage}
        onSave={handleSaveClick}
        onDiscard={handleDiscard}
      />
    </div>
  );
}
