import { useMutation } from '@tanstack/react-query';
import { getProfiles } from '../shell/profiles.api';
import { pauseProfile } from './operate.api';

export interface PauseAllResult {
  succeeded: string[];
  failed: { profile: string; message: string }[];
}

/**
 * Fans out a `schedule.enabled = false` write (operate.api.ts's
 * `pauseProfile`) over every profile from the existing `GET /api/profiles`
 * (`profiles.api.ts`, unmodified). Uses `Promise.allSettled` — NOT
 * `Promise.all` — so one profile's failure cannot abort the others: N
 * sequential PUTs can genuinely partially fail, and collapsing that into a
 * single boolean would hide it. No new server-side atomic transaction is
 * proposed here — a machine-wide atomic pause was deliberately rejected as
 * stored state the data model does not otherwise need (BE §7).
 */
export function usePauseAll() {
  return useMutation({
    mutationFn: async (): Promise<PauseAllResult> => {
      const { profiles } = await getProfiles();
      const settled = await Promise.allSettled(
        profiles.map(async (p) => {
          await pauseProfile(p.name);
          return p.name;
        }),
      );

      const succeeded: string[] = [];
      const failed: { profile: string; message: string }[] = [];
      settled.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') {
          succeeded.push(outcome.value);
          return;
        }
        const profile = profiles[index];
        const name = profile ? profile.name : 'unknown';
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        failed.push({ profile: name, message });
      });

      return { succeeded, failed };
    },
  });
}
