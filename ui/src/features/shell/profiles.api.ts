import { getJson } from '../../lib/api/client';
import type { ProfilesResponse } from '../../lib/api/types';

export function getProfiles(): Promise<ProfilesResponse> {
  return getJson('/api/profiles');
}
