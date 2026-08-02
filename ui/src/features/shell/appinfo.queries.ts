import { queryOptions } from '@tanstack/react-query';
import { getApp } from './appinfo.api';

export const appInfoKeys = {
  all: ['app'] as const,
};

export const appInfoQuery = () =>
  queryOptions({
    queryKey: appInfoKeys.all,
    queryFn: () => getApp(),
    staleTime: Infinity,
  });
