/**
 * Settings "Search URLs" card (blueprint.md Step 4, ux-notes.md §3, spec
 * R9/R10/R13). Composes: card title/helper text, a misfile notice
 * (conditional on `misfiledCount > 0`), the row list mapping `rows`/
 * `displayStates` to task 20's `SearchUrlRow`, "Add another search URL",
 * and the empty-state copy line. Dumb, fully controlled — no fetching, no
 * array-splicing/save logic of its own (owned by the parent orchestrator,
 * task 23's `WhereJobsComeFromSection`), matching `WhereYouWorkPrefsCard`/
 * `WhereYouWorkRulesCard`'s existing precedent of dumb, controlled sibling
 * cards. Each per-row callback below is index-bound here purely as a
 * pass-through closure into `SearchUrlRow`'s own index-less prop — the
 * parent owns what happens with that index (the same shape
 * `WhereYouWorkRulesCard`'s `LocationRow onChange={(next) =>
 * updateLocation(i, next)}` uses, except the actual array update lives one
 * layer further up, not in this card).
 *
 * B6 fix (QA search-link-intake): `isLoading`/`loadError`/`onRetryLoad`
 * moved IN from the parent's `DocFormGate` — the mockup's S1 Loading view
 * keeps the card's own title/helper chrome and the sibling Lanes card
 * visible, swapping only the CONTENT region for skeleton rows (never the
 * whole section for a bare, unframed skeleton). The parent no longer wraps
 * this card in its own `search_urls.md` `DocFormGate`; this card owns its
 * own three-way loading/error/loaded branch instead.
 *
 * `data-qa` ids intentionally drop the mockup fragment's "-default"/
 * "-empty" suffixes: those exist only to keep the three static demo blocks
 * (Default/Empty/Loading) independently addressable within one HTML file,
 * not to name three distinct live variants. This component renders one
 * conditional tree, so each element gets a single canonical id regardless
 * of which branch is showing (the `search-urls-empty` id, named explicitly
 * in this brief's Contract, already matches the mockup literally).
 */
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { ErrorRetry } from '../../shared/ErrorRetry';
import { SearchUrlRow } from './SearchUrlRow';
import type { RowDisplay } from './searchUrlRow.classify';
import type { SearchUrlRow as SearchUrlRowModel } from './searchUrls.model';

/** Field-shaped skeleton rows matching the mockup fragment's loading state
 * (two row-cards, each a wide + fixed-width field skeleton plus a badge
 * skeleton) — under-representing the card's real loaded height would show
 * up as a large layout shift the instant the doc resolves. */
function SearchUrlsSkeletonRows() {
  return (
    <div className="flex flex-col gap-2" data-qa="search-urls-skeleton">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Skeleton className="h-9 flex-1" />
            <Skeleton className="h-9 w-48" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

interface SearchUrlsCardProps {
  rows: SearchUrlRowModel[];
  displayStates: RowDisplay[];
  misfiledCount: number;
  onRefile: () => void;
  isRefiling: boolean;
  /** B2 fix (QA search-link-intake): the section's own combined
   * `saveState.isDirty` — Re-file must never save an unsaved edit, so the
   * button is disabled (with a helper line explaining why) whenever the
   * form is dirty, regardless of which card the unsaved edit lives in. */
  isDirty: boolean;
  onChangeUrl: (index: number, url: string, isPaste?: boolean) => void;
  onChangeLabel: (index: number, label: string) => void;
  onBlurUrl: (index: number) => void;
  onRemove: (index: number) => void;
  onRemoveNow: (index: number) => void;
  onAddRow: () => void;
  isLoading: boolean;
  loadError: Error | null;
  onRetryLoad: () => void;
}

// DONE-WHEN's exact singular/plural requirement, matching the repo's
// existing pattern at ValidationSummary.tsx:66.
function refileButtonText(misfiledCount: number): string {
  return `Re-file ${misfiledCount} ${misfiledCount === 1 ? 'link' : 'links'}`;
}

function misfileNoticeText(misfiledCount: number): string {
  return misfiledCount === 1
    ? '1 link is filed under the wrong page type, so runs read it with the wrong page reader.'
    : `${misfiledCount} links are filed under the wrong page type, so runs read them with the wrong page reader.`;
}

export function SearchUrlsCard({
  rows,
  displayStates,
  misfiledCount,
  onRefile,
  isRefiling,
  isDirty,
  onChangeUrl,
  onChangeLabel,
  onBlurUrl,
  onRemove,
  onRemoveNow,
  onAddRow,
  isLoading,
  loadError,
  onRetryLoad,
}: SearchUrlsCardProps) {
  // B5 fix (QA search-link-intake): the empty-state copy is about the
  // DOC's own content, not the editor's row count — ux-notes C12's
  // auto-added blank row (and every manually-added-but-still-blank row)
  // must not count as "content", or the copy never shows on a genuinely
  // empty doc.
  const hasAnyUrl = rows.some((row) => row.url.trim() !== '');

  return (
    <Card data-qa="search-urls-card">
      <CardHeader>
        <CardTitle>Search URLs</CardTitle>
        <p className="text-xs text-muted-foreground" data-qa="search-urls-helper">
          Paste any LinkedIn jobs link — it's cleaned and filed automatically.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loadError ? (
          <ErrorRetry
            message="Couldn't load search links."
            onRetry={onRetryLoad}
            qa="search-urls-load-error"
          />
        ) : isLoading ? (
          <SearchUrlsSkeletonRows />
        ) : (
          <>
            {misfiledCount > 0 && (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-2 border-l-attention bg-attention/10 p-4"
                data-qa="search-urls-misfile-notice"
              >
                <p className="text-sm text-attention-strong">
                  {misfileNoticeText(misfiledCount)}
                </p>
                <div className="flex flex-col items-end gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isRefiling || isDirty}
                    onClick={onRefile}
                    data-qa="search-urls-refile-button"
                  >
                    {isRefiling ? 'Re-filing…' : refileButtonText(misfiledCount)}
                  </Button>
                  {isDirty && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-qa="search-urls-refile-disabled-hint"
                    >
                      Save or discard your changes first, then re-file.
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              {rows.map((row, index) => (
                <SearchUrlRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: SearchUrlRow carries no stable id in the model
                  key={index}
                  row={row}
                  display={displayStates[index] ?? { kind: 'unclassified' }}
                  index={index}
                  onChangeUrl={(url, isPaste) =>
                    isPaste ? onChangeUrl(index, url, true) : onChangeUrl(index, url)
                  }
                  onChangeLabel={(label) => onChangeLabel(index, label)}
                  onBlurUrl={() => onBlurUrl(index)}
                  onRemove={() => onRemove(index)}
                  onRemoveNow={() => onRemoveNow(index)}
                  // ux-notes C12: the sole auto-added empty row gets initial
                  // focus — recomputed on every render but only observable
                  // at mount, since `autoFocus` itself only acts then.
                  autoFocusUrl={index === 0 && rows.length === 1 && rows[0]?.url === ''}
                />
              ))}
            </div>

            {!hasAnyUrl && (
              <p className="text-sm text-muted-foreground" data-qa="search-urls-empty">
                No LinkedIn searches yet. Paste a link from a LinkedIn jobs search page to
                start.
              </p>
            )}

            <Button
              type="button"
              variant="outline"
              onClick={onAddRow}
              data-qa="search-urls-add"
            >
              Add another search URL
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
