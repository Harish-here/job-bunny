/**
 * One row of the Settings "Search URLs" card (blueprint.md Step 3,
 * ux-notes.md §3 "row sub-states"). Presentational and fully controlled —
 * all state (the row's own `url`/`label`/`touched` plus the derived
 * `RowDisplay`) is owned by the parent (`SearchUrlsCard.tsx`, task 21).
 *
 * `Field` doubles here as the row-card wrapper itself (not just the URL
 * control's own label/control pair): its `id` becomes the rendered
 * `<input>`'s DOM id (`where-jobs-search-urls.${index}`, matching
 * `ValidationSummary`'s field-key convention) and its `invalid` flag wires
 * `aria-invalid`/`aria-describedby` onto that input automatically
 * (`components/ui/form.tsx`). This also lets `FieldError` sit as a sibling
 * AFTER the `row-line2` region — exactly the mockup's own DOM order (a
 * full-width error line under the badge/note row, not squeezed into the
 * narrow URL column) — while still resolving against the same field
 * context, since `useFieldContext` just walks up to the nearest provider
 * rather than requiring a locally-nested `<Field>`.
 */
import { LINKEDIN_SEARCH_URL_LABELS } from '../../../../../src/core/linkedin_url/index.ts';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import type { RowDisplay } from './searchUrlRow.classify';
import type { SearchUrlRow as SearchUrlRowModel } from './searchUrls.model';

interface SearchUrlRowProps {
  row: SearchUrlRowModel;
  display: RowDisplay;
  index: number;
  /** `isPaste` is `true` only when the change came from a native paste
   * (`InputEvent.inputType === 'insertFromPaste'`) — the parent
   * (task 23) uses it to run the same classify-and-rewrite logic
   * `onBlurUrl` runs, immediately rather than waiting for blur. Omitted
   * (not merely `false`) on every ordinary keystroke, so callers relying
   * on the old single-arg call shape are unaffected. */
  onChangeUrl: (url: string, isPaste?: boolean) => void;
  onChangeLabel: (label: string) => void;
  onBlurUrl: () => void;
  onRemove: () => void;
  onRemoveNow: () => void;
  /** Plain `autoFocus` (not an imperative ref) — ux-notes C12's
   * empty-state auto-add focuses the sole auto-added row's URL input on
   * mount. Only ever `true` for a freshly-mounted single empty row;
   * `autoFocus` only fires at mount, so this never yanks focus back on a
   * later re-render. */
  autoFocusUrl?: boolean;
}

// LINKEDIN_SEARCH_URL_LABELS is keyed by the two recognized page slugs, but
// `RowDisplay.misfiled.storedPage` carries whatever heading the row was
// actually saved under (any string) — so the lookup falls back to the raw
// slug for an unrecognized one rather than throwing away information.
function pageLabelFor(page: string): string {
  return (LINKEDIN_SEARCH_URL_LABELS as Record<string, string>)[page] ?? page;
}

// ux-notes.md §3: "Cleaned — removed X, Y" (≤3 names, then "+N more").
function cleanedNoteText(removedParams: string[]): string {
  const shown = removedParams.slice(0, 3);
  const extra = removedParams.length - shown.length;
  return `Cleaned — removed ${shown.join(', ')}${extra > 0 ? `, +${extra} more` : ''}`;
}

function PageTypeBadge({ page, index }: { page: string; index: number }) {
  const label = pageLabelFor(page);
  const titleText = `Page type: ${label} (${page})`;
  return (
    <Badge
      variant="outline"
      title={titleText}
      aria-label={titleText}
      data-qa={`search-url-page-type-badge-${index}`}
    >
      {label}
    </Badge>
  );
}

export function SearchUrlRow({
  row,
  display,
  index,
  onChangeUrl,
  onChangeLabel,
  onBlurUrl,
  onRemove,
  onRemoveNow,
  autoFocusUrl,
}: SearchUrlRowProps) {
  const isRefused = display.kind === 'refused';
  const removeLabel = row.label.trim() ? `Remove ${row.label}` : 'Remove row';

  return (
    <Field
      id={`where-jobs-search-urls.${index}`}
      invalid={isRefused}
      data-qa={`search-url-row-${index}`}
      className="flex flex-col gap-1 rounded-lg border border-border p-3"
    >
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <FieldLabel>Search URL</FieldLabel>
          <FieldControl>
            <Input
              data-qa={`search-url-input-${index}`}
              value={row.url}
              autoFocus={autoFocusUrl}
              onChange={(e) => {
                const value = e.target.value;
                const isPaste =
                  (e.nativeEvent as InputEvent).inputType === 'insertFromPaste';
                if (isPaste) {
                  onChangeUrl(value, true);
                } else {
                  onChangeUrl(value);
                }
              }}
              onBlur={onBlurUrl}
            />
          </FieldControl>
        </div>
        <Field className="w-48">
          <FieldLabel>Label</FieldLabel>
          <FieldControl>
            <Input
              data-qa={`search-url-label-input-${index}`}
              placeholder="Label"
              value={row.label}
              onChange={(e) => onChangeLabel(e.target.value)}
            />
          </FieldControl>
        </Field>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={removeLabel}
          data-qa={`search-url-remove-${index}`}
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </Button>
      </div>

      <div className="flex items-center gap-2" aria-live="polite">
        {display.kind === 'clean' && <PageTypeBadge page={display.page} index={index} />}

        {display.kind === 'cleaned' && (
          <>
            <PageTypeBadge page={display.page} index={index} />
            <span
              className="text-xs text-muted-foreground"
              data-qa={`search-url-row-note-${index}`}
            >
              {cleanedNoteText(display.removedParams)}
            </span>
          </>
        )}

        {display.kind === 'misfiled' && (
          <>
            <PageTypeBadge page={display.page} index={index} />
            <span
              className="text-xs text-attention-strong"
              data-qa={`search-url-row-note-${index}`}
            >
              {`Saved as ${pageLabelFor(display.storedPage)} — will be re-filed as ${pageLabelFor(display.page)}.`}
            </span>
          </>
        )}

        {display.kind === 'duplicate' && (
          <>
            <PageTypeBadge page={display.page} index={index} />
            <span
              className="text-xs text-attention-strong"
              data-qa={`search-url-row-note-${index}`}
            >
              {`Same search as "${display.mergesIntoLabel}" after cleaning — merged on save.`}
            </span>
            <button
              type="button"
              className="text-xs text-primary underline underline-offset-4"
              data-qa="search-url-duplicate-remove"
              onClick={onRemoveNow}
            >
              Remove now
            </button>
          </>
        )}
      </div>

      {isRefused && (
        <FieldError data-qa={`search-url-error-${index}`}>{display.message}</FieldError>
      )}
    </Field>
  );
}
