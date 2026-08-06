import { useQuery } from '@tanstack/react-query';
import { runEventsQuery, runQuery, runsQuery } from './runs.queries';

export function useRuns(profile: string) {
  return useQuery(runsQuery(profile));
}

export function useRun(profile: string, id: number) {
  return useQuery(runQuery(profile, id));
}

export function useRunEvents(profile: string, id: number) {
  return useQuery(runEventsQuery(profile, id));
}
