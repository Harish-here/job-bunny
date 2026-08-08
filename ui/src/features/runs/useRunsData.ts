import { useQuery } from '@tanstack/react-query';
import { runEventsQuery, runQuery, runsQuery } from './runs.queries';

export function useRuns(profile: string, poll: number | false = false) {
  return useQuery({ ...runsQuery(profile), refetchInterval: poll });
}

export function useRun(profile: string, id: number, poll: number | false = false) {
  return useQuery({ ...runQuery(profile, id), refetchInterval: poll });
}

export function useRunEvents(profile: string, id: number, poll: number | false = false) {
  return useQuery({ ...runEventsQuery(profile, id), refetchInterval: poll });
}
