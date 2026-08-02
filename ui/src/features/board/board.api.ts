import { buildQuery, getJson, patchJson } from '../../lib/api/client';
import type {
  BoardDetailResponse,
  BoardListResponse,
  BoardMetaResponse,
  ListQuery,
  TrackingPatchBody,
  TrackingPatchResponse,
} from '../../lib/api/types';

function profileBase(profile: string): string {
  return `/api/profiles/${encodeURIComponent(profile)}`;
}

export function listJobs(profile: string, query: ListQuery): Promise<BoardListResponse> {
  return getJson(`${profileBase(profile)}/jobs${buildQuery(query)}`);
}

export function getJob(profile: string, id: string): Promise<BoardDetailResponse> {
  return getJson(`${profileBase(profile)}/jobs/${encodeURIComponent(id)}`);
}

export function patchTracking(
  profile: string,
  id: string,
  patch: TrackingPatchBody,
): Promise<TrackingPatchResponse> {
  return patchJson(
    `${profileBase(profile)}/jobs/${encodeURIComponent(id)}/tracking`,
    patch,
  );
}

export function getMeta(profile: string): Promise<BoardMetaResponse> {
  return getJson(`${profileBase(profile)}/meta`);
}
