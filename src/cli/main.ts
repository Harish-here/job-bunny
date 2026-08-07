#!/usr/bin/env node
/**
 * main.ts (P8) — the `jobbunny` CLI entry point: parses argv into a
 * command name + options and dispatches to the registered command. Holds
 * NO adapter imports itself (`nothing-imports-cli`/`only-wire-imports-adapters`
 * in `.dependency-cruiser.cjs` — only `cli/wire/compose.ts` may import
 * `src/adapters/**`); the real `run`/`doctor` commands reach adapters only
 * through `wire()`, which they call internally.
 *
 * Dispatch is `<command> [sub-action] [positionals] [--flags]`. All argv →
 * options translation lives in `buildOptions`, which hands each command ONLY
 * the keys it reads (never an irrelevant key set to `undefined`) and returns
 * a usage error when a required piece is missing. `serve` (all three
 * sub-actions), `autostart` (darwin only), and `release` are cross-profile
 * by design and take no `--profile`.
 *
 * Functions RETURN their exit code; only the bin-entry guard at the bottom
 * ever touches `process.exitCode`, so `main` itself is safe to call from a
 * test without side effects on the real process.
 *
 * `dotenv.config({ path: join(resolveHome(), '.env') })` runs inside the
 * `isMain()` bin guard at the bottom (not at module top level — see that
 * guard's own comment for why), loading `.env` from the resolved data home
 * rather than a cwd-relative `./.env`: `NOTION_TOKEN` and
 * `TELEGRAM_BOT_TOKEN` live there, and a daemon-spawned scheduled run
 * (`ops/daemon/supervise`) inherits a minimal environment that does not
 * include them. Without this a scheduled run would wire a throwing-stub
 * connector, die at sync, and then fail to send the digest that would have
 * reported it — a silent daily failure. v0 does the same thing per entry
 * point (`scripts/notion/client.js`, `scripts/notify/notify.js`); v2 has one
 * bin, so it loads here and only here.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import {
  defaultDaemonPidfileDeps,
  HEARTBEAT_STALE_MS,
  readDaemonPidfile,
} from '../ops/daemon/index.ts';
import {
  buildOptions,
  COMMAND_NAMES,
  type CommandName,
  type CommandOptions,
  PARSE_ARGS_OPTIONS,
  USAGE,
} from './args.ts';
import { autostartCommand } from './commands/autostart.ts';
import { boardCommand } from './commands/board.ts';
import { type ConfigDocName, configCommand } from './commands/config.ts';
import { doctorCommand } from './commands/doctor.ts';
import { laneAddUrlCommand } from './commands/lane_add_url.ts';
import { migrateCommand } from './commands/migrate.ts';
import { profileBuildCommand, profileRemoveCommand } from './commands/profile.ts';
import { reconcileCommand } from './commands/reconcile.ts';
import { npmSwallowedFlags, releaseCommand } from './commands/release/index.ts';
import { routineCommand } from './commands/routine.ts';
import { runCommand } from './commands/run.ts';
import { runsCommand } from './commands/runs.ts';
import { serveCommand } from './commands/serve/index.ts';
import { setupCommand } from './commands/setup.ts';
import { stageCommand } from './commands/stage.ts';
import { type StateCommandOptions, stateCommand } from './commands/state.ts';
import { resolveHome } from './home/index.ts';

export type CommandFn = (opts: CommandOptions) => Promise<number>;

export type CommandRegistry = Record<CommandName, CommandFn>;

export interface MainDeps {
  /** Partial on purpose: a test overrides only the command it exercises
   * and inherits the real implementations for the rest (which are never
   * called, since dispatch reaches exactly one). */
  commands?: Partial<CommandRegistry>;
  stderr?: (line: string) => void;
  /** Environment for the npm swallowed-flag guard. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** §6.8 — the per-command daemon-liveness warning. Returns the warning
   * line to print, or `undefined` for silence. Injected so no test here
   * touches a real pidfile on disk. Default: `defaultCheckDaemonLiveness`
   * below, which is silent when the pidfile is absent OR unparseable
   * (`readDaemonPidfile` already collapses both to `undefined` — §6.2's
   * reader rule) and warns only when it EXISTS and shows a dead pid or a
   * stale heartbeat — deliberately narrower than `daemonLivenessCheck`
   * (`ops/doctor/aggregate.ts`), which also warns on a missing pidfile as
   * useful information on that opt-in surface; a blanket per-command nag
   * for "you've never run `serve start`" would be unwelcome noise here. */
  checkDaemonLiveness?: () => string | undefined;
}

