import type { ReactNode } from 'react';

/**
 * The single place that decides "form vs error" for every
 * `useDocForm`-backed settings section (Profile, Schedule, Filters,
 * Resume). Renders `children` — the section's real form, Save button
 * included — only once the doc has loaded successfully with valid JSON.
 * Otherwise renders a blocking state and NOTHING else: no Save button ever
 * reaches the DOM while the doc hasn't loaded, so a section using this
 * wrapper cannot forget to gate its own Save on `isLoading`/`loadError`.
 */
export function DocFormGate({
  doc,
  isLoading,
  loadError,
  parseError,
  children,
}: {
  doc: string;
  isLoading: boolean;
  loadError: Error | null;
  parseError: boolean;
  children: ReactNode;
}) {
  if (loadError) {
    return (
      <p data-testid="settings-load-error" className="text-sm text-destructive">
        Couldn't load {doc}: {loadError.message}
      </p>
    );
  }
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (parseError) {
    return (
      <p data-testid="settings-load-error" className="text-sm text-destructive">
        {doc} contains invalid JSON and can't be edited here as a form — use Edit as JSON
        below to fix it.
      </p>
    );
  }
  return <>{children}</>;
}
