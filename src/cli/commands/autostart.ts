/**
 * cli/commands/autostart.ts (D20) — `autostart enable|disable`, darwin
 * only. Writes exactly ONE LaunchAgent, `com.jobbunny.autostart.plist`,
 * with `RunAtLoad: true` and NO `StartCalendarInterval` — a dumb "run
 * this at login" trigger. It carries ZERO schedule knowledge: the
 * daemon's own tick loop remains the only interpreter of `times`/
 * `weekdays`/`graceMinutes` (§6.7). No `launchd` adapter code is retained
 * or reused — this writes plain XML text and shells out to `launchctl`
 * directly, the same posture `serve.ts`'s D15 migration scan already
 * takes.
 */
import { execFile } from 'node:child_process';
import {
  readdirSync as fsReaddirSync,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { daemonLogPath } from '../../ops/daemon/logs/index.ts';
import { LEGACY_PLIST_REGEX, migrationCleanupBlock } from './serve/index.ts';

const execFileAsync = promisify(execFile);
const fsWriteFileAsync = promisify(fsWriteFile);
const fsUnlinkAsync = promisify(fsUnlink);

const AUTOSTART_LABEL = 'com.jobbunny.autostart';

export type AutostartAction = 'enable' | 'disable';

export interface AutostartCommandOptions {
  action: AutostartAction;
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number | undefined;
  root: string;
  /** F1: the PATH the daemon (and therefore every run child it spawns)
   * inherits, captured at `enable` time from the interactive shell that
   * ran the command — launchd's own default is `/usr/bin:/bin:/usr/sbin:
   * /sbin`, which contains no `claude`. */
  envPath: string;
  nodeBin: string;
  cliEntry: string;
  listLaunchAgentFiles(): string[];
  writeFile(path: string, data: string): Promise<void>;
  unlink(path: string): Promise<void>;
  runLaunchctl(args: string[]): Promise<{ exitCode: number; stdout: string }>;
  write(line: string): void;
  writeErr(line: string): void;
}

function plistPath(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `RunAtLoad: true`, deliberately NO `StartCalendarInterval` (§6.7): this
 * LaunchAgent's only job is starting `jobbunny serve start` at login —
 * the daemon's own tick loop, not launchd, decides WHEN a run fires.
 * B2: also sets `WorkingDirectory` to `root` — without it, launchd runs
 * the program with cwd `/`, so the pidfile lands at `/.jobbunny-daemon.
 * pid`, `profilesDir` resolves to `/profiles`, and `main.ts`'s
 * `dotenv/config` load finds no `.env`. The retired plist embedded `cd
 * '${root}'` in its own `buildCommand` for exactly this reason —
 * `WorkingDirectory` is the LaunchAgent-native equivalent.
 *
 * F1: `EnvironmentVariables.PATH` is equally load-bearing. launchd hands
 * an agent a bare `/usr/bin:/bin:/usr/sbin:/sbin`, and `claude` lives in
 * `~/.local/bin` — so every autostarted daemon spawned a run child whose
 * `claude`-on-PATH preflight went red, and EVERY scheduled run died
 * silently. `envPath` is the enabling shell's own PATH, captured at
 * `enable` time.
 *
 * F4: `StandardOutPath`/`StandardErrorPath` both point at daemon.log. The
 * CHILD's output is already redirected to that file by the parent's own
 * `spawn` (§6.1), but the PARENT — the `serve start` launchd actually
 * executes — writes its refusals (legacy-plist migration block, "a daemon
 * is already running", "daemon child died immediately") to stdout/stderr,
 * which launchd discards without these keys. */
export function renderAutostartPlist(
  nodeBin: string,
  cliEntry: string,
  root: string,
  envPath: string,
  home: string,
): string {
  const argsXml = [nodeBin, cliEntry, 'serve', 'start']
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join('\n');
  const logPath = escapeXml(daemonLogPath(home));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    `    <string>${escapeXml(AUTOSTART_LABEL)}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argsXml,
    '    </array>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>WorkingDirectory</key>',
    `    <string>${escapeXml(root)}</string>`,
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    '      <key>PATH</key>',
    `      <string>${escapeXml(envPath)}</string>`,
    '    </dict>',
    '    <key>StandardOutPath</key>',
    `    <string>${logPath}</string>`,
    '    <key>StandardErrorPath</key>',
    `    <string>${logPath}</string>`,
    '  </dict>',
    '</plist>',
  ].join('\n');
}

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

function defaultAutostartDeps(): AutostartDeps {
  const home = homedir();
  return {
    platform: process.platform,
    home,
    uid: process.getuid?.(),
    root: process.cwd(), // B2: WorkingDirectory, captured at enable time.
    envPath: process.env.PATH ?? '', // F1: captured at enable time, same as root.
    nodeBin: process.execPath,
    cliEntry: fileURLToPath(new URL('../main.ts', import.meta.url)),
    listLaunchAgentFiles: () => {
      try {
        return fsReaddirSync(path.join(home, 'Library', 'LaunchAgents'));
      } catch {
        return [];
      }
    },
    writeFile: (p, data) => fsWriteFileAsync(p, data, 'utf8'),
    unlink: (p) => fsUnlinkAsync(p),
    runLaunchctl: async (args) => {
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
    },
    write: (line) => console.log(line),
    writeErr: (line) => console.error(line),
  };
}

const NON_DARWIN_ALTERNATIVE =
  'run `jobbunny serve start` once after each login/boot, or register the OS-native ' +
  '"run at login" mechanism by hand (Task Scheduler on Windows, a systemd --user unit ' +
  'on Linux) pointing at `jobbunny serve start` with no arguments';

async function runEnable(deps: AutostartDeps): Promise<number> {
  if (deps.platform !== 'darwin') {
    deps.writeErr(
      `autostart enable: not supported on this platform — ${NON_DARWIN_ALTERNATIVE}.`,
    );
    return 1;
  }

  const legacy = deps.listLaunchAgentFiles().filter((f) => LEGACY_PLIST_REGEX.test(f));
  if (legacy.length > 0) {
    deps.writeErr(migrationCleanupBlock(legacy, deps.uid));
    return 1;
  }

  const target = plistPath(deps.home);
  await deps.writeFile(
    target,
    renderAutostartPlist(deps.nodeBin, deps.cliEntry, deps.root, deps.envPath, deps.home),
  );

  const result = await deps.runLaunchctl(['bootstrap', `gui/${deps.uid ?? ''}`, target]);
  if (result.exitCode !== 0) {
    // Tolerated, not fatal: launchctl's own idempotency error text varies
    // by macOS version, and the plist file (written above) is the real
    // source of truth for whether autostart is configured.
    deps.write(`autostart enable: launchctl bootstrap reported: ${result.stdout.trim()}`);
  }
  deps.write(`autostart enable: wrote ${target} and loaded it`);
  return 0;
}

async function runDisable(deps: AutostartDeps): Promise<number> {
  if (deps.platform !== 'darwin') {
    deps.writeErr(
      `autostart disable: not supported on this platform — there is nothing to ` +
        `unregister here; if you set up a manual OS-native trigger for \`jobbunny serve ` +
        `start\` (Task Scheduler on Windows, a systemd --user unit on Linux), remove it ` +
        `by hand.`,
    );
    return 1;
  }

  await deps.runLaunchctl(['bootout', `gui/${deps.uid ?? ''}/${AUTOSTART_LABEL}`]);
  try {
    await deps.unlink(plistPath(deps.home));
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) throw err;
  }
  deps.write('autostart disable: unloaded and removed the autostart LaunchAgent');
  return 0;
}

export async function autostartCommand(
  opts: AutostartCommandOptions,
  overrides: Partial<AutostartDeps> = {},
): Promise<number> {
  const deps: AutostartDeps = { ...defaultAutostartDeps(), ...overrides };
  return opts.action === 'enable' ? runEnable(deps) : runDisable(deps);
}
