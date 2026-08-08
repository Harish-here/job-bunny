import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { cn } from '../../../lib/utils';
import { getPersonas } from '../wizard.api';
import { wizardKeys } from '../wizard.queries';
import type { Persona, WizardStepProps } from '../wizard.types';

/**
 * Step 2 — Pick a persona. Owns its own `GET /api/personas` query. Writes
 * nothing to the server — the frozen step → write map assigns step 2 no
 * endpoint at all; selecting a card only stages `personaId` and the
 * persona's `coreSkills`/`secondarySkills` into the draft via
 * `onDraftChange`.
 *
 * Per the frozen "Step component contract," this step does NOT render its
 * own shell-level error alert (the single one `WizardPage` itself owns) —
 * a second element carrying that testid would make Playwright's
 * strict-mode locator ambiguous once task 9's suite exists. A failed (or
 * still-pending) query instead registers NO submit
 * handler, which is exactly what leaves the shared `wizard-next` button
 * disabled, and renders its message as plain inline text.
 */
export function Step2Persona({ draft, onDraftChange, registerSubmit }: WizardStepProps) {
  const query = useQuery({
    queryKey: wizardKeys.personas(),
    queryFn: getPersonas,
  });

  useEffect(() => {
    if (draft.personaId == null) {
      registerSubmit(null);
      return () => registerSubmit(null);
    }
    registerSubmit(async () => true);
    return () => registerSubmit(null);
  }, [draft.personaId, registerSubmit]);

  function handleSelect(persona: Persona) {
    onDraftChange({
      ...draft,
      personaId: persona.id,
      about: {
        ...draft.about,
        coreSkills: persona.coreSkills,
        secondarySkills: persona.secondarySkills,
      },
    });
  }

  if (query.isPending) {
    return <p className="text-sm text-muted-foreground">Loading personas…</p>;
  }

  if (query.isError) {
    return (
      <p className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : 'Could not load personas.'}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {query.data.personas.map((persona) => {
        const selected = persona.id === draft.personaId;
        return (
          <button
            key={persona.id}
            type="button"
            data-testid="wizard-persona"
            data-persona-id={persona.id}
            aria-pressed={selected}
            onClick={() => handleSelect(persona)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg border p-3 text-left hop',
              selected ? 'border-primary bg-primary/10' : 'border-border bg-card',
            )}
          >
            <span className="text-sm font-medium">{persona.label}</span>
            <span className="text-xs text-muted-foreground">{persona.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}
