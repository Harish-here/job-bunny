import { deleteJson, getJson, postJson, putJson } from '../../lib/api/client';
import type { ConfigGetResponse, CreateProfileResponse } from '../../lib/api/types';

/**
 * UI-side request-param literal union for the four config docs — mirrors
 * `board.api.ts`'s own request-param typing style (no port type imported
 * from `src/`; only RESPONSE shapes cross the type-only boundary via
 * `lib/api/types.ts`).
 */
export type ConfigDocName =
  | 'profile.json'
  | 'filter.json'
  | 'resume.json'
  | 'search_urls.md';

function profileBase(profile: string): string {
  return `/api/profiles/${encodeURIComponent(profile)}`;
}

export function getConfigDoc(
  profile: string,
  doc: ConfigDocName,
): Promise<ConfigGetResponse> {
  return getJson(`${profileBase(profile)}/config/${encodeURIComponent(doc)}`);
}

export function putConfigDoc(
  profile: string,
  doc: ConfigDocName,
  text: string,
): Promise<ConfigGetResponse> {
  return putJson(`${profileBase(profile)}/config/${encodeURIComponent(doc)}`, { text });
}

export function createProfile(name: string): Promise<CreateProfileResponse> {
  return postJson('/api/profiles', { name });
}

export function deleteProfile(name: string): Promise<{ removed: true; name: string }> {
  return deleteJson(`/api/profiles/${encodeURIComponent(name)}`);
}
