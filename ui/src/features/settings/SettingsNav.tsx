import type { KeyboardEvent } from 'react';
import { useRef, useState } from 'react';
import type { Route, SettingsSection } from '../../lib/router';
import { cn } from '../../lib/utils';

interface NavLink {
  label: string;
  section: SettingsSection;
}

interface NavGroup {
  label: string;
  dataQa: string;
  links: NavLink[];
}

// mockup-fragment.html's settings-nav region — 4 groups, 12 links total
// (blueprint.md:911-925, step 27). Order and grouping are the design
// authority; do not reorder or regroup.
const GROUPS: NavGroup[] = [
  {
    label: 'Aim',
    dataQa: 'settings-nav-group-aim',
    links: [
      { label: 'What decides your board', section: 'landing' },
      { label: 'Roles & companies', section: 'roles-companies' },
      { label: "Where you'll work", section: 'where-you-work' },
      { label: 'Skills', section: 'skills' },
      { label: 'About you', section: 'about-you' },
    ],
  },
  {
    label: 'Runs',
    dataQa: 'settings-nav-group-runs',
    links: [
      { label: 'Where jobs come from', section: 'where-jobs-come-from' },
      { label: 'Schedule', section: 'schedule' },
      { label: 'Fetching', section: 'fetching' },
    ],
  },
  {
    label: 'Output',
    dataQa: 'settings-nav-group-output',
    links: [
      { label: 'Delivery', section: 'delivery' },
      { label: 'Housekeeping', section: 'housekeeping' },
    ],
  },
  {
    label: 'Advanced',
    dataQa: 'settings-nav-group-advanced',
    links: [
      { label: 'Raw config', section: 'raw-config' },
      { label: 'Danger zone', section: 'danger' },
    ],
  },
];

const FLAT_LINKS: NavLink[] = GROUPS.flatMap((g) => g.links);

export interface SettingsNavProps {
  section: SettingsSection;
  /** The navigation function links call — either the real `navigate`
   * (`ui/src/lib/router.ts`) or `DirtyNavGuard`'s wrapped `guardedNavigate`,
   * per that component's own render-prop wiring contract
   * (`DirtyNavGuard.tsx`'s docstring: `<DirtyNavGuard>{(go) =>
   * <SettingsNav navigate={go} />}</DirtyNavGuard>`). `SettingsNav` itself
   * has no opinion on dirty-navigation guarding — that's the caller's job. */
  navigate: (route: Route) => void;
}

/**
 * The Settings sections nav column (blueprint.md:915-925, step 27;
 * mockup-fragment.html's `settings-nav`). Roving tabindex per ux-notes §14:
 * only the currently-focused link is `tabIndex={0}`; up/down arrow keys move
 * focus between links (wrapping); Enter activates the focused link via the browser's own
 * native button-click behaviour. Rendered as `<button>`, not `<a>`
 * (`Sidebar.tsx`'s own precedent for hash-routed nav items, matching
 * biome's `lint/a11y/useValidAnchor` — this is client-side routing, never a
 * real navigable `href`).
 */
export function SettingsNav({ section, navigate }: SettingsNavProps) {
  const activeIndex = FLAT_LINKS.findIndex((l) => l.section === section);
  const [focusedIndex, setFocusedIndex] = useState(activeIndex >= 0 ? activeIndex : 0);
  const linkRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (index + delta + FLAT_LINKS.length) % FLAT_LINKS.length;
    setFocusedIndex(next);
    linkRefs.current[next]?.focus();
  }

  let globalIndex = -1;

  return (
    <nav
      aria-label="Settings sections"
      data-qa="settings-nav"
      className="flex h-full flex-col gap-3 overflow-hidden border-r border-border bg-sidebar p-3"
    >
      {GROUPS.map((group) => (
        <div key={group.dataQa} data-qa={group.dataQa} className="flex flex-col gap-1">
          <div className="px-2 text-micro font-medium uppercase tracking-[0.04em] text-muted-foreground">
            {group.label}
          </div>
          <ul className="flex flex-col gap-1">
            {group.links.map((link) => {
              globalIndex += 1;
              const index = globalIndex;
              const active = link.section === section;
              return (
                <li key={link.section}>
                  <button
                    type="button"
                    ref={(el) => {
                      linkRefs.current[index] = el;
                    }}
                    tabIndex={index === focusedIndex ? 0 : -1}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-8 w-full items-center rounded-lg px-2 text-left text-sm',
                      active && 'bg-sidebar-accent font-medium',
                    )}
                    onFocus={() => setFocusedIndex(index)}
                    onKeyDown={(event) => handleKeyDown(event, index)}
                    onClick={() => navigate({ name: 'settings', section: link.section })}
                  >
                    {link.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
