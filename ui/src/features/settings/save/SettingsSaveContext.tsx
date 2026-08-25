/**
 * The S8 save model's cross-shell dirty-lift (fix for the settings-overhaul
 * fix-round finding on `SettingsShell.tsx`/`DirtyNavGuard.tsx`). Before this
 * module existed, `SettingsShell.tsx` passed `DirtyNavGuard` a hardcoded
 * `isDirty={false}` with no-op `save`/`discard` — every section owned its
 * own `useSectionSaveState` locally and never surfaced it, so
 * `DirtyNavGuard.guardedNavigate` always took the clean-navigate branch and
 * a dirty section could be silently unmounted by a nav click, a sidebar
 * profile switch, or the sidebar's own `onNavigate` (leaving the app
 * entirely). This context is the single place that dirty state now lives:
 * exactly one section is ever mounted at a time (`SettingsPage.tsx`'s
 * `SectionBody` switch), so a single "currently registered" slot is
 * sufficient — no per-section id needed.
 *
 * `SettingsSaveProvider` must wrap BOTH the settings feature and the app
 * shell that owns the sidebar's profile switcher (`App.tsx`, above
 * `<Shell/>`) — `Shell.tsx` and `SettingsShell.tsx` both read
 * `useSettingsSaveGuardState()` and each wrap their own navigation trigger
 * in its own `DirtyNavGuard` instance, driven by the same underlying dirty
 * flag (only one can ever actually be triggered by a click at a time).
 *
 * `guardedNavigate` (fix-round-2 finding) closes the same gap for
 * IN-SECTION navigation triggers — e.g. `RawConfigSection`'s "has a form →"
 * badges, or a footer "see the raw doc" link on another section — that
 * don't go through `SettingsNav` or the sidebar at all. The provider wraps
 * its own `children` in a THIRD `DirtyNavGuard<Route>` instance (same
 * pattern `Shell.tsx`'s `GuardedSidebar` already uses for two): only one of
 * the three can ever actually be triggered by a single click, so the extra
 * instance never conflicts with the other two.
 */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type Route, navigate as realNavigate } from '../../../lib/router';
import { DirtyNavGuard } from './DirtyNavGuard';

export interface RegisteredSectionSave {
  isDirty: boolean;
  /** Reports true/false — see `useSectionSaveState`'s own `save()` doc
   * comment. Never throws. */
  save: () => Promise<boolean>;
  /** Applies the reverted value back onto the section's own draft state —
   * same contract `SaveBar`'s `onDiscard` prop already carries (e.g.
   * `() => setState(saveState.discard())`), not the bare
   * `useSectionSaveState.discard()` which only RETURNS a value. */
  discard: () => void;
}

interface SettingsSaveContextValue {
  isDirty: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
  register: (state: RegisteredSectionSave | null) => void;
  /** Guarded equivalent of the app-wide `navigate()` for triggers that live
   * INSIDE a settings section's own render tree (not `SettingsNav`, not the
   * sidebar — those already have their own dedicated `DirtyNavGuard`
   * instances). Delegates to the provider's own internal `DirtyNavGuard<Route>`
   * — see this module's doc comment. Outside a `SettingsSaveProvider`, this
   * is the plain unguarded `navigate` (there is no dirty state to guard). */
  guardedNavigate: (target: Route) => void;
}

async function noopSave(): Promise<boolean> {
  return true;
}
function noopDiscard(): void {}

const SettingsSaveContext = createContext<SettingsSaveContextValue>({
  isDirty: false,
  save: noopSave,
  discard: noopDiscard,
  register: () => {},
  guardedNavigate: realNavigate,
});

export function SettingsSaveProvider({ children }: { children: ReactNode }) {
  const [isDirty, setIsDirty] = useState(false);
  // The live registered section, read at CALL time (not render time) by
  // `save`/`discard` below — so a click on "Save and continue" always
  // invokes the section's current draft-closing closures, never a stale
  // one captured at the guard's last render.
  const currentRef = useRef<RegisteredSectionSave | null>(null);
  // Set on every render by the internal `DirtyNavGuard<Route>`'s own
  // render-prop below — read at CALL time by `guardedNavigate`, same
  // "never a stale closure" reasoning as `currentRef` above.
  const goRef = useRef<(target: Route) => void>(realNavigate);

  function register(state: RegisteredSectionSave | null): void {
    currentRef.current = state;
    setIsDirty(state?.isDirty ?? false);
  }

  const save = () => currentRef.current?.save() ?? noopSave();
  const discard = () => currentRef.current?.discard();

  const value: SettingsSaveContextValue = {
    isDirty,
    save,
    discard,
    register,
    guardedNavigate: (target) => goRef.current(target),
  };

  return (
    <SettingsSaveContext.Provider value={value}>
      <DirtyNavGuard<Route>
        isDirty={isDirty}
        navigate={realNavigate}
        save={save}
        discard={discard}
      >
        {(go) => {
          goRef.current = go;
          return children;
        }}
      </DirtyNavGuard>
    </SettingsSaveContext.Provider>
  );
}

/** Read by `SettingsShell.tsx` (wraps `SettingsNav`) and `Shell.tsx` (wraps
 * the sidebar's `onNavigate`/`onChoose`) — the live dirty flag plus stable
 * delegators to whichever section is currently registered. */
export function useSettingsSaveGuardState(): {
  isDirty: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
} {
  const { isDirty, save, discard } = useContext(SettingsSaveContext);
  return { isDirty, save, discard };
}

/** Read by any in-section navigation trigger (e.g. `RawConfigSection`'s
 * "has a form →" badges, or a footer link pointing at another section) that
 * needs to leave the currently-mounted section without going through
 * `SettingsNav` or the sidebar. See this module's doc comment. */
export function useGuardedNavigate(): (target: Route) => void {
  const { guardedNavigate } = useContext(SettingsSaveContext);
  return guardedNavigate;
}

/** Called by every SaveBar-owning section (and `RawConfigSection`, which
 * tracks its own dirty flag locally rather than via `useSectionSaveState`).
 * Re-registers on every render, so `save`/`discard` always close over the
 * section's current draft; unregisters (dirty resets to `false`) on
 * unmount, so navigating away by any means other than the guard (there is
 * none today, but a future direct route change) can't leave a stale dirty
 * flag pinned on. Pass `null` while the section hasn't loaded its baseline
 * yet, so an initial empty-vs-loading render is never mistaken for dirty. */
export function useRegisterSettingsSave(state: RegisteredSectionSave | null): void {
  const { register } = useContext(SettingsSaveContext);
  useEffect(() => {
    register(state);
    return () => register(null);
  }, [register, state]);
}
