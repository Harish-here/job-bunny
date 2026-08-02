import { useQuery } from '@tanstack/react-query';
import type { ListQuery } from '../../lib/api/types';
import { jobQuery, jobsQuery, metaQuery } from './board.queries';

export function useJobs(profile: string, query: ListQuery) {
  return useQuery(jobsQuery(profile, query));
}

export function useJob(profile: string, id: string) {
  return useQuery(jobQuery(profile, id));
}

export function useMeta(profile: string) {
  return useQuery(metaQuery(profile));
}
