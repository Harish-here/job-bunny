/**
 * args.ts (P8, Task 8 split) — argv → options translation, extracted from
 * `main.ts` purely to keep that file under its file-size cap ahead of the
 * `board` command's own dispatch case. No behavior change: `CommandName`,
 * `CommandOptions`, `COMMAND_NAMES`, `USAGE`, `PARSE_ARGS_OPTIONS`, and
 * `buildOptions` moved here verbatim; `CommandFn`/`CommandRegistry` stay in
 * `main.ts` (its own exported surface — `main.test.ts` imports `CommandFn`
 * from `./main.ts` directly).
 *
 * `PARSE_ARGS_OPTIONS` is declared `as const satisfies ParseArgsOptionsConfig`
 * rather than as a bare object: a bare `const options = { profile: { type:
 * 'string' }, ... }` widens every `type: 'string'` to `type: string`, which
 * degrades the `values` shape `node:util`'s `parseArgs` infers — `buildOptions`
 * below then no longer type-checks against that widened shape. Declared
 * inline (the pre-split shape), TypeScript's contextual typing against the
 * `parseArgs` overload preserved the literal types for free; moved to a
 * module-level const, the const assertion has to do that job explicitly.
 */
import type { ParseArgsOptionsConfig } from 'node:util';

/** The union of every command's option shape. `main` builds each object
 * with ONLY the keys its command actually reads — a command never receives
 * an irrelevant key set to `undefined`. */
export interface CommandOptions {
  profile?: string;
  resume?: boolean;
  headless?: boolean;
  dryRun?: boolean;
  runCapMs?: number;
  stage?: string;
  routine?: string;
  action?: string;
  url?: string;
  label?: string;
  force?: boolean;
  version?: string;
  noMerge?: boolean;
  yes?: boolean;
  daemonChild?: boolean;
  apply?: boolean;
  port?: number;
  /** `runs show <id>` — present ⇒ show, absent ⇒ list. */
  runId?: number;
}

export type CommandName =
  | 'run'
  | 'doctor'
  | 'reconcile'
  | 'stage'
  | 'routine'
  | 'serve'
  | 'autostart'
  | 'lane'
  | 'profile'
  | 'setup'
  | 'release'
  | 'migrate'
  | 'board'
  | 'runs';

export const COMMAND_NAMES = new Set<string>([
  'run',
  'doctor',
  'reconcile',
  'stage',
  'routine',
  'serve',
  'autostart',
  'lane',
  'profile',
  'setup',
  'release',
  'migrate',
  'board',
  'runs',
]);

export const USAGE = [
  'usage: jobbunny <command> [options]',
  '',
  '  run       --profile <name> [--resume] [--headless] [--dry-run] [--run-cap-ms <ms>]',
  '  doctor    --profile <name>',
  '  reconcile --profile <name>',
  '  stage <stage-name> --profile <name>',
  '  routine <routine-name> --profile <name>',
  '  serve start|stop|status              (cross-profile — no --profile)',
  '  autostart enable|disable             (cross-profile — darwin only)',
  '  lane add-url <url> [label] --profile <name>',
  '  profile build --profile <name>',
  '  profile remove --profile <name> [--force]',
  '  setup --profile <name>',
  '  release <X.Y.Z> [--dry-run] [--no-merge] [--yes]  (cross-profile — no --profile)',
  '  migrate   --profile <name> [--apply]     (Notion → local sqlite import; dry-run by default)',
  '  board     [--port <n>]                    (job board server on 127.0.0.1; profile-less)',
  '  runs      --profile <name>                (run history from the DB)',
  '  runs show <id> --profile <name>',
].join('\n');

/** The one `parseArgs` options literal every command's flags are drawn
 * from. `main.ts` passes this straight to `node:util`'s `parseArgs`. */
export const PARSE_ARGS_OPTIONS = {
  profile: { type: 'string' },
  resume: { type: 'boolean', default: false },
  headless: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'run-cap-ms': { type: 'string' },
  'no-merge': { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  'daemon-child': { type: 'boolean', default: false },
  apply: { type: 'boolean', default: false },
  port: { type: 'string' },
} as const satisfies ParseArgsOptionsConfig;

/** Per-command argv → options translation. Returns the options object, or a
 * usage message describing what was missing. Kept separate from dispatch so
 * every "did the user give us enough" rule lives in one readable place. */
export function buildOptions(
  command: CommandName,
  rest: string[],
  values: {
    profile?: string;
    resume?: boolean;
    headless?: boolean;
    force?: boolean;
    'dry-run'?: boolean;
    'run-cap-ms'?: string;
    'no-merge'?: boolean;
    yes?: boolean;
    'daemon-child'?: boolean;
    apply?: boolean;
    port?: string;
  },
): CommandOptions | { error: string } {
  const profile = values.profile;
  const needsProfile = (): { error: string } | undefined =>
    profile ? undefined : { error: 'missing required --profile' };

  switch (command) {
    case 'run': {
      let runCapMs: number | undefined;
      if (values['run-cap-ms'] !== undefined) {
        runCapMs = Number(values['run-cap-ms']);
        if (!Number.isFinite(runCapMs) || runCapMs <= 0) {
          return {
            error: `--run-cap-ms must be a positive number, got "${values['run-cap-ms']}"`,
          };
        }
      }
      return (
        needsProfile() ?? {
          profile,
          resume: values.resume ?? false,
          headless: values.headless ?? false,
          dryRun: values['dry-run'] ?? false,
          ...(runCapMs === undefined ? {} : { runCapMs }),
        }
      );
    }
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
    case 'serve': {
      const action = rest[0];
      if (action !== 'start' && action !== 'stop' && action !== 'status') {
        return { error: 'serve takes "start", "stop", or "status"' };
      }
      return { action, ...(values['daemon-child'] ? { daemonChild: true } : {}) };
    }
    case 'autostart': {
      const action = rest[0];
      if (action !== 'enable' && action !== 'disable') {
        return { error: 'autostart takes "enable" or "disable"' };
      }
      return { action };
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
    case 'release': {
      const version = rest[0];
      if (!version) return { error: 'missing version — expected X.Y.Z' };
      return {
        version,
        dryRun: values['dry-run'] ?? false,
        noMerge: values['no-merge'] ?? false,
        yes: values.yes ?? false,
      };
    }
    case 'migrate':
      return needsProfile() ?? { profile, apply: values.apply ?? false };
    case 'board': {
      // Profile-less, like `serve`/`autostart` — no `needsProfile()` gate.
      let port: number | undefined;
      if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 0) {
          return { error: 'board: --port must be a non-negative integer' };
        }
      }
      return port === undefined ? {} : { port };
    }
    case 'runs': {
      const sub = rest[0];
      if (sub === undefined) {
        return needsProfile() ?? { profile };
      }
      if (sub !== 'show') {
        return { error: 'runs takes no sub-action, or "show <id>"' };
      }
      const idArg = rest[1];
      if (!idArg) return { error: 'runs show: missing run id' };
      const runId = Number(idArg);
      if (!Number.isInteger(runId) || runId <= 0) {
        return {
          error: `runs show: run id must be a positive integer, got "${idArg}"`,
        };
      }
      return needsProfile() ?? { profile, runId };
    }
  }
}
