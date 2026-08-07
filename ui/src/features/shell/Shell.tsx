import { useEffect } from 'react';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { pickProfile, useStoredProfile } from '../../lib/profile';
import { navigate, type Route, useRoute } from '../../lib/router';
import { AnalyticsPage } from '../analytics/AnalyticsPage';
import { JobPage } from '../job/JobPage';
import { OnboardingPage } from '../onboarding/OnboardingPage';
import { RunsPage } from '../runs/RunsPage';
import { useRun, useRuns } from '../runs/useRunsData';
import { SettingsPage } from '../settings/SettingsPage';
import { TrackerPage } from '../tracker/TrackerPage';
import { TriagePage } from '../triage/TriagePage';
import { pickMascotState } from './mascotState';
import { Sidebar } from './Sidebar';
import { useAppInfo } from './useAppInfo';
import { useProfilesQuery } from './useProfiles';
import { useSidebarCollapsed } from './useSidebarCollapsed';

/** Full route switch (T10) — the real Triage/Tracker/Job/Analytics/Onboarding
 * feature component per route, each fed the resolved profile (and, for
 * `job`, the route's id). */
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
      return <OnboardingPage />;
    case 'settings':
      return <SettingsPage profile={profile} />;
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

/** Phase 4 replaces this with the pending run-intent selector (spec §2.4);
 * phase 2 has no intent table to read, so the ears-up state ships wired to
 * a constant and is exercised by mascotState.test.ts. */
const QUEUED_STUB = false;

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
  // fallback while `profilesQuery` is still settling. `useRuns('')` during
  // that brief window (or for a profile with no jobbunny.db) degrades to an
  // errored/empty query — `runs` falls back to `[]`, and `pickMascotState`
  // already treats an empty `runs` array as "asleep" (its own
  // failure-tolerance contract: never throw, never block the shell).
  const profiles = profilesQuery.data?.profiles ?? [];
  const profile = pickProfile(stored, profiles);

  const runsQuery = useRuns(profile ?? '');
  const runs = runsQuery.data?.rows ?? [];
  const newestId = runs.reduce((max, r) => Math.max(max, r.id), -1);
  const detail = useRun(profile ?? '', newestId);
  const mascot = pickMascotState({
    runs,
    newestResult: detail.data?.result,
    queued: QUEUED_STUB,
    now: Date.now(),
  });

  if (profilesQuery.isPending) return <ShellSkeleton />;

  if (profilesQuery.isError) {
    return <UnreachableState onRetry={() => profilesQuery.refetch()} />;
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
        onChoose={setStored}
        onNavigate={navigate}
        onToggleCollapsed={() => setCollapsed(!collapsed)}
      />
      <main className="flex-1">
        {profile ? (
          <Page route={route} profile={profile} />
        ) : (
          <div className="p-4 text-muted-foreground">No profile available.</div>
        )}
      </main>
    </div>
  );
}
