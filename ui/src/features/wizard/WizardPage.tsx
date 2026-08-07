import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import { useStoredProfile } from '../../lib/profile';
import { profilesKeys } from '../shell/profiles.queries';
import { useProfilesQuery } from '../shell/useProfiles';
import { clearDraft, readActiveProfile, readDraft, writeDraft } from './draftStore';
import { Step1Name } from './steps/Step1Name';
import { Step2Persona } from './steps/Step2Persona';
import {
  emptyDraft,
  type WizardDraft,
  type WizardStep,
  type WizardStepProps,
} from './wizard.types';

/**
 * Frozen (progress.md, "Step component contract," 2026-08-07): every step
 * component takes exactly this props shape — step 5 additionally takes
 * `onSkip: () => void`, added in task 7 alongside its own real component.
 * `WizardStepProps` itself is declared and exported ONCE, in task 1's
 * `wizard.types.ts`, not here. `onDraftChange` fires on every field edit,
 * never only on a successful Next; `WizardPage` persists each change
 * through task 1's `writeDraft` once `draft.profile` is non-empty (the
 * localStorage schema guarantees a draft key always names a REAL profile,
 * so nothing is written before some step actually creates one — task 10's
 * `Step1Name` is the step that eventually does that). `registerSubmit` is
 * called from a step's own `useEffect`: registering a real handler is what
 * leaves the shared `wizard-next` button enabled; registering `null`
 * (including on unmount) is what disables it — `WizardPage` never
 * inspects a step's validity directly, and never renders more than one
 * `wizard-step` wrapper, one `wizard-error` alert, or one footer.
 */

const STEP_TITLES: Record<WizardStep, string> = {
  1: 'Name it',
  2: 'Pick a persona',
  3: 'About you',
  4: 'Where to hunt',
  5: 'Extras',
  6: 'Launch',
};

function initialDraft(): WizardDraft {
  return { ...emptyDraft(''), step: 1 };
}

/** Every one of the six steps is wired here as a placeholder only — task
 * 10 (steps 1–2) and tasks 5, 6, 7, and 8 (steps 3–6) each replace exactly
 * one of these six `case` branches with the real step, dropped in against
 * the SAME `WizardStepProps` this task already passes; nothing else in
 * `renderStep`'s switch changes when they do. Steps 1 and 2 are real
 * components (task 10); steps 3 through 5 still register a trivial
 * always-`true` placeholder handler (nothing is written, so Next simply
 * advances); step 6 registers `null` — it is this wizard's only exit and
 * there is no honest "finish" behavior to wire until task 8 adds the real
 * one. */
function Placeholder({
  label,
  finishable,
  registerSubmit,
}: WizardStepProps & { label: string; finishable: boolean }) {
  useEffect(() => {
    registerSubmit(finishable ? async () => true : null);
    return () => registerSubmit(null);
  }, [finishable, registerSubmit]);

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-base font-medium">{label}</h2>
      <p className="text-sm text-muted-foreground">This step arrives in the next task.</p>
    </div>
  );
}

export function WizardPage() {
  const profilesQuery = useProfilesQuery();
  const [, choose] = useStoredProfile();
  const qc = useQueryClient();

  const [rehydrated, setRehydrated] = useState(false);
  const [step, setStep] = useState<WizardStep>(1);
  const [draft, setDraft] = useState<WizardDraft>(initialDraft);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [hasHandler, setHasHandler] = useState(false);
  const submitRef = useRef<(() => Promise<boolean>) | null>(null);
  const previousProfileRef = useRef('');

  // Rehydration (frozen contract): read `jobbunny.wizard.active`; if that
  // profile is present in the profiles query's own data, restore its
  // draft; otherwise clear both localStorage keys and start fresh. Runs
  // exactly once, after the profiles query first resolves successfully.
  useEffect(() => {
    if (rehydrated || !profilesQuery.isSuccess) return;
    const active = readActiveProfile();
    const known = new Set(profilesQuery.data.profiles.map((p) => p.name));
    if (active !== null && known.has(active)) {
      const stored = readDraft(active);
      if (stored !== null) {
        setDraft(stored);
        setStep(stored.step);
        setRehydrated(true);
        return;
      }
    }
    if (active !== null) clearDraft(active);
    setRehydrated(true);
  }, [rehydrated, profilesQuery.isSuccess, profilesQuery.data]);

  // Once some step actually creates a profile (draft.profile transitions
  // from '' to a real name — task 10's Step1Name is the step that does
  // this), select it and invalidate the profiles list — the same side
  // effects `OnboardingPage` used to perform on its own submit. This
  // effect is generic shell behavior, not step-1-specific, which is why
  // it lives here rather than in a later task's diff.
  useEffect(() => {
    if (draft.profile !== '' && previousProfileRef.current === '') {
      qc.invalidateQueries({ queryKey: profilesKeys.all });
      choose(draft.profile);
    }
    previousProfileRef.current = draft.profile;
  }, [draft.profile, qc, choose]);

  const registerSubmit = useCallback((handler: (() => Promise<boolean>) | null) => {
    submitRef.current = handler;
    setHasHandler(handler !== null);
  }, []);

  const handleDraftChange = useCallback((next: WizardDraft) => {
    setDraft(next);
    if (next.profile !== '') writeDraft(next);
  }, []);

  async function handleNext() {
    const submit = submitRef.current;
    if (!submit || pending) return;
    setError(null);
    setPending(true);
    try {
      const ok = await submit();
      if (ok) {
        setStep((s) => {
          const next = (s + 1) as WizardStep;
          setDraft((d) => {
            const updated = { ...d, step: next };
            if (updated.profile !== '') writeDraft(updated);
            return updated;
          });
          return next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  function handleBack() {
    if (step === 1) return;
    setError(null);
    setStep((s) => {
      const next = (s - 1) as WizardStep;
      setDraft((d) => {
        const updated = { ...d, step: next };
        if (updated.profile !== '') writeDraft(updated);
        return updated;
      });
      return next;
    });
  }

  function renderStep() {
    const stepProps: WizardStepProps = {
      draft,
      onDraftChange: handleDraftChange,
      registerSubmit,
    };
    switch (step) {
      case 1:
        return <Step1Name {...stepProps} />;
      case 2:
        return <Step2Persona {...stepProps} />;
      case 3:
        return <Placeholder {...stepProps} label="About you" finishable />;
      case 4:
        return <Placeholder {...stepProps} label="Where to hunt" finishable />;
      case 5:
        return <Placeholder {...stepProps} label="Extras" finishable />;
      case 6:
        return <Placeholder {...stepProps} label="Launch" finishable={false} />;
    }
  }

  if (!rehydrated) {
    return <div data-testid="wizard" />;
  }

  return (
    <div data-testid="wizard" className="flex h-screen flex-col">
      <header className="flex flex-col gap-2 border-b border-border p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold font-heading">{STEP_TITLES[step]}</h1>
          <span className="text-sm text-muted-foreground">Step {step} of 6</span>
        </div>
        <Progress value={(step / 6) * 100} />
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div
            role="alert"
            data-testid="wizard-error"
            className="mb-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        <div data-testid="wizard-step" data-step={step}>
          {renderStep()}
        </div>
      </div>
      <footer className="flex items-center justify-between border-t border-border p-6">
        {step > 1 ? (
          <Button
            type="button"
            variant="outline"
            data-testid="wizard-back"
            onClick={handleBack}
          >
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          data-testid="wizard-next"
          disabled={pending || !hasHandler}
          onClick={handleNext}
        >
          Next
        </Button>
      </footer>
    </div>
  );
}
