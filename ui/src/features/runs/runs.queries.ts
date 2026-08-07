import { queryOptions } from '@tanstack/react-query';
import { getRun, listRunEvents, listRuns } from './runs.api';

const EVENTS_LIMIT = 500;

export const runsKeys = {
  list: (p: string) => [p, 'runs'] as const,
  detail: (p: string, id: number) => [p, 'runs', id] as const,
  events: (p: string, id: number) => [p, 'runs', id, 'events'] as const,
};

export const runsQuery = (p: string) =>
  queryOptions({
    queryKey: runsKeys.list(p),
    queryFn: () => listRuns(p, { limit: 100 }),
    enabled: p !== '',
  });

export const runQuery = (p: string, id: number) =>
  queryOptions({
    queryKey: runsKeys.detail(p, id),
    queryFn: () => getRun(p, id),
    enabled: id > 0,
  });

// Level filtering (T11) is client-side over one bounded fetch — the read
// route (features/runs/routes.ts) only accepts limit/offset, no `level`.
export const runEventsQuery = (p: string, id: number) =>
  queryOptions({
    queryKey: runsKeys.events(p, id),
    queryFn: () => listRunEvents(p, id, { limit: EVENTS_LIMIT }),
    enabled: id > 0,
  });
