import { AlertTriangle, Check } from 'lucide-react';

const EYEBROW_CLASS =
  'text-micro font-medium uppercase tracking-[0.04em] text-muted-foreground';

/**
 * Zone 2 (`ux-notes.md` §5) — reasons vs. flags, deliberately asymmetric.
 * Container shape + icon + rhythm carry the distinction; colour
 * (`bg-success/10`/`text-success-strong` vs `text-destructive-strong`) is
 * the 4th, topmost cue only (R15).
 *
 * Empty-case rules are NOT symmetric:
 * - No review flags -> the entire flags block is omitted (no eyebrow, no
 *   `· 0`) -- the absence of a caution is the good/default case.
 * - No match reasons -> the eyebrow still renders (`WHY IT MATCHES`, no
 *   count) over one muted line, because an unexplained score is itself a
 *   fact worth surfacing. Confirmed against the mockup's S7 sparse frame,
 *   which is authoritative for this branch's DOM shape.
 */
export function JobSignals({
  matchReasons,
  reviewFlags,
}: {
  matchReasons: string[];
  reviewFlags: string[];
}) {
  const hasReasons = matchReasons.length > 0;
  const hasFlags = reviewFlags.length > 0;

  return (
    <div className="flex flex-col gap-3" data-qa="signals">
      <div>
        <h3 className={EYEBROW_CLASS}>
          {hasReasons ? `WHY IT MATCHES · ${matchReasons.length}` : 'WHY IT MATCHES'}
        </h3>
        {hasReasons ? (
          <div className="mt-1 flex flex-wrap gap-2" data-qa="match-reasons">
            {matchReasons.map((reason) => (
              <span
                key={reason}
                className="inline-flex items-center gap-1 rounded-4xl bg-success/10 px-2 py-0.5 text-xs text-success-strong"
              >
                <Check aria-hidden="true" className="size-3 shrink-0" />
                {reason}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">No match reasons recorded.</p>
        )}
      </div>
      {hasFlags && (
        <div>
          <h3 className={EYEBROW_CLASS}>{`REVIEW FLAGS · ${reviewFlags.length}`}</h3>
          <div
            className="mt-1 flex flex-col gap-1 border-l-2 border-destructive pl-3"
            data-qa="review-flags"
          >
            {reviewFlags.map((flag) => (
              <div
                key={flag}
                className="flex items-start gap-1 text-sm text-destructive-strong"
              >
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {flag}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
