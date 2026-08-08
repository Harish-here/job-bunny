import { queryOptions } from '@tanstack/react-query';
import { getDaemonStatus, getPersonas } from './wizard.api';

export const wizardKeys = {
  personas: () => ['personas'] as const,
  daemon: () => ['daemon'] as const,
};

// The persona catalog is baked into the server at startup and does not
// change during a session — same reasoning as profilesKeys' staleTime:
// Infinity.
export const personasQuery = () =>
  queryOptions({
    queryKey: wizardKeys.personas(),
    queryFn: () => getPersonas(),
    staleTime: Infinity,
  });

// Plain query, no staleTime override and no refetchInterval. Daemon status
// CAN change from outside the UI (the daemon ticks on its own schedule),
// so it refetches normally like configDocQuery — and the polling behavior
// spec §2.5 describes belongs to phase 4's Setup & Health hub, not here.
// Do not add a refetchInterval to this query in a later task without
// re-reading that spec section.
export const daemonQuery = () =>
  queryOptions({
    queryKey: wizardKeys.daemon(),
    queryFn: () => getDaemonStatus(),
  });
