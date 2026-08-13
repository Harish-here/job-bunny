/**
 * ops/daemon/deps.ts — `DaemonDeps`/`SpawnRun`, split out of `./daemon.ts`
 * purely to keep that file under the file-size cap (a non-behavioral
 * split — same precedent as `cli/wire/daemon_types.ts`/`daemon_deferred.ts`
 * being split out of `cli/wire/daemon.ts` for the identical reason).
 * Re-exported from `./daemon.ts` for every existing import site.
 */
import type { OwedRun, RunRecord } from '../../core/schedule/index.ts';
import type { DeferredSlotRow } from '../../ports/deferred_slots.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { PendingIntent } from '../../ports/run_intents.ts';
import type { DaemonPidfileDeps } from './pidfile.ts';
import type { ScanDeps } from './scan/index.ts';

/** Spawns `jobbunny run --profile <owed.profile> --headless` (the real
 * implementation, wired outside this module) and resolves to the child's
 * exit code once it exits. */
export type SpawnRun = (owed: OwedRun) => Promise<number>;

export interface DaemonDeps {
  root: string;
  profilesDir: string;
  scan: ScanDeps;
  pidfile: DaemonPidfileDeps;
  spawnRun: SpawnRun;
  /** Each named profile's own durable run history for `date` — real
   * evidence from that profile's `jobbunny.db` `runs` table
   * (`RunStoreReader.listRunTimeDirs`, via `cli/wire/daemon.ts`'s
   * `wireDaemonRunHistory`), NOT the pidfile ledger (`ledgerHistory`
   * below is folded in separately) and NOT a filesystem scan (there is no
   * on-disk run folder to scan post-Phase-2). Must never throw — a
   * profile whose db can't be opened yields no records for it. */
  readRunHistory: (profiles: readonly string[], date: string) => RunRecord[];
  /** Per-tick schema-drift detector (Phase 0, D2 self-heal) — real
   * implementation: `cli/wire/daemon.ts`'s `wireDaemonSchemaGuard`. A
   * profile present in this tick's returned map is excluded from
   * spawning entirely THIS tick (R15: an explicit degraded state,
   * never ticking as if healthy) — never blindly respawned. Must
   * never throw. */
  checkSchemaDrift: (
    profiles: readonly string[],
  ) => Map<string, { schemaVersion: number; buildVersion: number }>;
  /** Real implementation: `cli/wire/daemon.ts`'s `wireDaemonNotifier`.
   * Never throws; resolves `true` iff at least one configured notifier's
   * `send` actually succeeded — see that function's own doc comment. */
  notify: (profile: string, event: NotifyEvent) => Promise<boolean>;
  /** Real implementation: `cli/wire/daemon.ts`'s
   * `wireDaemonHasNotifierConfigured` (step 0.5a). Never throws. */
  hasNotifierConfigured: (profile: string) => Promise<boolean>;
  /** Board-queued run intents that are `pending` and NOT expired, oldest
   * first, across every profile directory under `<root>/profiles` —
   * including profiles with no schedule at all, because "Run now" has to
   * work for a profile the user never scheduled. Must never throw: a
   * profile whose db cannot be opened simply yields no intents. */
  readIntents: (now: Date) => PendingIntent[];
  /** Flips one intent from `pending` to `claimed`. `false` when the row is
   * no longer pending — cancelled between the scan and the claim, or
   * already claimed — in which case the daemon skips it without spawning. */
  claimIntent: (profile: string, intentId: number) => boolean;
  /** Back-writes the run the claim produced: the newest run row for
   * `profile` whose `startedAt` is at or after `since`. A no-op when the
   * child never wrote one. Must never throw. */
  attachIntentRun: (profile: string, intentId: number, since: string) => void;
  /** step 1.8 — bounded reachability probe, pre-bound to zero args (mirrors
   * `notify`/`hasNotifierConfigured`). At most once per tick, only when
   * `sorted` is non-empty and not already suspend-declined. Never throws. */
  probeReachable: () => Promise<boolean>;
  /** step 1.10 (D3b) — `cli/wire/daemon.ts`'s `wireDaemonDeferredSlots`
   * (task 11), spread into these four flat fields. `recordDeferral` is
   * idempotent by contract — safe every tick for the same candidate. */
  recordDeferral: (
    profile: string,
    entry: Omit<DeferredSlotRow, 'decidedAt' | 'notifiedAt'> & { decidedAt: string },
  ) => void;
  listForDate: (profile: string, runDate: string) => DeferredSlotRow[];
  listUnnotifiedDatesBefore: (profile: string, beforeDate: string) => string[];
  markNotified: (profile: string, runDate: string, notifiedAt: string) => void;
  /** step 1.12 (task 14) — spawns the catch-up run. This task only adds
   * the FIELD (so this file's own catch-up decision compiles and its
   * tests can inject a fake); task 14 wires the real implementation in. */
  spawnCatchup: (
    target: OwedRun & { standingInFor: readonly string[] },
  ) => Promise<number>;
  log(
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ): void;
  now(): Date;
}
