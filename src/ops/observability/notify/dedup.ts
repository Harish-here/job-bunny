import { z } from 'zod';

export interface DedupState {
  signature: string;
  firstSeenAt: string;
  lastNotifiedAt: string;
  consecutiveCount: number;
}

/** Zod counterpart of `DedupState`, for `ctx.stateStore.readDoc`'s ingress
 * validation (task 1.16, `cli/commands/run.ts`) — task 16's own brief
 * specified only the TS `interface`; this schema is this task's addition,
 * matching that shape exactly field-for-field. */
export const DedupStateSchema = z.object({
  signature: z.string(),
  firstSeenAt: z.string(),
  lastNotifiedAt: z.string(),
  consecutiveCount: z.number(),
}) satisfies z.ZodType<DedupState>;

export type DedupAction =
  | { action: 'send'; nextState: DedupState }
  | { action: 'remind'; nextState: DedupState }
  | { action: 'suppress'; nextState: DedupState };

const DAY_MS = 24 * 60 * 60_000;

export function decideNotification(
  prior: DedupState | undefined,
  signature: string,
  now: string,
): DedupAction {
  if (prior === undefined || prior.signature !== signature) {
    return {
      action: 'send',
      nextState: {
        signature,
        firstSeenAt: now,
        lastNotifiedAt: now,
        consecutiveCount: 1,
      },
    };
  }

  const elapsed = Date.parse(now) - Date.parse(prior.lastNotifiedAt);

  if (elapsed >= DAY_MS) {
    return {
      action: 'remind',
      nextState: {
        signature,
        firstSeenAt: prior.firstSeenAt,
        lastNotifiedAt: now,
        consecutiveCount: prior.consecutiveCount + 1,
      },
    };
  }

  return {
    action: 'suppress',
    nextState: {
      signature,
      firstSeenAt: prior.firstSeenAt,
      lastNotifiedAt: prior.lastNotifiedAt,
      consecutiveCount: prior.consecutiveCount + 1,
    },
  };
}
