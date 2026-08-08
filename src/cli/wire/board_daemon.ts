/**
 * cli/wire/board_daemon.ts (UI phase 1, Task 7) — `BoardSource.
 * readDaemonStatus`'s assembly, split out of `board.ts` purely for the
 * file-size cap (`board.ts` was already at 321 lines; this addition would
 * have pushed it past the 350-line split threshold). Sibling to
 * `board.ts`/`builders.ts`/`compose.ts` in the `only-wire-imports-adapters`
 * carve-out (`.dependency-cruiser.cjs`) — this file itself imports no
 * adapter, only `ops/daemon` (already carve-out-legal for `cli/wire/`).
 *
 * Read-only: reads the daemon's own pidfile (`ops/daemon/pidfile.ts`) and
 * each profile's `profile.json` schedule (`ops/daemon/scan`,
 * `wireDaemonScheduleConfig`). Never starts, stops, or signals the daemon,
 * and never opens a profile database.
 */
import path from 'node:path';
import { nextFireAt } from '../../core/schedule/index.ts';
import {
  defaultDaemonPidfileDeps,
  HEARTBEAT_STALE_MS,
  readDaemonPidfile,
} from '../../ops/daemon/index.ts';
import { defaultScanDeps, scanProfileSchedules } from '../../ops/daemon/scan/index.ts';
import type { DaemonStatus } from '../../ports/board.ts';
import { wireDaemonScheduleConfig } from './daemon.ts';

export interface BoardDaemonOverrides {
  root: string;
  /** Test-only seam: overrides the pidfile deps' pid-liveness probe
   * without touching real OS processes — mirrors `daemon.ts`'s
   * `DaemonWireOverrides.makeRunStore` seam. Default: the real
   * `process.kill(pid, 0)` probe (`defaultDaemonPidfileDeps`'s own
   * `pidIsAlive`). */
  pidIsAlive?: (pid: number) => boolean;
}

/** `profiles`: every scanned profile with its own next scheduled slot,
 * sorted by name. Degrades to `[]` on ANY failure of the scan (a
 * malformed one profile.json must never blind the daemon-liveness half of
 * the response — see this function's callers). */
async function readDaemonProfileSchedules(
  root: string,
): Promise<DaemonStatus['profiles']> {
  try {
    const scanDeps = {
      ...defaultScanDeps(),
      readProfileJson: wireDaemonScheduleConfig({ root }),
    };
    const schedules = await scanProfileSchedules(path.join(root, 'profiles'), scanDeps);
    return schedules
      .map((s) => ({
        profile: s.profile,
        enabled: s.enabled,
        // Single-element array: THIS profile's own next slot, not the
        // fleet-wide next fire nextFireAt would otherwise answer.
        nextRunAt: nextFireAt(new Date(), [s])?.at.toISOString() ?? null,
      }))
      .sort((a, b) => a.profile.localeCompare(b.profile));
  } catch {
    return [];
  }
}

/** `BoardSource.readDaemonStatus`'s real implementation. State resolution
 * order: no pidfile OR a dead pid -> 'stopped' (nulls); a live pid whose
 * heartbeat is stale (non-finite or > HEARTBEAT_STALE_MS old) -> 'stale';
 * otherwise -> 'running'. */
export async function readBoardDaemonStatus(
  overrides: BoardDaemonOverrides,
): Promise<DaemonStatus> {
  const defaults = defaultDaemonPidfileDeps();
  const pidfileDeps = overrides.pidIsAlive
    ? { ...defaults, pidIsAlive: overrides.pidIsAlive }
    : defaults;

  const file = readDaemonPidfile(overrides.root, pidfileDeps);
  const profiles = await readDaemonProfileSchedules(overrides.root);

  if (!file || !pidfileDeps.pidIsAlive(file.pid)) {
    return {
      state: 'stopped',
      pid: null,
      startedAt: null,
      lastTickAt: null,
      inFlight: null,
      profiles,
    };
  }

  const age = pidfileDeps.now().getTime() - Date.parse(file.lastTickAt);
  const state = !Number.isFinite(age) || age > HEARTBEAT_STALE_MS ? 'stale' : 'running';

  return {
    state,
    pid: file.pid,
    startedAt: file.startedAt,
    lastTickAt: file.lastTickAt,
    inFlight: file.inFlight ?? null,
    profiles,
  };
}
