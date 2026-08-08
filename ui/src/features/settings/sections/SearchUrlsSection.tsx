/** Edits search_urls.md as a flat, slug-tagged row list; every row this
 * section does not touch still round-trips by slug, in original order.
 * search_urls.md is markdown, so useDocForm (JSON-shaped, task 7, frozen)
 * cannot express it: this section reads via configDocQuery and writes via
 * useConfigMutation directly instead — see Global constraints. The
 * settings-section wrapper and JsonEscapeHatch are SettingsPage-owned
 * (task 7); this component renders neither. */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { configDocQuery } from '../config.queries';
import { useConfigMutation } from '../useConfigMutation';
import type { SearchUrlRow } from './searchUrls.model';
import {
  isSlugCovered,
  parseSearchUrlRows,
  serializeSearchUrlRows,
} from './searchUrls.model';

const DEFAULT_SLUG = 'linkedin__jobs-search';
const PROTOCOL_MESSAGE = 'Enter a LinkedIn URL starting with https://';
const HOST_MESSAGE = 'That URL is not a linkedin.com address.';
const LABEL_MESSAGE = 'Give this search a short label.';
const COVERAGE_MESSAGE =
  'No page inventory exists for this page type yet — run /page-analyse.';

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

function validateRows(rows: SearchUrlRow[]): string | null {
  for (const row of rows) {
    const message = validateRow(row);
    if (message) return message;
  }
  return null;
}

export function SearchUrlsSection({ profile }: { profile: string }) {
  const query = useQuery(configDocQuery(profile, 'search_urls.md'));
  const mutation = useConfigMutation(profile, 'search_urls.md');
  const [rows, setRows] = useState<SearchUrlRow[]>([]);

  // Reset only when the doc first loads, mirroring useDocForm's own
  // "initial load only" precedent (see Global constraints).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  useEffect(() => {
    if (query.isSuccess) setRows(parseSearchUrlRows(query.data.text));
  }, [query.isSuccess]);

  function updateRow(index: number, patch: Partial<SearchUrlRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((prev) => [...prev, { slug: DEFAULT_SLUG, label: '', url: '' }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (validateRows(rows)) return;
    try {
      await mutation.mutateAsync(serializeSearchUrlRows(rows));
    } catch {
      // mutation.error is already set by react-query; rendered below.
    }
  }

  if (query.isPending || query.isError) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {rows.map((row, index) => {
          const rowError = validateRow(row);
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: SearchUrlRow carries no stable id in the model
              key={index}
              className="flex flex-col gap-1 rounded-lg border border-border p-3"
            >
              <div className="flex gap-2">
                <Field invalid={Boolean(rowError)} className="flex-1">
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
                      onChange={(e) => updateRow(index, { label: e.target.value })}
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
                <p className="text-sm text-attention-strong">{COVERAGE_MESSAGE}</p>
              )}
              <Badge variant="outline">{row.slug}</Badge>
            </div>
          );
        })}
      </div>
      <Button type="button" variant="outline" onClick={addRow}>
        Add another search URL
      </Button>
      <Button type="button" disabled={mutation.isPending} onClick={handleSave}>
        Save
      </Button>
      {mutation.error && <p data-testid="settings-error">{mutation.error.message}</p>}
    </div>
  );
}
