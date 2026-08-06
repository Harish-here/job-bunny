import { queryOptions } from '@tanstack/react-query';
import { type ConfigDocName, getConfigDoc } from './config.api';

export const configKeys = {
  doc: (profile: string, doc: ConfigDocName) => ['config', profile, doc] as const,
};

// No `staleTime: Infinity` here, unlike `profilesQuery` — a config doc CAN
// change from outside the UI (e.g. `jobbunny config set`), so let it
// refetch normally.
export const configDocQuery = (profile: string, doc: ConfigDocName) =>
  queryOptions({
    queryKey: configKeys.doc(profile, doc),
    queryFn: () => getConfigDoc(profile, doc),
  });
