import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { pickProfile, useStoredProfile } from '../../lib/profile';
import { navigate, type Route, useRoute } from '../../lib/router';
import { Sidebar } from './Sidebar';
import { useAppInfo } from './useAppInfo';
import { useProfilesQuery } from './useProfiles';

/**
 * Placeholder for the route's page content — Tasks 6-10 replace each branch
 * with the real Triage/Tracker/Job/Analytics/Onboarding feature component.
 */
function Page({ route, profile }: { route: Route; profile: string }) {
  switch (route.name) {
    case 'triage':
      return <div className="p-4">Triage — {profile}</div>;
    case 'tracker':
      return <div className="p-4">Tracker — {profile}</div>;
    case 'analytics':
      return <div className="p-4">Analytics — {profile}</div>;
    case 'onboarding':
      return <div className="p-4">Onboarding — {profile}</div>;
    case 'job':
      return (
        <div className="p-4">
          Job {route.id} — {profile}
        </div>
      );
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
