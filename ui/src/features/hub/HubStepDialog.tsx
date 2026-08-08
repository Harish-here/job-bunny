import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import type { ConfigDocName } from '../settings/config.api';
import { configKeys } from '../settings/config.queries';
import { Step3About } from '../wizard/steps/Step3About';
import { Step4Hunt } from '../wizard/steps/Step4Hunt';
import { Step5Extras } from '../wizard/steps/Step5Extras';
import {
  emptyDraft,
  type WizardDraft,
  type WizardStepProps,
} from '../wizard/wizard.types';
import { hubKeys } from './hub.queries';

export type HubDialogCardId = 'persona-filters' | 'search-urls' | 'integrations';

const DIALOG_TITLE: Record<HubDialogCardId, string> = {
  'persona-filters': 'Persona & filters',
  'search-urls': 'Search URLs',
  integrations: 'Integrations',
};

// Every doc any of the three hosted steps can write. Invalidating all four
// after every save is deliberately broader than tracking which doc a given
// card actually touched — see this brief's Rationale.
const CONFIG_DOCS_TO_INVALIDATE: readonly ConfigDocName[] = [
  'filter.json',
  'resume.json',
  'search_urls.md',
  'profile.json',
];

export function HubStepDialog({
  profile,
  cardId,
  onClose,
}: {
  profile: string;
  cardId: HubDialogCardId;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<WizardDraft>(() => emptyDraft(profile));
  const [submit, setSubmit] = useState<(() => Promise<boolean>) | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wrapped in an updater, not passed as `setSubmit` directly: React treats
  // any function value passed straight to a state setter as an updater
  // `(prev) => next` and calls it immediately rather than storing it —
  // which would invoke the step's submit handler on every registration
  // instead of holding onto it. Wrapping it as the RETURN VALUE of an
  // updater (`() => handler`) is the standard fix for storing a function in
  // `useState`. Also memoized with `useCallback` (empty deps — `setSubmit`
  // is itself stable): every hosted step re-registers from a `useEffect`
  // whose deps include `registerSubmit` itself (the frozen contract), so an
  // unmemoized inline function here would change identity every render,
  // retrigger that effect, and loop forever. `WizardPage`'s own
  // `registerSubmit` avoids the "function in state" pitfall differently,
  // via a ref (`submitRef.current = handler`) plus a separate boolean for
  // re-render triggering — this dialog uses the state form instead because
  // it does not otherwise need the extra ref.
  const registerSubmit = useCallback(
    (handler: (() => Promise<boolean>) | null) => setSubmit(() => handler),
    [],
  );

  const stepProps: WizardStepProps = {
    draft,
    onDraftChange: setDraft,
    registerSubmit,
  };

  async function handleSave() {
    if (submit === null || saving) return;
    setSaving(true);
    setError(null);
    // Step3About's own contract (see its `handleSubmit` doc comment): field
    // errors and the never-clobber stop resolve `false` and stay inside the
    // step's own inline UI; only a write failure is a "shell" failure,
    // surfaced by letting the rejection propagate uncaught. WizardPage
    // catches that at its own shell level — this dialog IS that shell for
    // every hosted step, so it must catch here too, not just try/finally.
    try {
      const ok = await submit();
      if (ok) {
        qc.invalidateQueries({ queryKey: hubKeys.doctor(profile) });
        for (const doc of CONFIG_DOCS_TO_INVALIDATE) {
          qc.invalidateQueries({ queryKey: configKeys.doc(profile, doc) });
        }
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent data-testid="hub-panel" data-card-id={cardId}>
        <DialogHeader>
          <DialogTitle>{DIALOG_TITLE[cardId]}</DialogTitle>
        </DialogHeader>
        {error && (
          <div
            role="alert"
            data-testid="hub-dialog-error"
            className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        {cardId === 'persona-filters' && <Step3About {...stepProps} />}
        {cardId === 'search-urls' && <Step4Hunt {...stepProps} />}
        {cardId === 'integrations' && <Step5Extras {...stepProps} onSkip={onClose} />}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={submit === null || saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
