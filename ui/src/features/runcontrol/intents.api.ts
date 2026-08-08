import { deleteJson, getJson } from '../../lib/api/client';
import type { RunIntentView } from '../wizard/wizard.types';

export type { RunIntentOutcome } from '../wizard/wizard.api';
export { requestRunIntent } from '../wizard/wizard.api';

function profileBase(profile: string): string {
  return `/api/profiles/${encodeURIComponent(profile)}`;
}

/** GET /api/profiles/:name/run-intents -> { rows }, newest first, with
 * status derived on read by the server (a pending intent older than 10
 * minutes reads as 'expired'). */
export function listRunIntents(profile: string): Promise<{ rows: RunIntentView[] }> {
  return getJson(`${profileBase(profile)}/run-intents`);
}

/** DELETE /api/profiles/:name/run-intents/:id -> { intent }. The resolved
 * intent is discarded — same "write succeeded, re-read the list" pattern
 * wizard.api.ts's putSecret already established; the caller invalidates
 * its own run-intents query afterward. */
export async function cancelRunIntent(profile: string, id: number): Promise<void> {
  await deleteJson(`${profileBase(profile)}/run-intents/${id}`);
}
