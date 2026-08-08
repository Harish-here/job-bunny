import { useEffect } from 'react';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { pickProfile, useStoredProfile } from '../../lib/profile';
import { navigate, type Route, useRoute } from '../../lib/router';
import { AnalyticsPage } from '../analytics/AnalyticsPage';
import { HubPage } from '../hub/HubPage';
import { JobPage } from '../job/JobPage';
import { useRunControl } from '../runcontrol/useRunControl';
import { RunsPage } from '../runs/RunsPage';
import { useRun, useRuns } from '../runs/useRunsData';
import { SettingsPage } from '../settings/SettingsPage';
import { TrackerPage } from '../tracker/TrackerPage';
import { TriagePage } from '../triage/TriagePage';
import { WizardPage } from '../wizard/WizardPage';
import { pickMascotState } from './mascotState';
import { Sidebar } from './Sidebar';
import { useAppInfo } from './useAppInfo';
import { useProfilesQuery } from './useProfiles';
import { useSidebarCollapsed } from './useSidebarCollapsed';

/** Full route switch (T10; phase 3 task 4 drops the 'onboarding' case —
 * `Shell` renders `<WizardPage />` full-screen for that route before
 * `Page` is ever called, so this switch is unreachable for it. */
function Page({ route, profile }: { route: Route; profile: string }) {
  switch (route.name) {
    case 'triage':
      return <TriagePage profile={profile} />;
    case 'tracker':
      return <TrackerPage profile={profile} />;
    case 'runs':
      return <RunsPage profile={profile} />;
    case 'analytics':
      return <AnalyticsPage />;
    case 'onboarding':
      return null; // unreachable: Shell short-circuits to <WizardPage/> above
    case 'setup':
      return <HubPage profile={profile} />;
    case 'settings':
      return (
        <SettingsPage
          profile={profile}
          section={'section' in route ? route.section : 'profile'}
        />
      );
    case 'job':
      return <JobPage profile={profile} id={route.id} />;
  }
}

function ShellSkeleton() {
  return (
    <div className="flex h-screen w-56 flex-col gap-4 border-r p-4">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function UnreachableState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <p className="text-muted-foreground">Can't reach the Job Bunny server.</p>
      <Button type="button" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function Shell() {
  const route = useRoute();
  const profilesQuery = useProfilesQuery();
  const appInfo = useAppInfo();
  const [stored, setStored] = useStoredProfile();
  const [collapsed, setCollapsed] = useSidebarCollapsed();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed(!collapsed);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed, setCollapsed]);

  // Hooks must run unconditionally, so `profile` is resolved here (not
  // after the pending/error returns below) with an empty-array/null
  // fallback while `profilesQuery` is still settling. `runsQuery`'s
  // `enabled: p !== ''` guard keeps `useRuns('')` from firing during that
  // brief window (no request against `/api/profiles//runs`) — `runs` falls
  // back to `[]` either way, and `pickMascotState` already treats an empty
  // `runs` array as "asleep" (its own failure-tolerance contract: never
  // throw, never block the shell). A profile with no jobbunny.db still
  // fires the request and degrades to an errored/empty query.
  const profiles = profilesQuery.data?.profiles ?? [];
  const profile = pickProfile(stored, profiles);

  // First-boot redirect (phase 3 task 4): once the profiles query has
  // resolved successfully and there are zero profiles, send the user to
  // the wizard — unless they are already there. Never while loading
  // (`profilesQuery.isSuccess` is false then) and never on error (that
  // stays the retry screen below, not a silently-substituted wizard).
  const noProfiles = profilesQuery.isSuccess && profiles.length === 0;
  useEffect(() => {
    if (noProfiles && route.name !== 'onboarding') {
      navigate({ name: 'onboarding' });
    }
  }, [noProfiles, route.name]);

  const control = useRunControl(profile ?? '');
  const runsQuery = useRuns(profile ?? '');
  const runs = runsQuery.data?.rows ?? [];
  const newestId = runs.reduce((max, r) => Math.max(max, r.id), -1);
  const detail = useRun(profile ?? '', newestId);
  const mascot = pickMascotState({
    runs,
    newestResult: detail.data?.result,
    queued: control.state.kind === 'queued',
    now: Date.now(),
  });

  if (profilesQuery.isPending) return <ShellSkeleton />;

  if (profilesQuery.isError) {
    return <UnreachableState onRetry={() => profilesQuery.refetch()} />;
  }

  // Full-screen: the wizard owns the whole viewport — no Sidebar, no
  // profile switcher, no `<main>` wrapper. `noProfiles` also covers the
  // one-render gap before the redirect effect above actually fires (in
  // that gap `profile` is still `null`; falling through to the two-column
  // branch below would hand `Page` a non-string profile).
  if (route.name === 'onboarding' || noProfiles) {
    return <WizardPage />;
  }

  if (profile === null) {
    // Unreachable: `noProfiles` (the only way `pickProfile` returns null)
    // already returned above.
    return null;
  }

  return (
    <div className="flex">
      <Sidebar
        route={route}
        profile={profile}
        profiles={profiles}
        version={appInfo.data?.version}
        collapsed={collapsed}
        mascot={mascot}
        runControl={control}
        onChoose={setStored}
        onNavigate={navigate}
        onToggleCollapsed={() => setCollapsed(!collapsed)}
      />
      <main className="flex-1">
        <Page route={route} profile={profile} />
      </main>
    </div>
  );
}
