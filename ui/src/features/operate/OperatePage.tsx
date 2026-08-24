import { Badge } from '../../components/ui/badge';
import { DaemonCard } from './DaemonCard';
import { ScheduledRunsCard } from './ScheduledRunsCard';
import { SecretsCard } from './SecretsCard';
import { SetupHealthCard } from './SetupHealthCard';

/**
 * The Operate page (blueprint step 29) — replaces `HubPage.tsx`. Renders
 * the four cards built by tasks 33-36, each self-fetching off its own
 * query (`GET /api/daemon`, `GET /api/profiles/:name/doctor`,
 * `GET /api/secrets`), so one card's error state never blanks the others.
 *
 * FOUR cards, not the blueprint text's five: `card-linkedin` is
 * deliberately absent here. It merges LinkedIn session health with the
 * throttle breaker and, by design, must never show one without the
 * other — but the backend session-health slice it needs is itself
 * blocked. A later, separately-briefed change adds it whole. Neither a
 * breaker-only substitute nor an empty grid slot is rendered in its
 * place.
 *
 * Degraded (mockup S7) is not a separate component — it's a state each
 * card already renders for itself (`DaemonCard`'s own
 * `worstSeverity`/accent handling). `SecretsCard` spans the full grid
 * width via its own `col-span-full` class (see `SecretsCard.tsx`).
 */
export function OperatePage({ profile }: { profile: string }) {
  return (
    <div
      data-qa="operate-shell"
      className="flex h-full flex-col gap-6 overflow-y-auto p-6"
    >
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold font-heading">Operate</h1>
        <Badge data-qa="scope-chip-machine" className="bg-accent text-primary">
          This machine · all profiles
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DaemonCard profile={profile} />
        <ScheduledRunsCard profile={profile} />
        <SetupHealthCard profile={profile} />
        <SecretsCard />
      </div>
    </div>
  );
}
