import { useQuery } from '@tanstack/react-query';
import { listRuns } from '../../runs/runs.api';

/** Whether a run is CURRENTLY in flight for `profile`, per the runs table —
 * the primary and ONLY signal, because it's written by every run regardless
 * of what spawned it (CLI `jobbunny run`, the daemon, `stage`, etc). Do NOT
 * read `GET /api/daemon`'s `inFlight` for this: that field comes from the
 * daemon's own pidfile and misses a CLI-initiated run entirely. Returns
 * `undefined` while the underlying query is still pending (mirrors
 * `useQuery`'s own `isPending`), so callers can distinguish "don't know yet"
 * from a real `false`. Keyed distinctly from the Runs page's own
 * `runsKeys.list` query (`runsQuery`, `limit: 100`) so the two single-purpose
 * fetches never collide or overwrite each other in the cache. */
export function useRunInFlight(profile: string): boolean | undefined {
  const query = useQuery({
    queryKey: [profile, 'runs', 'run-in-flight'] as const,
    queryFn: () => listRuns(profile, { limit: 1 }),
    enabled: profile !== '',
  });
  if (query.isPending) return undefined;
  return query.data?.rows[0]?.status === 'running';
}
