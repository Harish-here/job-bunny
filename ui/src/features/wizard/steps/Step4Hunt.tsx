/**
 * features/wizard/steps/Step4Hunt.tsx — wizard step 4, "Where to hunt":
 * collects LinkedIn saved-search URLs and turns on the lanes those URLs
 * (plus the always-keyless Greenhouse/Keka lanes) need. See task-6-brief
 * for the never-clobber guard and the lanes-enablement rationale.
 *
 * Chrome (the `wizard` container, header/Progress, the `wizard-step`
 * wrapper, the single `wizard-error` alert, and the `wizard-back`/
 * `wizard-next` footer) is owned by `WizardPage`, per the frozen
 * step-component contract — this step renders only its own fields, its
 * own `FieldError` messages, its per-row `wizard-url-warning`, and its
 * own `wizard-existing-config` notice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { getConfigDoc } from '../../settings/config.api';
import { serializeSearchUrls } from '../serialize';
import { validateUrlEntry } from '../validate';
import { patchProfileConfig, writeConfigDocText } from '../wizard.api';
import type { SearchUrlEntry, WizardStepProps } from '../wizard.types';

const JOBS_SEARCH_PATHNAME = '/jobs/search/';
const EXISTING_CONFIG_MESSAGE =
  'This profile already has search URLs. Edit them in Settings.';
const WARNING_MESSAGE =
  'This looks like a different LinkedIn page type; it will still be saved under ' +
  'linkedin__jobs-search.';

function emptyRow(): SearchUrlEntry {
  return { label: '', url: '' };
}

/** Non-blocking heads-up only: the URL still parses and validates fine, it
 * just isn't the `/jobs/search/` shape the wizard files everything under.
 * An unparseable URL is a validation ERROR (`validateUrlEntry`), handled
 * separately — this returns false rather than warn on garbage input. */
function isDifferentPageType(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (url === '') return false;
  try {
    return new URL(url).pathname !== JOBS_SEARCH_PATHNAME;
  } catch {
    return false;
  }
}

/** Mirrors the frozen never-clobber guard exactly: the seeded template
 * mentions the bullet only mid-sentence, in its format hint ("Format:
 * `  • <label> - <url>`") — it never starts a LINE with the bullet. A
 * real entry always starts its line with it, so checking the line start
 * (not a substring match anywhere in the line) is what distinguishes
 * seeded-but-empty from real content. */
function hasBulletLine(text: string): boolean {
  return text.split('\n').some((line) => line.trimStart().startsWith('• '));
}

