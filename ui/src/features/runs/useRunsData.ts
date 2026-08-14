import { useQuery } from '@tanstack/react-query';
import { deferredSlotsQuery } from './deferredSlots.queries';
import { runEventsQuery, runQuery, runsQuery, softErrorsQuery } from './runs.queries';

export function useRuns(profile: string, poll: number | false = false) {
  return useQuery({ ...runsQuery(profile), refetchInterval: poll });
}

export function useRun(profile: string, id: number, poll: number | false = false) {
  return useQuery({ ...runQuery(profile, id), refetchInterval: poll });
}

export function useRunEvents(profile: string, id: number, poll: number | false = false) {
  return useQuery({ ...runEventsQuery(profile, id), refetchInterval: poll });
}

export function useSoftErrors(profile: string, id: number, poll: number | false = false) {
  return useQuery({ ...softErrorsQuery(profile, id), refetchInterval: poll });
}

export function useDeferredSlots(profile: string, date?: string) {
  return useQuery(deferredSlotsQuery(profile, date));
}
