/**
 * Settings "Search URLs" card (blueprint.md Step 4, ux-notes.md §3, spec
 * R9/R10/R13). Composes: card title/helper text, a misfile notice
 * (conditional on `misfiledCount > 0`), the row list mapping `rows`/
 * `displayStates` to task 20's `SearchUrlRow`, "Add another search URL",
 * and the `rows.length === 0` empty-state copy line. Dumb, fully
 * controlled — no fetching, no array-splicing/save logic of its own (owned
 * by the parent orchestrator, task 23's `WhereJobsComeFromSection`),
 * matching `WhereYouWorkPrefsCard`/`WhereYouWorkRulesCard`'s existing
 * precedent of dumb, controlled sibling cards. Each per-row callback below
 * is index-bound here purely as a pass-through closure into `SearchUrlRow`'s
 * own index-less prop — the parent owns what happens with that index (the
 * same shape `WhereYouWorkRulesCard`'s `LocationRow onChange={(next) =>
 * updateLocation(i, next)}` uses, except the actual array update lives one
 * layer further up, not in this card).
 *
 * `data-qa` ids intentionally drop the mockup fragment's "-default"/
 * "-empty" suffixes: those exist only to keep the three static demo blocks
 * (Default/Empty/Loading) independently addressable within one HTML file,
 * not to name three distinct live variants. This component renders one
 * conditional tree, so each element gets a single canonical id regardless
 * of which branch is showing (the `search-urls-empty` id, named explicitly
 * in this brief's Contract, already matches the mockup literally). Loading
 * has no branch here at all — it's `DocFormGate`'s job (task 24).
 */
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { SearchUrlRow } from './SearchUrlRow';
import type { RowDisplay } from './searchUrlRow.classify';
import type { SearchUrlRow as SearchUrlRowModel } from './searchUrls.model';

/** DocFormGate's `loadingFallback` for the `search_urls.md` gate (task 24) —
 * field-shaped skeleton rows matching the mockup fragment's loading state
 * (two row-cards, each a wide + fixed-width field skeleton plus a badge
 * skeleton), rather than a bare "Loading…" line under-representing the
 * card's real loaded height (same B9 rationale DocFormGate's own doc
 * comment states). */
export function SearchUrlsSkeleton() {
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
  onChangeUrl: (index: number, url: string, isPaste?: boolean) => void;
  onChangeLabel: (index: number, label: string) => void;
  onBlurUrl: (index: number) => void;
  onRemove: (index: number) => void;
  onRemoveNow: (index: number) => void;
  onAddRow: () => void;
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
  onChangeUrl,
  onChangeLabel,
  onBlurUrl,
  onRemove,
  onRemoveNow,
  onAddRow,
}: SearchUrlsCardProps) {
  return (
    <Card data-qa="search-urls-card">
      <CardHeader>
        <CardTitle>Search URLs</CardTitle>
        <p className="text-xs text-muted-foreground" data-qa="search-urls-helper">
          Paste any LinkedIn jobs link — it's cleaned and filed automatically.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {misfiledCount > 0 && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-2 border-l-attention bg-attention/10 p-4"
            data-qa="search-urls-misfile-notice"
          >
            <p className="text-sm text-attention-strong">
              {misfileNoticeText(misfiledCount)}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={isRefiling}
              onClick={onRefile}
              data-qa="search-urls-refile-button"
            >
              {isRefiling ? 'Re-filing…' : refileButtonText(misfiledCount)}
            </Button>
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
              // focus — recomputed on every render but only observable at
              // mount, since `autoFocus` itself only acts then.
              autoFocusUrl={index === 0 && rows.length === 1 && rows[0]?.url === ''}
            />
          ))}
        </div>

        {rows.length === 0 && (
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
      </CardContent>
    </Card>
  );
}
