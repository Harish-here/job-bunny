import { getJson } from '../../lib/api/client';

export interface AppInfo {
  version: string;
}

export function getApp(): Promise<AppInfo> {
  return getJson('/api/app');
}
