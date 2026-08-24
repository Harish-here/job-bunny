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
  /** Returns whether the save actually persisted — `false` on a failed PUT
   * (each caller already computes this `ok` flag internally; it must
   * return it, not discard it, so `save()` below — and, through it,
   * `DirtyNavGuard` — can tell a real save from a silently-swallowed
   * failure). */
  onSave: (value: T) => Promise<boolean>;
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
  /** Resolves `true` when the save actually persisted, `false` on a
   * validation failure (non-empty `errors`) or a failed `onSave` — never
   * throws. `DirtyNavGuard`'s "Save and continue" only navigates on
   * `true`. */
  save: () => Promise<boolean>;
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

  async function save(): Promise<boolean> {
    if (Object.keys(errors).length > 0) return false;
    setIsSaving(true);
    const ok = await onSave(currentValue);
    setIsSaving(false);
    if (ok) {
      // `undefined` (still loading) fails toward the more common case
      // rather than blocking the success message on a slow, unrelated
      // query.
      setSuccessMessage(runInFlight === true ? RUNNING_MESSAGE : NOT_RUNNING_MESSAGE);
    }
    return ok;
  }

  function discard(): T {
    setSuccessMessage(null);
    return initialValue;
  }

  return { isDirty, errors, isSaving, successMessage, save, discard };
}
