import { useEffect, useRef } from 'react';
import { Alert, AlertTitle } from '../../../components/ui/alert';

export interface ValidationSummaryProps {
  errors: Record<string, string>;
  /** Bumped by the caller each time a Save click actually failed
   * validation (see `useSectionSaveState().save()`'s `Promise<boolean>`
   * resolving `false`) — the summary's focus-on-failure behaviour
   * (ux-notes §11/§14) fires only on THAT transition, never merely
   * because `errors` happens to be non-empty on a render caused by
   * live-as-you-type validation (the codebase's own already-shipped
   * "as-you-type inline field errors" contract — see `fetching.state.ts`'s
   * `validatePacingPairs` doc comment). Monotonically increasing; never
   * reset by the caller. */
  attempt: number;
}

/**
 * S8's error summary card (ux-notes §11 / §12 rows S2/S3/S5) — B1 (QA
 * settings-overhaul): rendered by each editable section at the TOP of its
 * content column, never inside `SaveBar`. `SaveBar`'s own sticky bottom
 * bar keeps rendering the dirty state (Save/Discard, never disabled) even
 * while this is visible — the two are no longer mutually exclusive, which
 * is what used to unmount the save button on a failed submit.
 */
export function ValidationSummary({ errors, attempt }: ValidationSummaryProps) {
  const entries = Object.entries(errors);
  const ref = useRef<HTMLDivElement>(null);
  const lastFocusedAttempt = useRef(0);

  // Only re-run when `attempt` itself changes — re-running on every
  // `errors`-driven re-render would steal focus back to the summary while
  // the user is mid-fix, which is exactly the disruption a submit-scoped
  // (not keystroke-scoped) focus move is meant to avoid.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — see comment above.
  useEffect(() => {
    if (attempt > lastFocusedAttempt.current && entries.length > 0) {
      lastFocusedAttempt.current = attempt;
      ref.current?.focus();
    }
  }, [attempt]);

  if (entries.length === 0) return null;

  return (
    <Alert
      ref={ref}
      tabIndex={-1}
      variant="destructive"
      role="alert"
      aria-live="assertive"
      data-qa="validation-summary"
      data-testid="validation-summary"
    >
      <AlertTitle>
        {entries.length} {entries.length === 1 ? 'problem' : 'problems'} to fix
      </AlertTitle>
      <ul className="list-disc pl-4 text-sm">
        {entries.map(([field, message]) => (
          <li
            key={field}
            data-qa={`validation-item-${field}`}
            data-testid={`validation-item-${field}`}
          >
            <a
              href={`#${field}`}
              className="underline"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(field)?.focus();
              }}
            >
              {message}
            </a>
          </li>
        ))}
      </ul>
    </Alert>
  );
}
