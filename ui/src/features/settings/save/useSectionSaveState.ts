import { useState } from 'react';
import { useRunInFlight } from './runInFlight';

const NOT_RUNNING_MESSAGE =
  'Saved. Takes effect from your next run — nothing is running right now.';
const RUNNING_MESSAGE =
  'Saved. A run is in progress; this applies to the next run, not that one.';

// Every section's editor state is plain JSON-shaped data (chip arrays, plain
// objects, numbers, strings — never a Map/Set/class instance/function), so a
// JSON.stringify comparison is sufficient. Mirrors the posture useDocForm's
// own save() already takes (re-parsing raw text at save time rather than
// diffing structurally) — no deep-equality dependency needed.
function deepEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface UseSectionSaveStateArgs<T> {
  profile: string;
  initialValue: T;
  currentValue: T;
  validate: (value: T) => Record<string, string>;
  onSave: (value: T) => Promise<void>;
}

// `discard()` does not own the caller's state setter (`currentValue` is
// passed in, not owned here): it clears `errors`/`successMessage` and
// returns `initialValue`, which task 5's `SaveBar` uses to reset its own
// state (e.g. `setCurrentValue(discard())`).
export interface UseSectionSaveStateResult<T> {
  isDirty: boolean;
  errors: Record<string, string>;
  isSaving: boolean;
  successMessage: string | null;
  save: () => Promise<void>;
  discard: () => T;
}

export function useSectionSaveState<T>(
  args: UseSectionSaveStateArgs<T>,
): UseSectionSaveStateResult<T> {
  const { profile, initialValue, currentValue, validate, onSave } = args;
  const runInFlight = useRunInFlight(profile);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isDirty = !deepEqual(initialValue, currentValue);
  const errors = validate(currentValue);

  async function save(): Promise<void> {
    if (Object.keys(errors).length > 0) return;
    setIsSaving(true);
    await onSave(currentValue);
    setIsSaving(false);
    // `undefined` (still loading) fails toward the more common case rather
    // than blocking the success message on a slow, unrelated query.
    setSuccessMessage(runInFlight === true ? RUNNING_MESSAGE : NOT_RUNNING_MESSAGE);
  }

  function discard(): T {
    setSuccessMessage(null);
    return initialValue;
  }

  return { isDirty, errors, isSaving, successMessage, save, discard };
}
