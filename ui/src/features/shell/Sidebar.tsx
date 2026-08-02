import logo from '../../assets/logo.svg';
import { Button } from '../../components/ui/button';
import type { BoardProfile } from '../../lib/api/types';
import type { Route, RouteName } from '../../lib/router';
import { cn } from '../../lib/utils';
import { ProfileSwitcher } from './ProfileSwitcher';

const NAV_ITEMS: { name: RouteName; label: string }[] = [
  { name: 'triage', label: 'Triage' },
  { name: 'tracker', label: 'Tracker' },
  { name: 'analytics', label: 'Analytics' },
  { name: 'onboarding', label: 'Onboarding' },
];

export function Sidebar({
  route,
  profile,
  profiles,
  version,
  onChoose,
  onNavigate,
}: {
  route: Route;
  profile: string | null;
  profiles: BoardProfile[];
  version: string | undefined;
  onChoose: (name: string) => void;
  onNavigate: (route: Route) => void;
}) {
  return (
    <aside className="flex h-screen w-56 flex-col gap-4 border-r p-4">
      <div className="flex items-center gap-2">
        <img src={logo} alt="Job Bunny" className="size-7" />
        <div>
          <div className="font-bold leading-tight">Job Bunny</div>
          {version && <div className="text-xs text-muted-foreground">v{version}</div>}
        </div>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = route.name === item.name;
          return (
            <Button
              key={item.name}
              type="button"
              variant="ghost"
              className={cn('justify-start', active && 'bg-muted text-foreground')}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate({ name: item.name })}
            >
              {item.label}
            </Button>
          );
        })}
      </nav>
      <div className="mt-auto">
        <ProfileSwitcher profile={profile} profiles={profiles} onChoose={onChoose} />
      </div>
    </aside>
  );
}
