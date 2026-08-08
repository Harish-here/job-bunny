/** `expired` is DERIVED on read from `requestedAt` age — never a stored
 * value, never a migrated one. Same discipline as the run store's
 * derived `crashed`. */
export type RunIntentStatus = 'pending' | 'claimed' | 'cancelled' | 'expired';

export interface RunIntent {
  id: number;
  requestedAt: string; // ISO 8601 UTC
  status: RunIntentStatus;
  claimedRunId: number | null;
}

export type CancelIntentResult =
  | { outcome: 'cancelled'; intent: RunIntent }
  | { outcome: 'not_found' }
  | { outcome: 'not_pending' };

export interface PendingIntent {
  profile: string;
  intentId: number;
  requestedAt: string;
}

export interface RunIntentStore {
  /** BOARD side. Inserts a `pending` intent and returns it with
   * `deduped: false`. When a `pending` intent already exists and is NOT
   * expired, writes nothing and returns that row with `deduped: true`.
   * When the existing `pending` intent IS expired, cancels it and inserts
   * a fresh one in the same savepoint — this is the "queue again" path,
   * done server-side so a double-click can never violate the partial
   * unique index. */
  request(now: string): { intent: RunIntent; deduped: boolean };
  /** BOARD side. Cancels a `pending` intent by id. Pre-claim only. */
  cancel(id: number, now: string): CancelIntentResult;
  /** Read side. The newest intent with its status derived, or `null`. */
  latest(now: string): RunIntent | null;
  /** Read side (2026-08-07 addition — `GET /api/profiles/:name/run-intents`,
   * task 2). ALL intents (any status) newest-first (`id` descending),
   * capped at `limit`, each row's status derived exactly like `latest`. */
  list(now: string, limit: number): RunIntent[];
  /** DAEMON side. `pending` and not expired, oldest first. */
  listClaimable(now: string): RunIntent[];
  /** DAEMON side. Flips `pending` -> `claimed`. Returns `false` when the
   * row is no longer `pending` — cancelled between the scan and the claim,
   * or claimed by an earlier pass. */
  claim(id: number): boolean;
  /** DAEMON side. Back-writes the spawned run's id onto a `claimed` row.
   * No-op when the row is not `claimed`. */
  attachRun(id: number, runId: number): void;
  close(): void;
}

/** A `pending` intent older than this reads as `expired`: 10 minutes,
 * i.e. 20 daemon ticks. If a run intent has sat unclaimed that long the
 * honest conclusion is that no daemon is running, and the UI says so
 * instead of spinning. */
export const INTENT_EXPIRY_MS = 10 * 60_000;
