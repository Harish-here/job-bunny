import { execFile } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConfigDocKey } from '../../ports/config_store.ts';
import type {
  DoctorCheck,
  DoctorFinding,
  DoctorReport,
  DoctorStatus,
} from '../../ports/doctor.ts';
import {
  defaultDaemonPidfileDeps,
  HEARTBEAT_STALE_MS,
  readDaemonPidfile,
} from '../daemon/index.ts';
import {
  type CoreCheckOpts,
  emptyLanesCheck,
  errorMessage,
  filterParsesCheck,
  isNotFound,
  profileParsesCheck,
  resolveReadDoc,
  resolveRoot,
  sqlitePathRetiredCheck,
} from './config_checks.ts';

const execFileAsync = promisify(execFile);

/**
 * ops/doctor/aggregate.ts (P8) — the env/claude/daemon "core" doctor
 * checks (no adapter access — inputs are `process.env` and the daemon
 * pidfile) plus the generic `runChecks` aggregator that any set of
 * `DoctorCheck`s (core + adapter-contributed, wired in by the caller) is
 * run through. The profile/filter config checks (`profileParsesCheck`,
 * `filterParsesCheck`, `emptyLanesCheck`, `sqlitePathRetiredCheck` —
 * config→db Phase 4) and the resolver helpers they share with this file
 * live in `./config_checks.ts` (split out, task 5 of the 2026-07-28
 * file-size split plan) — imported here for `coreChecks`'s assembly and
 * `daemonLivenessCheck`'s `resolveRoot` use. `configLegacyDivergenceCheck`
 * (below) is itself a config check by subject matter, but lives HERE
 * rather than in `config_checks.ts` purely to stay under that file's
 * line-size cap (fix round, config→db Phase 4 follow-up) — not a boundary
 * or ownership distinction; `CoreCheckOpts.readLegacyFile` is still
 * declared in `config_checks.ts`, this file only consumes it.
 *
 * `root`/`env`/`readFile` are injected (default to `process.cwd()`,
 * `process.env`, `node:fs/promises` `readFile` utf8) so tests hit no real
 * disk or environment. Every `run()` here never throws — failures are
 * caught and turned into a `red` finding — matching the `DoctorCheck`
 * contract in `ports/doctor.ts`.
 *
 * Boundary: this file is `src/ops/**` and must only import from
 * `core/`, `ports/`, `pipeline/`, `routines/` (enforced by
 * `.dependency-cruiser.cjs`) — it never imports an adapter; adapter
 * checks (e.g. `notion-db-reachable`, `telegram-bot-token`) are passed in
 * by the caller alongside `coreChecks()`'s output.
 */

function resolveEnv(opts: CoreCheckOpts): NodeJS.ProcessEnv {
  return opts.env ?? process.env;
}

/** envTokensCheck — `NOTION_TOKEN` absent/empty ⇒ red only when the
 * profile's connector is notion — a local-first (sqlite) profile runs
 * without any Notion token; `TELEGRAM_BOT_TOKEN` absent/empty ⇒ warn
 * (optional notifier). If both are missing, reports the worst of the two
 * and names both in the detail. */
export function envTokensCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'env-tokens';
  const env = resolveEnv(opts);
  const notionRequired = opts.connector === 'notion';
  return {
    name,
    async run(): Promise<DoctorFinding> {
      const parts: { status: 'red' | 'warn'; detail: string }[] = [];
      if (!env.NOTION_TOKEN) {
        parts.push(
          notionRequired
            ? { status: 'red', detail: 'NOTION_TOKEN is not set' }
            : opts.notionMirror === true
              ? {
                  status: 'warn',
                  detail:
                    'NOTION_TOKEN is not set — the Notion mirror is enabled but cannot ' +
                    'push until it is',
                }
              : {
                  status: 'warn',
                  detail:
                    'NOTION_TOKEN is not set (only needed for the notion connector)',
                },
        );
      }
      if (!env.TELEGRAM_BOT_TOKEN) {
        parts.push({ status: 'warn', detail: 'TELEGRAM_BOT_TOKEN is not set' });
      }
      if (parts.length === 0) {
        return {
          check: name,
          status: 'ok',
          detail: 'NOTION_TOKEN and TELEGRAM_BOT_TOKEN are set',
        };
      }
      const status = parts.some((p) => p.status === 'red') ? 'red' : 'warn';
      return { check: name, status, detail: parts.map((p) => p.detail).join('; ') };
    },
  };
}

