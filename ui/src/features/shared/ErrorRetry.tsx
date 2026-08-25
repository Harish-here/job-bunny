import { Button } from '../../components/ui/button';

/** Shared list-pane/detail-pane error state — text copy plus a Retry button
 * wired to the failed query's own `refetch`. Extracted from TriagePage and
 * RunsPage, which each defined this shape locally and byte-identically.
 * `qa` is an optional `data-qa` passthrough — undefined by default (no
 * attribute rendered) so existing call sites are unaffected; TriagePage's
 * list-pane call site sets `qa="list-error"` (QA round 1 bug 3, S4). */
export const ErrorRetry = ({
  message,
  onRetry,
  padded = false,
  qa,
}: {
  message: string;
  onRetry: () => void;
  padded?: boolean;
  qa?: string;
}) => {
  return (
    <div
      className={`flex flex-col items-start gap-2 text-sm ${padded ? 'p-4' : ''}`}
      data-qa={qa}
    >
      <span className="text-destructive">{message}</span>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
};
