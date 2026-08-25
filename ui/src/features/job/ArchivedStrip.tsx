/**
 * §1 divergence D11/C13 — `archived` is a read-only flag, not part of
 * `TrackingFields`; there is no write path (no Restore control, no icon).
 * `archived === false` renders literally nothing (`null`), not an empty
 * or hidden element.
 */
export function ArchivedStrip({ archived }: { archived: boolean }) {
  if (!archived) return null;

  return (
    <div
      className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground"
      data-qa="archived-strip"
    >
      Archived — this job is out of the queue.
    </div>
  );
}