function resolveCommandExists(
  opts: CoreCheckOpts,
): (command: string) => Promise<boolean> {
  return opts.commandExists ?? defaultCommandExists;
}

async function defaultCommandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version']);
    return true;
  } catch (err) {
    // ENOENT ⇒ not on PATH. Any other failure (e.g. a nonzero exit)
    // still means the binary itself was found and ran — present.
    return !isNotFound(err);
  }
}

/** claudeOnPathCheck (D13) — Claude Code's own `claude` CLI is the ONLY
 * structure-stage LLM provider; this is a documented prerequisite to
 * CHECK, not an OS blocker to work around (Claude Code itself is
 * cross-platform). `red`, not `warn`: the structure stage cannot proceed
 * at all without it, so failing fast at doctor/preflight time beats
 * failing partway through a run. */
export function claudeOnPathCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'claude-cli-on-path';
  const commandExists = resolveCommandExists(opts);
  return {
    name,
    async run(): Promise<DoctorFinding> {
      const found = await commandExists('claude');
      if (found) {
        return { check: name, status: 'ok', detail: 'claude CLI found on PATH' };
      }
      return {
        check: name,
        status: 'red',
        detail:
          'claude CLI not found on PATH — the structure stage shells out to it directly; ' +
          'install Claude Code (https://claude.com/claude-code) and ensure `claude` ' +
          'resolves on PATH',
      };
    },
  };
}

/** daemonLivenessCheck (§6.8, D22) — an opt-in diagnostic surface (only
 * seen when the user explicitly runs `jobbunny doctor`), distinct from
 * main.ts's blanket per-command stderr warning: this check DOES warn on
 * a missing pidfile (useful information here), where the per-command
 * warning deliberately stays silent for a user who has never run `serve
 * start` at all (see main.ts's `defaultCheckDaemonLiveness`). Always
 * `warn`, never `red` — a down/wedged daemon means scheduled runs won't
 * fire, not that a manually-invoked `run`/`doctor` itself is broken. */
export function daemonLivenessCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'daemon-liveness';
  const root = resolveRoot(opts);
  const deps = opts.daemonPidfile ?? defaultDaemonPidfileDeps();
  return {
    name,
    async run(): Promise<DoctorFinding> {
      const file = readDaemonPidfile(root, deps);
      if (!file) {
        return {
          check: name,
          status: 'warn',
          detail:
            "no daemon pidfile found — scheduled runs will not fire until 'jobbunny serve start'",
        };
      }
      if (!deps.pidIsAlive(file.pid)) {
        return {
          check: name,
          status: 'warn',
          detail: `daemon pidfile found but pid ${file.pid} is not alive — run 'jobbunny serve start'`,
        };
      }
      const heartbeatAgeMs = deps.now().getTime() - Date.parse(file.lastTickAt);
      if (heartbeatAgeMs > HEARTBEAT_STALE_MS) {
        return {
          check: name,
          status: 'warn',
          detail:
            `daemon (pid ${file.pid}) appears wedged — no tick in over ` +
            `${Math.round(HEARTBEAT_STALE_MS / 60_000)} minutes. A machine that just woke ` +
            'from sleep can trigger this transiently for up to one tick interval; this ' +
            'check is advisory and deliberately does not re-check before reporting.',
        };
      }
      return {
        check: name,
        status: 'ok',
        detail: `daemon running (pid ${file.pid}), ticking normally`,
      };
    },
  };
}

const CONFIG_DOC_KEYS: readonly ConfigDocKey[] = [
  'profile.json',
  'filter.json',
  'resume.json',
  'search_urls.md',
];

