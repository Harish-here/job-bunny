import { queryOptions } from '@tanstack/react-query';
import { getProfiles } from './profiles.api';

export const profilesKeys = {
  all: ['profiles'] as const,
};

export const profilesQuery = () =>
  queryOptions({
    queryKey: profilesKeys.all,
    queryFn: () => getProfiles(),
    staleTime: Infinity,
  });
