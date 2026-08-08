/**
 * commands/migrate_home.ts (Task 5) — `jobbunny migrate-home`: a ONE-SHOT
 * bridge that moves a legacy repo-local install's user data (profiles,
 * `.env`, the Chrome login profile) into the data home (`$JOBBUNNY_HOME`
 * or `~/.jobbunny`). Scheduled for deletion once every machine that still
 * has a repo-local install has run it once.
 *
 * Removal surface — delete all of this to remove the feature:
 *   - src/cli/commands/migrate_home.ts (this file)
 *   - src/cli/commands/migrate_home.test.ts
 *   - src/cli/args.ts: `'migrate-home'` in `CommandName`/`COMMAND_NAMES`,
 *     the `from` option (interface field, `PARSE_ARGS_OPTIONS`, and the
 *     inline `values` type on `buildOptions`), the USAGE line, and the
 *     `buildOptions` case
 *   - src/cli/main.ts: the `migrateHomeCommand` import and its
 *     `defaultCommands()` entry (`'migrate-home'` may also then drop out
 *     of `HOME_EXEMPT_COMMANDS`)
 *
 * Dry-run by default; only `--apply` moves anything. Every operation is a
 * `rename` (never a copy+delete), so a mid-plan failure leaves the source
 * intact for everything not yet moved — a subsequent apply after fixing
 * the problem (e.g. finishing an EXDEV item by hand) is safe to re-run
 * because the never-clobber check refuses anything already present at the
 * destination. Never touches Notion or the network, never merges into an
 * existing destination, and always excludes the committed `rajni` fixture
 * profile so the repo checkout keeps it.
 *
 * The daemon check reads the SOURCE's pidfile (via `readDaemonPidfile`,
 * the exact function `serve status` uses) rather than the home's, because
 * a legacy install's daemon is anchored to the old checkout — checking
 * the new home would always report "not running" and give false
 * confidence that it's safe to move a live install's data out from under
 * it.
 */
import {
  existsSync as existsSyncReal,
  mkdirSync as mkdirSyncReal,
  readdirSync as readdirSyncReal,
  renameSync as renameSyncReal,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type DaemonPidfileDeps,
  defaultDaemonPidfileDeps,
  readDaemonPidfile,
} from '../../ops/daemon/index.ts';
import { resolveHome } from '../home/index.ts';

export interface MigrateHomeOptions {
  /** Source install. Defaults to the process working directory — the
   * command is meant to be run from inside the old checkout. */
  from?: string;
  /** Dry-run is the default; `--apply` performs the moves. */
  apply: boolean;
}

export interface MigrateHomeDeps {
  home: string;
  source: string;
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  mkdirSync(path: string): void;
  renameSync(from: string, to: string): void;
  pidfile: DaemonPidfileDeps;
  write(line: string): void;
  writeErr(line: string): void;
}

interface PlanItem {
  from: string;
  to: string;
}

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

// `process.cwd()` here is a legitimate use: it names the SOURCE the
// operator is standing in (an old checkout), not a data anchor — the
// only `process.cwd()` this work package adds outside `release`.
function defaultDeps(): MigrateHomeDeps {
  return {
    home: resolveHome(),
    source: process.cwd(),
    existsSync: (p) => existsSyncReal(p),
    readdirSync: (p) => readdirSyncReal(p),
    mkdirSync: (p) => {
      mkdirSyncReal(p, { recursive: true });
    },
    renameSync: (from, to) => renameSyncReal(from, to),
    pidfile: defaultDaemonPidfileDeps(),
    write: (line) => console.log(line),
    writeErr: (line) => console.error(line),
  };
}

export async function migrateHomeCommand(
  opts: MigrateHomeOptions,
  deps: Partial<MigrateHomeDeps> = {},
): Promise<number> {
  const resolved: MigrateHomeDeps = { ...defaultDeps(), ...deps };
  const source = opts.from !== undefined ? resolve(opts.from) : resolved.source;
  const home = resolved.home;

  if (source === home) {
    resolved.write(
      `migrate-home: source and destination are the same directory (${source}) — nothing to do`,
    );
    return 1;
  }

  if (!resolved.existsSync(join(source, 'profiles'))) {
    resolved.writeErr(
      `migrate-home: ${source} does not look like a Job Bunny install (no profiles/ directory) — pass --from <path>`,
    );
    return 1;
  }

  // Stale (dead pid) does NOT block — only a genuinely live daemon does.
  const file = readDaemonPidfile(source, resolved.pidfile);
  if (file !== undefined && resolved.pidfile.pidIsAlive(file.pid)) {
    resolved.writeErr(
      `migrate-home: the daemon is running (pid ${file.pid}) — run 'jobbunny serve stop' first`,
    );
    return 1;
  }

  const profileNames = [...resolved.readdirSync(join(source, 'profiles'))].sort();
  let hadRajni = false;
  const plan: PlanItem[] = [];
  for (const name of profileNames) {
    if (name === 'rajni') {
      hadRajni = true;
      continue;
    }
    plan.push({
      from: join(source, 'profiles', name),
      to: join(home, 'profiles', name),
    });
  }
  if (resolved.existsSync(join(source, '.env'))) {
    plan.push({ from: join(source, '.env'), to: join(home, '.env') });
  }
  if (resolved.existsSync(join(source, '.chrome-debug'))) {
    plan.push({ from: join(source, '.chrome-debug'), to: join(home, 'chrome') });
  }

  // Never-clobber check, performed during planning so the dry-run reports
  // it too. No merge logic — this is a one-time bridge, not a sync tool.
  for (const item of plan) {
    if (resolved.existsSync(item.to)) {
      resolved.writeErr(
        `migrate-home: ${item.to} already exists — refusing to overwrite`,
      );
      return 1;
    }
  }

  if (plan.length === 0) {
    resolved.write(
      `migrate-home: nothing to move — ${source} has no profiles (other than rajni), no .env, and no .chrome-debug/`,
    );
    return 1;
  }

  resolved.write(`migrate-home: ${source} → ${home}`);
  for (const item of plan) {
    resolved.write(`  ${item.from} → ${item.to}`);
  }
  if (hadRajni) {
    resolved.write('  skipped profiles/rajni (committed fixture — stays in the repo)');
  }

  if (!opts.apply) {
    resolved.write(
      'migrate-home: dry-run — nothing was moved. Re-run with --apply to move.',
    );
    return 0;
  }

  resolved.mkdirSync(join(home, 'profiles'));
  for (const item of plan) {
    try {
      resolved.renameSync(item.from, item.to);
    } catch (err) {
      if (hasCode(err, 'EXDEV')) {
        resolved.writeErr(
          `migrate-home: cannot move ${item.from} across filesystems — move it by hand, then re-run`,
        );
        return 1;
      }
      throw err;
    }
  }

  resolved.write(`migrate-home: moved ${plan.length} item(s) into ${home}`);
  resolved.write('next steps:');
  resolved.write('  jobbunny autostart enable');
  resolved.write('  jobbunny doctor --profile <name>');
  return 0;
}
