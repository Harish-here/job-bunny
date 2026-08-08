import { queryOptions } from '@tanstack/react-query';
import { listRunIntents } from './intents.api';

export const runControlKeys = {
  intents: (p: string) => [p, 'run-intents'] as const,
};

// enabled: p !== '' mirrors runs.queries.ts's runsQuery guard — keeps a
// still-resolving profile from firing a request against
// /api/profiles//run-intents.
export const runIntentsQuery = (p: string) =>
  queryOptions({
    queryKey: runControlKeys.intents(p),
    queryFn: () => listRunIntents(p),
    enabled: p !== '',
  });
