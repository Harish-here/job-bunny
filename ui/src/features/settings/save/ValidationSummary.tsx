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
    // B12 fix (QA settings-overhaul, round 2): matches mockup S8's
    // `.validation-summary` exactly (mockup.html:175) — left-edge-only
    // border, `--destructive-8` tint, 16px padding, 8px gap. Not the
    // vendored `destructive` variant (`bg-card text-destructive` on all
    // sides): `variant="default"` plus explicit overrides, so the TITLE
    // stays `--foreground`/700 (mockup: plain `<b>`, no destructive
    // colour) while only the LINKS carry destructive text — and per B13's
    // ruling, `--destructive-strong` (5.53:1 on white), not the mockup's
    // own plain `--destructive` (4.38:1 on white, 3.74:1 on the mockup's
    // own tint — both fail 4.5:1).
    <Alert
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-live="assertive"
      data-qa="validation-summary"
      data-testid="validation-summary"
      className="gap-2 rounded-lg border-0 border-l-2 border-l-destructive bg-destructive/8 p-4"
    >
      <AlertTitle className="font-bold text-foreground">
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
              className="text-destructive-strong underline"
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
