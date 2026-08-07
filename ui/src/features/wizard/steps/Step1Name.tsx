import { useEffect, useState } from 'react';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { ApiError } from '../../../lib/api/client';
import { createProfile } from '../../settings/config.api';
import { validateName } from '../validate';
import type { WizardStepProps } from '../wizard.types';

/**
 * Step 1 — Name it. Owns the create-profile write and its own field-level
 * error; `WizardPage` owns the shared footer's `Next` button and the
 * single step-level `wizard-error` alert (a server error other than a
 * duplicate name surfaces there instead — see the thrown branch below).
 *
 * The typed-but-not-yet-created name lives in LOCAL state, never in
 * `draft.profile`: the frozen localStorage schema guarantees a draft key
 * always names a REAL profile ("a draft is only ever persisted after step
 * 1 has created the profile on the server"), so nothing this step's user
 * types reaches `onDraftChange` until `createProfile` actually succeeds.
 * That single call — `onDraftChange({ ...draft, profile: created.name })`
 * — is also what makes `draft.profile !== ''` the signal that creation
 * already happened: a user who clicks Back to this step and Next again
 * finds the field locked and the registered handler a no-op that
 * resolves `true` without a second `createProfile` call.
 *
 * Registering `null` while the name is empty or fails `validateName` is
 * what leaves the shared `wizard-next` button disabled — `WizardPage`
 * never inspects this step's validity directly.
 */
export function Step1Name({ draft, onDraftChange, registerSubmit }: WizardStepProps) {
  const [name, setName] = useState(draft.profile);
  const [serverError, setServerError] = useState<string | undefined>(undefined);

  const created = draft.profile !== '';
  const trimmed = name.trim();
  const clientError = trimmed === '' ? undefined : validateName(trimmed).name;
  const fieldError = serverError ?? clientError;

  useEffect(() => {
    if (!created && (trimmed === '' || clientError !== undefined)) {
      registerSubmit(null);
      return () => registerSubmit(null);
    }
    registerSubmit(async () => {
      if (created) return true;
      try {
        const result = await createProfile(trimmed);
        onDraftChange({ ...draft, profile: result.profile.name });
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'profile_exists') {
          setServerError(err.message);
          return false;
        }
        throw err;
      }
    });
    return () => registerSubmit(null);
  }, [created, trimmed, clientError, draft, onDraftChange, registerSubmit]);

  return (
    <div className="flex max-w-md flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Job Bunny is local-first — this profile, and everything you fill in on the next
        few screens, stays on this machine.
      </p>
      <Field invalid={fieldError !== undefined}>
        <FieldLabel>Profile name</FieldLabel>
        <FieldControl>
          <Input
            value={created ? draft.profile : name}
            disabled={created}
            onChange={(e) => {
              setName(e.target.value);
              setServerError(undefined);
            }}
          />
        </FieldControl>
        <FieldError>{fieldError}</FieldError>
      </Field>
    </div>
  );
}
