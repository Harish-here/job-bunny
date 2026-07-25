/**
 * main.ts (P8) — the `jobbunny` CLI entry point: parses argv into a
 * command name + options and dispatches to the registered command. Holds
 * NO adapter imports itself (`nothing-imports-cli`/`only-wire-imports-adapters`
 * in `.dependency-cruiser.cjs` — only `cli/wire.ts` may import
 * `src/adapters/**`); the real `run`/`doctor` commands reach adapters only
 * through `wire()`, which they call internally.
 *
 * Command options are the single shared shape both commands accept —
 * `doctor` simply ignores `resume`/`headless`. Functions RETURN their exit
 * code; only the bin-entry guard at the bottom ever touches
 * `process.exitCode`, so `main` itself is safe to call from a test without
 * side effects on the real process.
 */
import { parseArgs } from 'node:util';
import { doctorCommand } from './commands/doctor.ts';
import { runCommand } from './commands/run.ts';

export interface CommandOptions {
  profile: string;
  resume?: boolean;
  headless?: boolean;
}

export type CommandFn = (opts: CommandOptions) => Promise<number>;

export interface CommandRegistry {
  run: CommandFn;
  doctor: CommandFn;
}

export interface MainDeps {
  commands?: CommandRegistry;
  stderr?: (line: string) => void;
}

const USAGE = 'usage: jobbunny <run|doctor> --profile <name> [--resume] [--headless]';

function defaultCommands(): CommandRegistry {
  return { run: runCommand, doctor: doctorCommand };
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const commands = deps.commands ?? defaultCommands();
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      resume: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
    },
  });

  const commandName = positionals[0];
  if (commandName !== 'run' && commandName !== 'doctor') {
    stderr(USAGE);
    return 2;
  }

  if (!values.profile) {
    stderr(`${USAGE}\nmissing required --profile`);
    return 2;
  }

  const opts: CommandOptions = {
    profile: values.profile,
    resume: values.resume ?? false,
    headless: values.headless ?? false,
  };

  try {
    return await commands[commandName](opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr(message);
    return 1;
  }
}

function isMain(): boolean {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
