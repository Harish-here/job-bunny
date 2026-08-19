import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import { navigate, type SettingsSection } from '../../lib/router';
import { SettingsNav } from './SettingsNav';
import { DirtyNavGuard } from './save/DirtyNavGuard';

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
 * contract (`DirtyNavGuard.tsx`'s docstring). No section currently lifts its
 * `useSectionSaveState` dirty flag up to this shell — each section owns and
 * renders its own `SaveBar` locally — so `isDirty`/`save`/`discard` here are
 * a structural stub (always clean) until a later task lifts real
 * per-section dirty state up to this level; see this brief's own NOTES.
 */
export function SettingsShell({ section, profile, children }: SettingsShellProps) {
  return (
    <div
      data-qa="settings-shell"
      className="grid min-h-0 flex-1 grid-cols-[224px_1fr] overflow-hidden"
    >
      <DirtyNavGuard
        isDirty={false}
        navigate={navigate}
        save={() => {}}
        discard={() => {}}
      >
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
