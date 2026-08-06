/**
 * cli/commands/serve/index.ts (D2, D6) — `serve start|stop|status`, which
 * replaced the deleted `schedule install`/`schedule remove`. NO
 * `--profile` — cross-profile by design, the same posture `schedule
 * install` had. `start` splits into a PARENT (acquires the pidfile,
 * spawns a detached child, confirms it's alive, exits) and a CHILD
 * (`--daemon-child`, runs the tick loop in the foreground) — §6.1/S3.
 *
 * No `src/adapters/**` import here — the daemon spawns `jobbunny run` as
 * a plain child process (D3); this file never touches an adapter, and
 * derives its one adapter-adjacent number (`runCapMs`) from the pipeline's
 * own static `STAGE_BUDGETS` table (`pipeline/stages/budgets.ts`, Task 8,
 * not an adapter) rather than `cli/wire/`'s `compose.ts` — see the plan's Task 9
 * design note, and Task 8's `test/invariants/stage_budgets.test.ts` for
 * the drift guard that keeps that table honest.
 *
 * Split from a single 513-line serve.ts (task 5 of the 2026-07-28 file-size
 * split plan): `./start.ts` (`runServeStartParent`, `runServeStartChild`),
 * `./lifecycle.ts` (`waitUntilDead`, `killAndConfirmDead`, `runServeStop`),
 * `./status.ts` (`runServeStatus`, `formatDuration`) — this file holds the
 * constants, types, `ServeDeps`'s default construction, `migrationCleanupBlock`
 * (reused verbatim by `autostart.ts`), and the `serveCommand` dispatch that
 * ties the three action handlers together.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRecord } from '../../../core/schedule/index.ts';
import {
  type DaemonPidfileDeps,
  defaultDaemonPidfileDeps,
} from '../../../ops/daemon/index.ts';
import {
  daemonLogPath,
  defaultLogDeps,
  type LogDeps,
} from '../../../ops/daemon/logs/index.ts';
import { defaultScanDeps, type ScanDeps } from '../../../ops/daemon/scan/index.ts';
import { wireDaemonRunHistory } from '../../wire/index.ts';
import { runServeStop } from './lifecycle.ts';
import { runServeStartChild, runServeStartParent } from './start.ts';
import { runServeStatus } from './status.ts';

export const LEGACY_PLIST_REGEX = /^com\.jobbunny\.\d{4}\.plist$/;

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

export interface SpawnHandle {
  pid?: number;
  on(event: string, cb: (arg: unknown) => void): void;
  kill(signal: string): boolean;
  unref?(): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { stdio: readonly unknown[]; detached?: boolean },
) => SpawnHandle;

export interface ServeDeps {
  root: string;
  home: string;
  platform: NodeJS.Platform;
  uid: number | undefined;
  pid: number;
  profilesDir: string;
  pidfile: DaemonPidfileDeps;
  logs: LogDeps;
  scan: ScanDeps;
  /** Each named profile's own durable run-history read — real
   * implementation: `cli/wire/daemon.ts`'s `wireDaemonRunHistory`, over
   * that profile's own `jobbunny.db` `runs` table. Shared by the daemon
   * child (`start.ts`'s `DaemonDeps.readRunHistory`) and `serve status`
   * (`status.ts`'s "currently owed" line), so both agree on the same
   * durable evidence the tick loop itself uses. */
  readRunHistory: (profiles: readonly string[], date: string) => RunRecord[];
  listLaunchAgentFiles(): string[];
  spawn: SpawnFn;
  nodeBin: string;
  cliEntry: string;
  pidIsAlive(pid: number): boolean;
  killPid(pid: number, signal: string): void;
  now(): Date;
  sleep(ms: number): Promise<void>;
  readDaemonLogTail(): string;
  write(line: string): void;
  writeErr(line: string): void;
}

export type ServeAction = 'start' | 'stop' | 'status';

export interface ServeCommandOptions {
  action: ServeAction;
  daemonChild?: boolean;
}

function defaultServeDeps(): ServeDeps {
  const root = process.cwd();
  const home = homedir();
  // B3: built once, then reused for BOTH `pidfile.pidIsAlive` (the
  // staleness probe `isDaemonPidfileStale` actually consults) and the
  // top-level `pidIsAlive` below (the separate post-steal-decision and
  // 2s-alive-confirm checks) — the SAME `process.kill`-based probe wired
  // to both injection points, never two independently-written copies
  // that could silently drift apart.
  const pidfileDeps = defaultDaemonPidfileDeps();
  return {
    root,
    home,
    platform: process.platform,
    uid: process.getuid?.(),
    pid: process.pid,
    profilesDir: path.join(root, 'profiles'),
    pidfile: pidfileDeps,
    logs: defaultLogDeps(),
    scan: defaultScanDeps(),
    readRunHistory: wireDaemonRunHistory({ root }),
    listLaunchAgentFiles: () => {
      try {
        return fsReaddirSync(path.join(home, 'Library', 'LaunchAgents'));
      } catch {
        return [];
      }
    },
    spawn: (command, args, opts) =>
      nodeSpawn(command, args, {
        stdio: opts.stdio as ['ignore', number, number],
        detached: opts.detached,
      }) as unknown as SpawnHandle,
    nodeBin: process.execPath,
    cliEntry: fileURLToPath(new URL('../../main.ts', import.meta.url)),
    pidIsAlive: pidfileDeps.pidIsAlive,
    killPid: (pid, signal) => {
      try {
        process.kill(pid, signal as NodeJS.Signals);
      } catch (err) {
        if (!hasCode(err, 'ESRCH')) throw err;
      }
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readDaemonLogTail: () => {
      try {
        const raw = fsReadFileSync(daemonLogPath(home), 'utf8');
        return raw.split('\n').slice(-20).join('\n');
      } catch {
        return '(no daemon.log yet)';
      }
    },
    write: (line) => console.log(line),
    writeErr: (line) => console.error(line),
  };
}

/** D15/§8 — a directory read plus printed strings; no `launchd` code.
 * Exported so `autostart.ts`'s `enable` can reuse it verbatim (§6.7). */
export function migrationCleanupBlock(files: string[], uid: number | undefined): string {
  const lines = [
    `serve start: found ${files.length} leftover launchd job(s) from the old scheduler. Run this first:`,
    '',
  ];
  for (const file of [...files].sort()) {
    const label = file.replace(/\.plist$/, '');
    lines.push(`launchctl bootout gui/${uid ?? '<uid>'}/${label}`);
    lines.push(`rm ~/Library/LaunchAgents/${file}`);
  }
  lines.push('', 'Then re-run: jobbunny serve start');
  return lines.join('\n');
}

export async function serveCommand(
  opts: ServeCommandOptions,
  overrides: Partial<ServeDeps> = {},
): Promise<number> {
  const deps: ServeDeps = { ...defaultServeDeps(), ...overrides };
  switch (opts.action) {
    case 'start':
      return opts.daemonChild ? runServeStartChild(deps) : runServeStartParent(deps);
    case 'stop':
      return runServeStop(deps);
    case 'status':
      return runServeStatus(deps);
  }
}
