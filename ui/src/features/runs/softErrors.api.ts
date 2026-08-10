import { getJson } from '../../lib/api/client';
import type { GetSoftErrorsResponse } from '../../lib/api/types';

function profileBase(profile: string): string {
  return `/api/profiles/${encodeURIComponent(profile)}`;
}

export function getSoftErrors(
  profile: string,
  id: number,
): Promise<GetSoftErrorsResponse> {
  return getJson(`${profileBase(profile)}/runs/${id}/soft-errors`);
}
