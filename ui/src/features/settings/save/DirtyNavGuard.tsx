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
import type { Route } from '../../../lib/router';

export interface DirtyNavGuardProps {
  /** The current section's dirty flag (`useSectionSaveState`'s `isDirty`). */
  isDirty: boolean;
  /** The real app-wide `navigate` (`ui/src/lib/router.ts:57-59`), or a
   * test-injected stand-in. */
  navigate: (route: Route) => void;
  /** `useSectionSaveState`'s `save`. */
  save: () => void | Promise<void>;
  /** A caller-supplied discard that also applies the reverted value back
   * onto the caller's draft state (mirrors `SaveBar`'s `onDiscard`). */
  discard: () => void;
  /** Render-prop: receives the wrapped navigate function to hand to
   * whatever triggers navigation (task 22 wires this into `SettingsNav` and
   * the sidebar's profile switcher — usage there is
   * `<DirtyNavGuard ...>{(go) => <SettingsNav navigate={go} />}</DirtyNavGuard>`). */
  children: (guardedNavigate: (route: Route) => void) => ReactNode;
}

/**
 * The S8 save model's dirty-navigation guard (blueprint.md:503-510). When
 * `isDirty` is true, a wrapped navigation attempt is intercepted and a
 * confirmation dialog is shown instead of navigating immediately; when
 * `isDirty` is false, navigation passes straight through.
 */
export function DirtyNavGuard({
  isDirty,
  navigate,
  save,
  discard,
  children,
}: DirtyNavGuardProps) {
  const [pendingRoute, setPendingRoute] = useState<Route | null>(null);

  function guardedNavigate(route: Route) {
    if (isDirty) {
      setPendingRoute(route);
      return;
    }
    navigate(route);
  }

  async function handleSaveAndContinue() {
    if (pendingRoute === null) return;
    const target = pendingRoute;
    await save();
    setPendingRoute(null);
    navigate(target);
  }

  function handleDiscardAndContinue() {
    if (pendingRoute === null) return;
    const target = pendingRoute;
    discard();
    setPendingRoute(null);
    navigate(target);
  }

  function handleStay() {
    setPendingRoute(null);
  }

  return (
    <>
      {children(guardedNavigate)}
      <Dialog
        open={pendingRoute !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRoute(null);
        }}
      >
        <DialogContent data-qa="dirty-nav-dialog" data-testid="dirty-nav-dialog">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes on this section. What would you like to do?
            </DialogDescription>
          </DialogHeader>
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
