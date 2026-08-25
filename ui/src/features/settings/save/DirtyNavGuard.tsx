import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';

// Generic over the navigation TARGET type, not fixed to `Route`: the
// sidebar's own `onChoose` (a profile switch) takes a bare `string`, not a
// `Route`, and per the S8 save model's own spec ("wraps navigate() calls
// originating from SettingsNav.tsx AND the sidebar profile switcher",
// blueprint.md:503-510) both need guarding with the same dialog mechanics —
// `Shell.tsx` wraps `Sidebar`'s `onNavigate` (`T = Route`) and `onChoose`
// (`T = string`) in two separate `DirtyNavGuard<...>` instances, both
// driven by the same underlying dirty flag.
export interface DirtyNavGuardProps<T> {
  /** The current section's dirty flag (`useSectionSaveState`'s `isDirty`,
   * lifted via `SettingsSaveContext`). */
  isDirty: boolean;
  /** The real navigation function for this target type — the app-wide
   * `navigate` (`ui/src/lib/router.ts:57-59`) for `T = Route`, or
   * `setStored` (`ui/src/lib/profile.ts`) for `T = string` — or a
   * test-injected stand-in. */
  navigate: (target: T) => void;
  /** `useSectionSaveState`'s `save` — reports whether the save actually
   * succeeded (`false` for a non-empty `errors` map or a failed PUT), never
   * throws. `handleSaveAndContinue` below only navigates on `true`; on
   * `false` it keeps the dialog open so the section's own validation
   * summary / server error (rendered underneath, in the still-mounted
   * section) stays visible instead of being unmounted out from under the
   * user by a navigate that silently discarded their unsaved, un-persisted
   * edit. */
  save: () => Promise<boolean>;
  /** A caller-supplied discard that also applies the reverted value back
   * onto the caller's draft state (mirrors `SaveBar`'s `onDiscard`). */
  discard: () => void;
  /** Render-prop: receives the wrapped navigate function to hand to
   * whatever triggers navigation — usage:
   * `<DirtyNavGuard ...>{(go) => <SettingsNav navigate={go} />}</DirtyNavGuard>`. */
  children: (guardedNavigate: (target: T) => void) => ReactNode;
}

/**
 * The S8 save model's dirty-navigation guard (blueprint.md:503-510). When
 * `isDirty` is true, a wrapped navigation attempt is intercepted and a
 * confirmation dialog is shown instead of navigating immediately; when
 * `isDirty` is false, navigation passes straight through.
 */
export function DirtyNavGuard<T>({
  isDirty,
  navigate,
  save,
  discard,
  children,
}: DirtyNavGuardProps<T>) {
  const [pendingTarget, setPendingTarget] = useState<T | null>(null);
  // Set when `save()` resolves `false` while the dialog is open — the
  // section's own validation summary / server error renders UNDER the
  // modal overlay (still mounted, but hidden), so without this the dialog
  // just... sits there with no visible reason "Save and continue" didn't
  // move. Reset on every fresh guarded-navigate attempt and on Discard/Stay
  // so a stale failure from a PRIOR pending target never lingers into the
  // next one.
  const [saveFailed, setSaveFailed] = useState(false);

  function guardedNavigate(target: T) {
    if (isDirty) {
      setSaveFailed(false);
      setPendingTarget(target);
      return;
    }
    navigate(target);
  }

  async function handleSaveAndContinue() {
    if (pendingTarget === null) return;
    const target = pendingTarget;
    const ok = await save();
    if (!ok) {
      setSaveFailed(true);
      return; // validation failure or failed PUT — stay put, dialog stays open
    }
    setSaveFailed(false);
    setPendingTarget(null);
    navigate(target);
  }

  function handleDiscardAndContinue() {
    if (pendingTarget === null) return;
    const target = pendingTarget;
    discard();
    setSaveFailed(false);
    setPendingTarget(null);
    navigate(target);
  }

  function handleStay() {
    setSaveFailed(false);
    setPendingTarget(null);
  }

  return (
    <>
      {children(guardedNavigate)}
      <Dialog
        open={pendingTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setSaveFailed(false);
            setPendingTarget(null);
          }
        }}
      >
        <DialogContent data-qa="dirty-nav-dialog" data-testid="dirty-nav-dialog">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes on this section. What would you like to do?
            </DialogDescription>
          </DialogHeader>
          {saveFailed && (
            <p
              data-qa="dirty-nav-save-error"
              data-testid="dirty-nav-save-error"
              className="text-sm text-destructive"
            >
              Couldn't save — fix the errors on the section first.
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleSaveAndContinue}
            >
              Save and continue
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDiscardAndContinue}
            >
              Discard changes
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleStay}>
              Stay here
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
