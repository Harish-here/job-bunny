#!/usr/bin/env node
/**
 * main.ts (P8) — the `jobbunny` CLI entry point: parses argv into a
 * command name + options and dispatches to the registered command. Holds
 * NO adapter imports itself (`nothing-imports-cli`/`only-wire-imports-adapters`
 * in `.dependency-cruiser.cjs` — only `cli/wire.ts` may import
 * `src/adapters/**`); the real `run`/`doctor` commands reach adapters only
 * through `wire()`, which they call internally.
 *
 * Dispatch is `<command> [sub-action] [positionals] [--flags]`. All argv →
 * options translation lives in `buildOptions`, which hands each command ONLY
 * the keys it reads (never an irrelevant key set to `undefined`) and returns
 * a usage error when a required piece is missing. `schedule install` is the
 * one command that takes no `--profile`: it is cross-profile by design.
 *
 * Functions RETURN their exit code; only the bin-entry guard at the bottom
 * ever touches `process.exitCode`, so `main` itself is safe to call from a
 * test without side effects on the real process.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { doctorCommand } from './commands/doctor.ts';
import { laneAddUrlCommand } from './commands/lane_add_url.ts';
import { profileBuildCommand, profileRemoveCommand } from './commands/profile.ts';
import { reconcileCommand } from './commands/reconcile.ts';
import { routineCommand } from './commands/routine.ts';
import { runCommand } from './commands/run.ts';
import { scheduleCommand } from './commands/schedule.ts';
import { setupCommand } from './commands/setup.ts';
import { stageCommand } from './commands/stage.ts';

/** The union of every command's option shape. `main` builds each object
 * with ONLY the keys its command actually reads — a command never receives
 * an irrelevant key set to `undefined`. */
export interface CommandOptions {
  profile?: string;
  resume?: boolean;
  headless?: boolean;
  stage?: string;
  routine?: string;
  action?: string;
  url?: string;
  label?: string;
  force?: boolean;
}

export type CommandFn = (opts: CommandOptions) => Promise<number>;

export type CommandName =
  | 'run'
  | 'doctor'
  | 'reconcile'
  | 'stage'
  | 'routine'
  | 'schedule'
  | 'lane'
  | 'profile'
  | 'setup';

export type CommandRegistry = Record<CommandName, CommandFn>;

export interface MainDeps {
  /** Partial on purpose: a test overrides only the command it exercises
   * and inherits the real implementations for the rest (which are never
   * called, since dispatch reaches exactly one). */
  commands?: Partial<CommandRegistry>;
  stderr?: (line: string) => void;
}

const USAGE = [
  'usage: jobbunny <command> [options]',
  '',
  '  run       --profile <name> [--resume] [--headless]',
  '  doctor    --profile <name>',
  '  reconcile --profile <name>',
  '  stage <stage-name> --profile <name>',
  '  routine <routine-name> --profile <name>',
  '  schedule install                     (cross-profile — no --profile)',
  '  schedule remove --profile <name>',
  '  lane add-url <url> [label] --profile <name>',
  '  profile build --profile <name>',
  '  profile remove --profile <name> [--force]',
  '  setup --profile <name>',
].join('\n');

function defaultCommands(): CommandRegistry {
  return {
    run: runCommand as unknown as CommandFn,
    doctor: doctorCommand as unknown as CommandFn,
    reconcile: reconcileCommand as unknown as CommandFn,
    stage: stageCommand as unknown as CommandFn,
    routine: routineCommand as unknown as CommandFn,
    schedule: scheduleCommand as unknown as CommandFn,
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
  };
}

const COMMAND_NAMES = new Set<string>([
  'run',
  'doctor',
  'reconcile',
  'stage',
  'routine',
  'schedule',
  'lane',
  'profile',
  'setup',
]);

/** Per-command argv → options translation. Returns the options object, or a
 * usage message describing what was missing. Kept separate from dispatch so
 * every "did the user give us enough" rule lives in one readable place. */
function buildOptions(
  command: CommandName,
  rest: string[],
  values: { profile?: string; resume?: boolean; headless?: boolean; force?: boolean },
): CommandOptions | { error: string } {
  const profile = values.profile;
  const needsProfile = (): { error: string } | undefined =>
    profile ? undefined : { error: 'missing required --profile' };

  switch (command) {
    case 'run':
      return (
        needsProfile() ?? {
          profile,
          resume: values.resume ?? false,
          headless: values.headless ?? false,
        }
      );
    case 'doctor':
    case 'reconcile':
    case 'setup':
      return needsProfile() ?? { profile };
    case 'stage': {
      const stage = rest[0];
      if (!stage) return { error: 'missing stage name' };
      return needsProfile() ?? { profile, stage };
    }
    case 'routine': {
      const routine = rest[0];
      if (!routine) return { error: 'missing routine name' };
      return needsProfile() ?? { profile, routine };
    }
    case 'schedule': {
      const action = rest[0];
      if (action !== 'install' && action !== 'remove') {
        return { error: 'schedule takes "install" or "remove"' };
      }
      // `install` is deliberately cross-profile: it reads every profile's
      // schedule and installs one launchd job per distinct time.
      if (action === 'install') return { action };
      return needsProfile() ?? { action, profile };
    }
    case 'lane': {
      if (rest[0] !== 'add-url') return { error: 'lane takes "add-url"' };
      const url = rest[1];
      if (!url) return { error: 'missing url' };
      const label = rest[2];
      return (
        needsProfile() ?? { profile, url, ...(label === undefined ? {} : { label }) }
      );
    }
    case 'profile': {
      const action = rest[0];
      if (action !== 'build' && action !== 'remove') {
        return { error: 'profile takes "build" or "remove"' };
      }
      if (action === 'build') return needsProfile() ?? { action, profile };
      return needsProfile() ?? { action, profile, force: values.force ?? false };
    }
  }
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const commands = { ...defaultCommands(), ...deps.commands };
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      resume: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
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
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