export function Step4Hunt({ draft, onDraftChange, registerSubmit }: WizardStepProps) {
  const [errors, setErrors] = useState<Record<number, Record<string, string>>>({});
  const [existingConfig, setExistingConfig] = useState(false);

  // Always-fresh view of the latest props for the effects below, so
  // `handleSubmit`'s identity can stay stable across every keystroke.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Step 4 renders exactly ONE empty search-URL row on mount (frozen —
  // task 9's e2e fills row 0 without clicking Add first). A resumed draft
  // that already has rows is left untouched.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only seed; onDraftChange identity is not part of the "run once" contract
  useEffect(() => {
    if (draftRef.current.hunt.urls.length === 0) {
      onDraftChange({ ...draftRef.current, hunt: { urls: [emptyRow()] } });
    }
  }, []);

  const rows = draft.hunt.urls;

  function updateRow(index: number, patch: Partial<SearchUrlEntry>) {
    onDraftChange({
      ...draft,
      hunt: { urls: rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) },
    });
  }

  function addRow() {
    onDraftChange({ ...draft, hunt: { urls: [...rows, emptyRow()] } });
  }

  function removeRow(index: number) {
    onDraftChange({ ...draft, hunt: { urls: rows.filter((_, i) => i !== index) } });
    setErrors((prev) => {
      const next: Record<number, Record<string, string>> = {};
      for (const [key, value] of Object.entries(prev)) {
        const i = Number(key);
        if (i < index) next[i] = value;
        else if (i > index) next[i - 1] = value;
      }
      return next;
    });
  }

  // Validates, runs the never-clobber guard read (only when there is
  // something to write), then writes the document and the lanes patch.
  // Resolves `true` to advance, `false` to stay (validation errors and
  // the never-clobber notice render inline, in this step's own panel).
  // A write failure THROWS — `WizardPage` catches it and renders the
  // single, shell-owned `wizard-error` alert; this step never renders
  // that alert itself.
  const handleSubmit = useCallback(async (): Promise<boolean> => {
    setExistingConfig(false);

    const current = draftRef.current;
    const currentRows = current.hunt.urls;

    const nextErrors: Record<number, Record<string, string>> = {};
    let hasError = false;
    currentRows.forEach((row, index) => {
      const rowErrors = validateUrlEntry(row);
      if (Object.keys(rowErrors).length > 0) {
        nextErrors[index] = rowErrors;
        hasError = true;
      }
    });
    setErrors(nextErrors);
    if (hasError) return false;

    const entries = currentRows.filter((row) => row.url.trim() !== '');

    if (entries.length > 0) {
      const doc = await getConfigDoc(current.profile, 'search_urls.md');
      if (hasBulletLine(doc.text)) {
        setExistingConfig(true);
        return false;
      }
      await writeConfigDocText(
        current.profile,
        'search_urls.md',
        serializeSearchUrls(entries),
      );
    }

    await patchProfileConfig(current.profile, (cfg) => {
      cfg.lanes =
        entries.length > 0 ? ['linkedin', 'greenhouse', 'keka'] : ['greenhouse', 'keka'];
    });

    return true;
  }, []);

  useEffect(() => {
    registerSubmit(handleSubmit);
    return () => registerSubmit(null);
  }, [registerSubmit, handleSubmit]);

  if (existingConfig) {
    return (
      <p data-testid="wizard-existing-config" className="text-sm text-attention-strong">
        {EXISTING_CONFIG_MESSAGE}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-base font-medium">Where to hunt</h2>
        <p className="text-sm text-muted-foreground">
          Add your saved LinkedIn job searches below. Every URL is filed under the{' '}
          <Badge variant="outline">linkedin__jobs-search</Badge> page type, whose
          inventory lives at{' '}
          <code className="font-mono text-xs">
            src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json
          </code>
          . Greenhouse and Keka need nothing configured — company discovery is automatic —
          so this step is about to turn on the <strong>linkedin</strong>,{' '}
          <strong>greenhouse</strong>, and <strong>keka</strong> lanes. You can leave
          every row blank; the ATS lanes still work with zero URLs.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {rows.map((row, i) => {
          const index = i;
          const rowErrors = errors[index] ?? {};
          const warn = isDifferentPageType(row.url);
          return (
            <div
              key={index}
              data-testid="wizard-url-row"
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
            >
              <div className="flex gap-2">
                <Field invalid={Boolean(rowErrors.url)} className="flex-1">
                  <FieldLabel>Search URL</FieldLabel>
                  <FieldControl>
                    <Input
                      value={row.url}
                      onChange={(e) => updateRow(index, { url: e.target.value })}
                      placeholder="https://www.linkedin.com/jobs/search/?keywords=..."
                    />
                  </FieldControl>
                  <FieldError>{rowErrors.url}</FieldError>
                </Field>
                <Field invalid={Boolean(rowErrors.label)} className="w-48">
                  <FieldLabel>Label</FieldLabel>
                  <FieldControl>
                    <Input
                      value={row.label}
                      onChange={(e) => updateRow(index, { label: e.target.value })}
                      placeholder="Staff Frontend Engineer"
                    />
                  </FieldControl>
                  <FieldError>{rowErrors.label}</FieldError>
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
              {warn && (
                <p
                  data-testid="wizard-url-warning"
                  className="text-sm text-attention-strong"
                >
                  {WARNING_MESSAGE}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <Button type="button" variant="outline" onClick={addRow}>
        Add another search URL
      </Button>
    </div>
  );
}