function defaultCheckDaemonLiveness(): string | undefined {
  const pidfileDeps = defaultDaemonPidfileDeps();
  const file = readDaemonPidfile(resolveHome(), pidfileDeps);
  if (!file) return undefined; // absent or unparseable — both silent.
  if (!pidfileDeps.pidIsAlive(file.pid)) {
    return (
      'warning: jobbunny daemon is not running (stale pidfile) — scheduled runs will not ' +
      "fire until 'jobbunny serve start'"
    );
  }
  const heartbeatAgeMs = pidfileDeps.now().getTime() - Date.parse(file.lastTickAt);
  if (heartbeatAgeMs > HEARTBEAT_STALE_MS) {
    // Derived, never hardcoded: HEARTBEAT_STALE_MS is the only definition
    // of "wedged", and this line is what the operator reads.
    const minutes = Math.round(HEARTBEAT_STALE_MS / 60_000);
    return (
      `warning: jobbunny daemon appears wedged (no tick in over ${minutes} minutes) — ` +
      'scheduled runs may not fire'
    );
  }
  return undefined;
}

function defaultCommands(): CommandRegistry {
  return {
    run: runCommand as unknown as CommandFn,
    doctor: doctorCommand as unknown as CommandFn,
    reconcile: reconcileCommand as unknown as CommandFn,
    stage: stageCommand as unknown as CommandFn,
    routine: routineCommand as unknown as CommandFn,
    serve: (async (opts: CommandOptions) =>
      serveCommand({
        action: (opts.action ?? 'status') as 'start' | 'stop' | 'status',
        daemonChild: opts.daemonChild ?? false,
      })) as CommandFn,
    autostart: (async (opts: CommandOptions) =>
      autostartCommand({
        action: (opts.action ?? 'enable') as 'enable' | 'disable',
      })) as CommandFn,
    lane: laneAddUrlCommand as unknown as CommandFn,
    // `profile` fans out to two commands; the sub-action picks which.
    profile: (async (opts: CommandOptions) =>
      opts.action === 'remove'
        ? profileRemoveCommand({
            profile: opts.profile ?? '',
            force: opts.force ?? false,
          })
        : profileBuildCommand({ profile: opts.profile ?? '' })) as CommandFn,
    setup: setupCommand as unknown as CommandFn,
    release: (async (opts: CommandOptions) =>
      releaseCommand({
        version: opts.version ?? '',
        dryRun: opts.dryRun ?? false,
        noMerge: opts.noMerge ?? false,
        yes: opts.yes ?? false,
      })) as CommandFn,
    migrate: (async (opts: CommandOptions) =>
      migrateCommand({
        profile: opts.profile ?? '',
        apply: opts.apply ?? false,
      })) as CommandFn,
    board: (async (opts: CommandOptions) =>
      // 1994 — not random: the operator's birthday.
      boardCommand({ port: opts.port ?? 1994 })) as CommandFn,
    runs: (async (opts: CommandOptions) =>
      runsCommand({
        profile: opts.profile ?? '',
        ...(opts.runId === undefined ? {} : { runId: opts.runId }),
      })) as CommandFn,
    state: (async (opts: CommandOptions) =>
      stateCommand({
        profile: opts.profile ?? '',
        action: (opts.action ?? 'read') as 'read' | 'write',
        key: (opts.key ?? '') as StateCommandOptions['key'],
      })) as CommandFn,
    config: (async (opts: CommandOptions) =>
      configCommand({
        profile: opts.profile ?? '',
        action: (opts.action ?? 'get') as 'get' | 'set' | 'export' | 'import',
        ...(opts.doc === undefined ? {} : { doc: opts.doc as ConfigDocName }),
        ...(opts.dir === undefined ? {} : { dir: opts.dir }),
      })) as CommandFn,
  };
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const commands = { ...defaultCommands(), ...deps.commands };
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  // §6.8: every command warns, first thing, when the daemon pidfile
  // exists but shows no live daemon — before anything else runs.
  const checkDaemonLiveness = deps.checkDaemonLiveness ?? defaultCheckDaemonLiveness;
  const livenessWarning = checkDaemonLiveness();
  if (livenessWarning) stderr(livenessWarning);

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: PARSE_ARGS_OPTIONS,
  });

  const commandName = positionals[0];
  if (!commandName || !COMMAND_NAMES.has(commandName)) {
    stderr(USAGE);
    return 2;
  }

  const built = buildOptions(commandName as CommandName, positionals.slice(1), values);
  if ('error' in built) {
    stderr(`${USAGE}\n${built.error}`);
    return 2;
  }

  // `npm run release <ver> --dry-run` without a `--` separator has npm eat
  // the flags — a plan-only invocation would release for real. Refuse loudly.
  if (commandName === 'release') {
    const swallowed = npmSwallowedFlags(deps.env ?? process.env);
    if (swallowed.length) {
      stderr(
        `npm swallowed ${swallowed.join(' ')} (no "--" separator) — ` +
          `re-run as: npm run release -- ${built.version} ${swallowed.join(' ')}`,
      );
      return 2;
    }
  }

  try {
    return await commands[commandName as CommandName](built);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr(message);
    return 1;
  }
}

function isMain(): boolean {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  dotenv.config({ path: join(resolveHome(), '.env') });
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
