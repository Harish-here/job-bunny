import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { pickProfile, useStoredProfile } from '../../lib/profile';
import { navigate, type Route, useRoute } from '../../lib/router';
import { AnalyticsPage } from '../analytics/AnalyticsPage';
import { JobPage } from '../job/JobPage';
import { OnboardingPage } from '../onboarding/OnboardingPage';
import { RunsPage } from '../runs/RunsPage';
import { SettingsPage } from '../settings/SettingsPage';
import { TrackerPage } from '../tracker/TrackerPage';
import { TriagePage } from '../triage/TriagePage';
import { Sidebar } from './Sidebar';
import { useAppInfo } from './useAppInfo';
import { useProfilesQuery } from './useProfiles';

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

export function Shell() {
  const route = useRoute();
  const profilesQuery = useProfilesQuery();
  const appInfo = useAppInfo();
  const [stored, setStored] = useStoredProfile();

  if (profilesQuery.isPending) return <ShellSkeleton />;

  if (profilesQuery.isError) {
    return <UnreachableState onRetry={() => profilesQuery.refetch()} />;
  }

  const profiles = profilesQuery.data.profiles;
  const profile = pickProfile(stored, profiles);

  return (
    <div className="flex">
      <Sidebar
        route={route}
        profile={profile}
        profiles={profiles}
        version={appInfo.data?.version}
        onChoose={setStored}
        onNavigate={navigate}
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
