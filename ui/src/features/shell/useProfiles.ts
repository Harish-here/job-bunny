import { useQuery } from '@tanstack/react-query';
import { profilesQuery } from './profiles.queries';

export function useProfilesQuery() {
  return useQuery(profilesQuery());
}
