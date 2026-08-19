import { Button } from '../../components/ui/button';

/** Shared list-pane/detail-pane error state — text copy plus a Retry button
 * wired to the failed query's own `refetch`. Extracted from TriagePage and
 * RunsPage, which each defined this shape locally and byte-identically. */
export const ErrorRetry = ({
  message,
  onRetry,
  padded = false,
}: {
  message: string;
  onRetry: () => void;
  padded?: boolean;
}) => {
  return (
    <div className={`flex flex-col items-start gap-2 text-sm ${padded ? 'p-4' : ''}`}>
      <span className="text-destructive">{message}</span>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
};
