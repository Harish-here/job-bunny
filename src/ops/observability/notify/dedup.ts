export interface DedupState {
  signature: string;
  firstSeenAt: string;
  lastNotifiedAt: string;
  consecutiveCount: number;
}

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
