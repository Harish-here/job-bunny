import { useQuery } from '@tanstack/react-query';
import { appInfoQuery } from './appinfo.queries';

export function useAppInfo() {
  return useQuery(appInfoQuery());
}
