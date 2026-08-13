/**
 * `DaemonWireOverrides` — the shared test-seam type every `wireDaemon*`
 * function in `./daemon.ts` accepts. Split out purely to keep `daemon.ts`
 * under the 400-line file-size cap once step 1.10's `wireDaemonDeferredSlots`
 * addition pushed it over (mirrors `builders.ts`/`migrate.ts`'s own
 * non-behavioral file-size splits) — not a `only-wire-imports-adapters`
 * carve-out file itself, since it imports no adapters, just port types.
 */
import type { ReachabilityProbeDeps } from '../../ops/daemon/reachability/index.ts';
import type { RunStore } from '../../ports/index.ts';
import type { Notifier } from '../../ports/notifier.ts';

export interface DaemonWireOverrides {
  /** the data home; default `resolveHome()` — same resolution as
   * `compose.ts`/`wireBoard` in `builders.ts`/`board.ts`. */
  root?: string;
  /** test-only seam: overrides how a run-history reader is constructed for
   * a resolved db path that is already known to exist. Default builds a
   * real `SqliteRunStore`. Tests use this to inject a store that behaves
   * as though a prior open/query failed, WITHOUT touching the real
   * filesystem, to prove a failure on one call never carries into the
   * next (see `readRunHistory`'s own doc comment). */
  makeRunStore?: (dbPath: string) => Pick<RunStore, 'listRunTimeDirs' | 'close'>;
  /** test-only seam: overrides how a notifier is constructed from a
   * config-doc notifier name. Default builds a real notifier via
   * `./builders.ts`'s `buildNotifier`. */
  buildNotifier?: (name: string, settings: unknown) => Notifier;
  /** test-only seam: overrides how a per-notifier send failure is
   * logged. Default is a no-op — the real caller (`ops/daemon/
   * daemon.ts`'s `runOwedBatch`) already logs its own notify-related
   * events via its own richer `DaemonDeps.log`. */
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** test-only seam (step 1.8/1.11): overrides the reachability probe's
   * own deps (a fake `lookup`, a short `timeoutMs`) so a test can drive
   * `wireDaemonReachabilityProbe` without touching real DNS. Default:
   * `defaultReachabilityProbeDeps()`. */
  reachabilityProbeDeps?: ReachabilityProbeDeps;
}
