/**
 * cli/wire/board_autostart_control.ts (settings-overhaul task 13, split out
 * of `board_daemon_control.ts` by the fix round's F13 — the module was 397
 * lines before the fix and the fix itself does not fit under the 400-line
 * cap without a split). `BoardSource.setAutostart`'s real implementation —
 * see `setBoardAutostart`'s own doc comment below for the outcome mapping,
 * including F13's `HttpError(409, ...)` for the legacy-plist-conflict case
 * the frozen `AutostartOutcome` type has no slot for.
 */
import { execFile } from 'node:child_process';
import { readdirSync as fsReaddirSync } from 'node:fs';
import { unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HttpError } from '../../app/shared/index.ts';
import type { AutostartOutcome } from '../../ports/board.ts';
import type { AutostartDeps } from '../commands/autostart.ts';
import { runDisable, runEnable } from '../commands/autostart.ts';

const execFileAsync = promisify(execFile);

/** Real read of `<home>/Library/LaunchAgents`, `[]` on any error — the same
 * shape `board_daemon_control.ts`'s own `realListLaunchAgentFiles` provides
 * for `startBoardDaemon`, duplicated here rather than exported/imported
 * across the sibling split: a ~8-line helper is cheaper and lower-risk than
 * widening either module's public surface for it (same call task 13's own
 * report already made for `realRunLaunchctl` below duplicating
 * `autostart.ts`'s private `defaultAutostartDeps().runLaunchctl`). */
function realListLaunchAgentFiles(home: string): () => string[] {
  return () => {
    try {
      return fsReaddirSync(path.join(home, 'Library', 'LaunchAgents'));
    } catch {
      return [];
    }
  };
}

/** Real `launchctl` shell-out, `AutostartDeps.runLaunchctl`'s shape —
 * mirrors `autostart.ts`'s own private `defaultAutostartDeps().runLaunchctl`
 * (not exported, so reconstructed rather than imported), including its
 * absorb-and-report posture for a non-zero exit. */
async function realRunLaunchctl(
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('launchctl', args);
    return { exitCode: 0, stdout };
  } catch (err) {
    const failure = err as { stdout?: string; code?: number };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
    };
  }
}

export interface BoardAutostartOverrides {
  root: string;
  /** Test-only seam: overrides `process.platform`. Per this brief's own
   * safety constraint, EVERY test in this repo must override this — no
   * test may exercise the real darwin path. Default: `process.platform`. */
  platform?: NodeJS.Platform;
  /** Default: the OS home directory (`homedir()`) — same default
   * `board_daemon_control.ts`'s `BoardDaemonStartOverrides.home`
   * documents. */
  home?: string;
  uid?: number;
  envPath?: string;
  nodeBin?: string;
  cliEntry?: string;
  /** Test-only seam: overrides the darwin legacy-plist directory listing.
   * Default: a real read of `<home>/Library/LaunchAgents`, `[]` on any
   * error. */
  listLaunchAgentFiles?: () => string[];
  /** Test-only seam: replaces the real plist write. Default: a real
   * `node:fs/promises writeFile`. */
  writeFile?: (path: string, data: string) => Promise<void>;
  /** Test-only seam: replaces the real plist removal. Default: a real
   * `node:fs/promises unlink`. */
  unlink?: (path: string) => Promise<void>;
  /** Test-only seam: replaces the real `launchctl` shell-out. Per this
   * brief's own safety constraint, EVERY test must override this. Default:
   * `realRunLaunchctl` above. */
  runLaunchctl?: (args: string[]) => Promise<{ exitCode: number; stdout: string }>;
}

/** `BoardSource.setAutostart`'s real implementation (task 13, hardened by
 * a fix round — F13) — a thin wrapper that builds an `AutostartDeps` bag
 * and delegates ENTIRELY to the CLI's own `runEnable`/`runDisable`
 * (`cli/commands/autostart.ts`, exported by this task's own
 * non-behavioural refactor): the SAME darwin gate, legacy-plist gate,
 * plist render, and tolerant-launchctl posture the `jobbunny autostart
 * enable|disable` command already has, reused verbatim — never re-derived
 * here. This function ALWAYS calls `runEnable`/`runDisable`, regardless of
 * `platform`: their own darwin check is the FIRST statement in either
 * function body, so passing a non-darwin `deps.platform` through already
 * guarantees `writeFile`/`unlink`/`runLaunchctl` are never invoked — there
 * is no separate darwin check duplicated in this file.
 *
 * `AutostartOutcome` has only two members (`'ok'` / `'unsupported_platform'`)
 * — deliberately coarser than the CLI's own exit code, which also
 * distinguishes a legacy-plist conflict from a clean run. On darwin, the
 * tolerated-launchctl-hiccup path (already non-fatal inside `runEnable`,
 * per this brief's explicit "must NOT surface [launchctl hiccups] as
 * request failures" instruction) still maps to `'ok'`. The legacy-plist-
 * conflict path (`autostart.ts`'s `runEnable`, exit 1, enable only — a
 * real, blocking refusal: NO plist is written, `launchctl` is never
 * called) has no slot in this two-member type, so F13's fix surfaces it
 * as a THROWN `HttpError(409, 'autostart_conflict', ...)` instead of a
 * silently misleading `{outcome:'ok'}` — `server.ts`'s existing generic
 * `HttpError` catch (the same mechanism `router.ts`'s `param()` already
 * relies on) turns this into a real, visible failure response rather than
 * a return value the frozen type can't express. `enable` (disable never
 * fails on darwin) and non-darwin (exit 1 there is the platform gate
 * itself, already reported via `'unsupported_platform'`) are excluded
 * from this throw by the `platform === 'darwin' && code !== 0` guard. */
export async function setBoardAutostart(
  enabled: boolean,
  overrides: BoardAutostartOverrides,
): Promise<AutostartOutcome> {
  const platform = overrides.platform ?? process.platform;
  const home = overrides.home ?? homedir();
  const errLines: string[] = [];
  const deps: AutostartDeps = {
    platform,
    home,
    uid: overrides.uid ?? process.getuid?.(),
    root: overrides.root,
    envPath: overrides.envPath ?? process.env.PATH ?? '',
    nodeBin: overrides.nodeBin ?? process.execPath,
    cliEntry: overrides.cliEntry ?? fileURLToPath(new URL('../main.ts', import.meta.url)),
    listLaunchAgentFiles:
      overrides.listLaunchAgentFiles ?? realListLaunchAgentFiles(home),
    writeFile: overrides.writeFile ?? ((p, data) => fsWriteFile(p, data, 'utf8')),
    unlink: overrides.unlink ?? fsUnlink,
    runLaunchctl: overrides.runLaunchctl ?? realRunLaunchctl,
    write: () => {},
    writeErr: (line) => errLines.push(line),
  };

  const code = await (enabled ? runEnable(deps) : runDisable(deps));
  if (platform === 'darwin' && code !== 0) {
    throw new HttpError(
      409,
      'autostart_conflict',
      errLines.join('\n') || 'autostart enable was refused',
    );
  }
  return { outcome: platform === 'darwin' ? 'ok' : 'unsupported_platform' };
}
