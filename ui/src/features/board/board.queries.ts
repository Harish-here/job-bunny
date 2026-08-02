import { queryOptions } from '@tanstack/react-query';
import type { ListQuery } from '../../lib/api/types';
import { getJob, getMeta, listJobs } from './board.api';

export const boardKeys = {
  profile: (p: string) => [p] as const,
  meta: (p: string) => [p, 'meta'] as const,
  jobs: (p: string, q: ListQuery) => [p, 'jobs', q] as const,
  jobsPrefix: (p: string) => [p, 'jobs'] as const,
  job: (p: string, id: string) => [p, 'job', id] as const,
};

export const metaQuery = (p: string) =>
  queryOptions({
    queryKey: boardKeys.meta(p),
    queryFn: () => getMeta(p),
    staleTime: Infinity,
  });
export const jobsQuery = (p: string, q: ListQuery) =>
  queryOptions({ queryKey: boardKeys.jobs(p, q), queryFn: () => listJobs(p, q) });
export const jobQuery = (p: string, id: string) =>
  queryOptions({
    queryKey: boardKeys.job(p, id),
    queryFn: () => getJob(p, id),
    enabled: id !== '',
  });
