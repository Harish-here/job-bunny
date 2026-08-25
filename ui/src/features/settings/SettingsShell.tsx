import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import { navigate, type SettingsSection } from '../../lib/router';
import { SettingsNav } from './SettingsNav';
import { DirtyNavGuard } from './save/DirtyNavGuard';
import { useSettingsSaveGuardState } from './save/SettingsSaveContext';

export interface SettingsShellProps {
  section: SettingsSection;
  profile: string;
  children: ReactNode;
}

/**
 * The Settings-specific two-column nav+main region (blueprint.md:901-910,
 * step 26; mockup-fragment.html's `settings-shell-inner`). `data-qa=
 * "settings-shell"` scopes exactly this region — the global app sidebar
 * (`Sidebar.tsx`) is out of its scope.
 *
 * `DirtyNavGuard` wraps `SettingsNav` per that component's own wiring
 * contract (`DirtyNavGuard.tsx`'s docstring). `isDirty`/`save`/`discard`
 * come from `SettingsSaveContext` — the CURRENTLY mounted section (there is
 * ever only one) registers its own live dirty state into that context via
 * `useRegisterSettingsSave`, so this guard always reflects the actual
 * section on screen rather than a hardcoded-clean stub. The sidebar's own
 * profile switcher / cross-page nav is guarded separately, by `Shell.tsx`,
 * reading the same context.
 */
export function SettingsShell({ section, profile, children }: SettingsShellProps) {
  const { isDirty, save, discard } = useSettingsSaveGuardState();
  return (
    <div
      data-qa="settings-shell"
      className="grid min-h-0 flex-1 grid-cols-[224px_1fr] overflow-hidden"
    >
      <DirtyNavGuard isDirty={isDirty} navigate={navigate} save={save} discard={discard}>
        {(go) => <SettingsNav section={section} navigate={go} />}
      </DirtyNavGuard>
      <main className="flex min-h-0 flex-col gap-4 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge data-qa="scope-chip-profile" variant="secondary">
            Profile: {profile}
          </Badge>
        </div>
        <div
          data-testid="settings-section"
          data-section={section}
          className="flex flex-col gap-4"
        >
          {children}
        </div>
      </main>
    </div>
  );
}
