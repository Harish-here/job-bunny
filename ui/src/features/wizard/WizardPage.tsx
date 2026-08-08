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
import { Step3About } from './steps/Step3About';
import { Step4Hunt } from './steps/Step4Hunt';
import { Step5Extras } from './steps/Step5Extras';
import { Step6Launch } from './steps/Step6Launch';
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
          // Clamped, not a bare `s + 1`: step 6's own submit handler
          // (Step6Launch) already calls `navigate({ name: 'runs' })` on
          // success, and that route change only takes effect on the async
          // `hashchange` event — without the clamp, this render would
          // briefly show a nonexistent "step 7 of 6" (STEP_TITLES[7] is
          // undefined, Progress renders past 100%) before the route swap.
          const next = Math.min(s + 1, 6) as WizardStep;
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
        return <Step3About {...stepProps} />;
      case 4:
        return <Step4Hunt {...stepProps} />;
      case 5:
        return (
          <Step5Extras
            {...stepProps}
            onSkip={() => {
              setError(null);
              setDraft((d) => {
                const updated = { ...d, step: 6 as WizardStep };
                if (updated.profile !== '') writeDraft(updated);
                return updated;
              });
              setStep(6);
            }}
          />
        );
      case 6:
        return <Step6Launch {...stepProps} />;
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
