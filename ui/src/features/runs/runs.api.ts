import { buildQuery, getJson } from '../../lib/api/client';
import type {
  GetRunResponse,
  ListRunEventsResponse,
  ListRunsResponse,
} from '../../lib/api/types';

function profileBase(profile: string): string {
  return `/api/profiles/${encodeURIComponent(profile)}`;
}

export function listRuns(
  profile: string,
  query: { limit?: number; offset?: number } = {},
): Promise<ListRunsResponse> {
  return getJson(`${profileBase(profile)}/runs${buildQuery(query)}`);
}

export function getRun(profile: string, id: number): Promise<GetRunResponse> {
  return getJson(`${profileBase(profile)}/runs/${id}`);
}

export function listRunEvents(
  profile: string,
  id: number,
  query: { limit?: number; offset?: number } = {},
): Promise<ListRunEventsResponse> {
  return getJson(`${profileBase(profile)}/runs/${id}/events${buildQuery(query)}`);
}
