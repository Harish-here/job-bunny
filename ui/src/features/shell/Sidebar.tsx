import {
  Activity,
  Columns3,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Rocket,
  Settings,
} from 'lucide-react';
import logo from '../../assets/logo.svg';
import wordmark from '../../assets/wordmark.svg';
import { Button } from '../../components/ui/button';
import type { BoardProfile } from '../../lib/api/types';
import type { Route, RouteName } from '../../lib/router';
import { cn } from '../../lib/utils';
import { Mascot } from './Mascot';
import type { MascotState } from './mascotState';
import { ProfileSwitcher } from './ProfileSwitcher';

const NAV_ITEMS: { name: RouteName; label: string; Icon: typeof Inbox }[] = [
  { name: 'triage', label: 'Triage', Icon: Inbox },
  { name: 'tracker', label: 'Tracker', Icon: Columns3 },
  { name: 'runs', label: 'Runs', Icon: Play },
  { name: 'analytics', label: 'Analytics', Icon: Activity },
  { name: 'onboarding', label: 'Onboarding', Icon: Rocket },
  { name: 'settings', label: 'Settings', Icon: Settings },
];

export function Sidebar({
  route,
  profile,
  profiles,
  version,
  collapsed,
  mascot,
  onChoose,
  onNavigate,
  onToggleCollapsed,
}: {
  route: Route;
  profile: string | null;
  profiles: BoardProfile[];
  version: string | undefined;
  collapsed: boolean;
  mascot: MascotState;
  onChoose: (name: string) => void;
  onNavigate: (route: Route) => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside
      data-testid="sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        'flex h-screen shrink-0 flex-col gap-4 border-r border-sidebar-border',
        'bg-sidebar p-3 text-sidebar-foreground hop',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <div
        className={cn(
          'flex',
          collapsed ? 'flex-col items-center gap-2' : 'items-start justify-between',
        )}
      >
        {collapsed ? (
          <img src={logo} alt="Job Bunny" className="size-8" />
        ) : (
          <div className="flex flex-col items-start gap-1">
            <img src={logo} alt="Job Bunny" className="size-14" />
            <img src={wordmark} alt="JOB BUNNY" className="w-[158px]" />
            {version && (
              <div className="font-mono text-xs text-muted-foreground">v{version}</div>
            )}
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Toggle sidebar"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </Button>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = route.name === item.name;
          return (
            <Button
              key={item.name}
              type="button"
              variant="ghost"
              size={collapsed ? 'icon' : 'default'}
              className={cn(
                !collapsed && 'justify-start',
                active && 'bg-sidebar-accent text-sidebar-accent-foreground',
              )}
              aria-current={active ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              onClick={() => onNavigate({ name: item.name })}
            >
              <item.Icon className="size-4" />
              {!collapsed && item.label}
            </Button>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-2">
        <Mascot state={mascot} className="self-center" />
        <ProfileSwitcher
          profile={profile}
          profiles={profiles}
          collapsed={collapsed}
          onChoose={onChoose}
        />
      </div>
    </aside>
  );
}
