/** Deferred-slot visibility (pipeline-stability-hardening D3b) — persists
 * "this scheduled slot was deferred (host asleep / network unreachable /
 * daemon unavailable) and never ran" rows so the board and Telegram digest
 * can SHOW a slot that silently disappeared instead of the user having to
 * infer it from an absent run row. Governing requirements: R22 (a deferred
 * slot is recorded, not dropped), R23 (deferred slots are readable per
 * date), R24 (one entry per slot, not one per gate-re-evaluation tick —
 * `recordIfAbsent` is idempotent BY CONTRACT, backed at the adapter layer
 * (task 4) by an `INSERT OR IGNORE` against a unique `(run_date, slot)`
 * index), R25 (a calendar day that never gets a same-day catch-up chance
 * still eventually produces exactly one summary, via the retrospective
 * sweep's `listUnnotifiedDatesBefore`).
 *
 * Sync by design — node:sqlite is sync (mirrors `ports/run_intents.ts`,
 * `ports/checkpoint_store.ts`). */
export interface DeferredSlotRow {
  runDate: string; // 'YYYY-MM-DD'
  slot: string; // 'HH:MM'
  reasonCode: 'host-asleep' | 'network-unreachable' | 'daemon-unavailable';
  reason: string;
  decidedAt: string; // ISO 8601
  notifiedAt: string | null; // ISO 8601, set once a deferred-day summary has covered this date
}

export interface DeferredSlotStore {
  /** Idempotent: a second call for the same (runDate, slot) is a no-op —
   * satisfies R24 (one entry, not one per tick) by construction. */
  recordIfAbsent(
    entry: Omit<DeferredSlotRow, 'decidedAt' | 'notifiedAt'> & { decidedAt: string },
  ): void;
  listForDate(runDate: string): DeferredSlotRow[];
  /** Distinct `runDate`s strictly before `beforeDate` that still have at
   * least one row with `notifiedAt` null — the retrospective sweep's
   * (step 1.11a) own query surface. Coordinator-added requirement
   * (2026-08-13): without this, a calendar day that never gets a
   * same-day catch-up chance produces no message at all once it rolls
   * into "yesterday." */
  listUnnotifiedDatesBefore(beforeDate: string): string[];
  /** Marks every row for `runDate` notified — idempotent, called once
   * after either sending the retrospective no-catchup summary or
   * confirming a same-day catch-up already covered that date. */
  markNotified(runDate: string, notifiedAt: string): void;
  close(): void;
}
