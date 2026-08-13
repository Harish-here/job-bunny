import { queryOptions } from '@tanstack/react-query';
import { listDeferredSlots } from './deferredSlots.api';

export const deferredSlotsKeys = {
  list: (p: string, date?: string) => [p, 'deferred-slots', date] as const,
};

export const deferredSlotsQuery = (p: string, date?: string) =>
  queryOptions({
    queryKey: deferredSlotsKeys.list(p, date),
    queryFn: () => listDeferredSlots(p, date),
    enabled: p !== '',
  });
