import { buildQuery, getJson } from '../../lib/api/client';
import type { ListDeferredSlotsResponse } from '../../lib/api/types';

function profileBase(profile: string): string {
  return `/api/profiles/${encodeURIComponent(profile)}`;
}

export function listDeferredSlots(
  profile: string,
  date?: string,
): Promise<ListDeferredSlotsResponse> {
  return getJson(
    `${profileBase(profile)}/deferred-slots${buildQuery(date ? { date } : {})}`,
  );
}