function resolveReadLegacyFile(
  opts: CoreCheckOpts,
): (key: ConfigDocKey) => Promise<string | undefined> {
  return (
    opts.readLegacyFile ??
    (async (key: ConfigDocKey) => {
      const filePath = path.join(resolveRoot(opts), 'profiles', opts.profileName, key);
      try {
        return await fsReadFile(filePath, 'utf8');
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    })
  );
}

/** configLegacyDivergenceCheck (fix round, config→db Phase 4) —
 * `SqliteConfigStore` lifts each legacy file into `config_docs` exactly
 * ONCE; from then on the db row wins forever, silently — a later hand-edit
 * to the legacy file (`profile.json`/`filter.json`/`resume.json`/
 * `search_urls.md`) is never read again by anything (`readText` never
 * re-checks the file once a row exists). There is no other signal anywhere
 * in the pipeline that this happened. This check compares each doc's
 * CURRENT on-disk legacy content (`readLegacyFile`) against what the store
 * actually returns (`readDoc`, which prefers the db row once lifted) and
 * warns, naming the re-sync path, when they've drifted apart. A doc with no
 * legacy file at all (config-docs-only profile) has nothing to diverge
 * from and is silently skipped; a doc whose legacy file or store read fails
 * its own check is also skipped here — that failure is somebody else's (or
 * nobody's, for `readLegacyFile`) job to report, not this check's. Never
 * red: a drifted file is a real but recoverable inconvenience, not a
 * broken profile. */
export function configLegacyDivergenceCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'config-legacy-divergence';
  const readDoc = resolveReadDoc(opts);
  const readLegacyFile = resolveReadLegacyFile(opts);
  return {
    name,
    async run(): Promise<DoctorFinding> {
      const diverged: ConfigDocKey[] = [];
      for (const key of CONFIG_DOC_KEYS) {
        let fileText: string | undefined;
        try {
          fileText = await readLegacyFile(key);
        } catch {
          continue;
        }
        if (fileText === undefined) continue;

        let storeText: string | undefined;
        try {
          storeText = await readDoc(key);
        } catch {
          continue;
        }
        if (storeText !== undefined && storeText !== fileText) {
          diverged.push(key);
        }
      }
      if (diverged.length === 0) {
        return {
          check: name,
          status: 'ok',
          detail: 'no divergence between legacy config files and their config_docs rows',
        };
      }
      const verb = diverged.length === 1 ? 'has' : 'have';
      return {
        check: name,
        status: 'warn',
        detail:
          `${diverged.join(', ')} ${verb} changed on disk since being lifted into ` +
          `config_docs — the stored row still wins and the disk edit is silently ` +
          `ignored. Run 'jobbunny config import --profile ${opts.profileName} ` +
          `--dir profiles/${opts.profileName}' to re-sync (note: 'config import' ` +
          `uses the strict validator, so a drifted-but-lifted profile.json may be ` +
          `rejected on re-import).`,
      };
    },
  };
}

/** coreChecks — the eight profile/config/env/daemon/claude checks above,
 * in a fixed order. Callers append adapter-contributed checks (e.g.
 * Notion/Telegram reachability) themselves before calling `runChecks`. */
export function coreChecks(opts: CoreCheckOpts): DoctorCheck[] {
  return [
    profileParsesCheck(opts),
    filterParsesCheck(opts),
    emptyLanesCheck(opts),
    sqlitePathRetiredCheck(opts),
    configLegacyDivergenceCheck(opts),
    envTokensCheck(opts),
    claudeOnPathCheck(opts),
    daemonLivenessCheck(opts),
  ];
}

const STATUS_RANK: Record<DoctorStatus, number> = { ok: 0, warn: 1, red: 2 };

function worstStatus(a: DoctorStatus, b: DoctorStatus): DoctorStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

/** runChecks — runs every check's `run()` in order, preserving input
 * order in `findings`. A check that throws despite the `DoctorCheck`
 * contract is defensively caught and turned into a synthesized red
 * finding so one bad check never aborts the whole aggregation. Overall
 * `status` is the worst finding (red > warn > ok); empty input ⇒ ok. */
export async function runChecks(checks: DoctorCheck[]): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [];
  let status: DoctorStatus = 'ok';
  for (const check of checks) {
    let finding: DoctorFinding;
    try {
      finding = await check.run();
    } catch (err) {
      finding = {
        check: check.name,
        status: 'red',
        detail: `check threw: ${errorMessage(err)}`,
      };
    }
    findings.push(finding);
    status = worstStatus(status, finding.status);
  }
  return { findings, status };
}
