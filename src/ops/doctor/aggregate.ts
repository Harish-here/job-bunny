import { execFile } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import type {
  DoctorCheck,
  DoctorFinding,
  DoctorReport,
  DoctorStatus,
} from '../../ports/doctor.ts';
import type { DaemonPidfileDeps } from '../daemon/index.ts';
import {
  defaultDaemonPidfileDeps,
  HEARTBEAT_STALE_MS,
  readDaemonPidfile,
} from '../daemon/index.ts';

const execFileAsync = promisify(execFile);

/**
 * ops/doctor/aggregate.ts (P8) — the three profile/config/env "core" doctor
 * checks (no adapter access — inputs are `profiles/<name>/profile.json`,
 * `profiles/<name>/filter.json`, and `process.env`) plus the
 * generic `runChecks` aggregator that any set of `DoctorCheck`s (core +
 * adapter-contributed, wired in by the caller) is run through.
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

export interface CoreCheckOpts {
  profileName: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
  /** Probes whether a command resolves on PATH. Defaults to a real
   * `execFile('claude', ['--version'])` probe. Injected so tests never
   * shell out for real (D17's hermetic-test requirement). */
  commandExists?: (command: string) => Promise<boolean>;
  /** Daemon pidfile deps for `daemonLivenessCheck`. Defaults to
   * `defaultDaemonPidfileDeps()`. */
  daemonPidfile?: DaemonPidfileDeps;
}

function resolveReadFile(opts: CoreCheckOpts): (path: string) => Promise<string> {
  return opts.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
}

function resolveRoot(opts: CoreCheckOpts): string {
  return opts.root ?? process.cwd();
}

function resolveEnv(opts: CoreCheckOpts): NodeJS.ProcessEnv {
  return opts.env ?? process.env;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT',
  );
}

/** profileParsesCheck — `profiles/<name>/profile.json` must exist and
 * validate against `PipelineConfigSchema`. Missing file or parse/schema
 * failure ⇒ red (profile.json is required to run the pipeline at all). */
export function profileParsesCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'profile-parses';
  const readFile = resolveReadFile(opts);
  const filePath = path.join(
    resolveRoot(opts),
    'profiles',
    opts.profileName,
    'profile.json',
  );
  return {
    name,
    async run(): Promise<DoctorFinding> {
      let raw: string;
      try {
        raw = await readFile(filePath);
      } catch (err) {
        if (isNotFound(err)) {
          return {
            check: name,
            status: 'red',
            detail: `profile.json not found at ${filePath}`,
          };
        }
        return {
          check: name,
          status: 'red',
          detail: `could not read profile.json: ${errorMessage(err)}`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          check: name,
          status: 'red',
          detail: `profile.json is not valid JSON: ${errorMessage(err)}`,
        };
      }
      const result = PipelineConfigSchema.safeParse(parsed);
      if (!result.success) {
        return {
          check: name,
          status: 'red',
          detail: `profile.json does not match the pipeline config schema: ${result.error.message}`,
        };
      }
      return {
        check: name,
        status: 'ok',
        detail: 'profile.json parses and matches the pipeline config schema',
      };
    },
  };
}

/** filterParsesCheck — `profiles/<name>/filter.json` is optional
 * (missing ⇒ warn), but if present it must validate against
 * `FilterConfigSchema` (parse/schema failure ⇒ red). */
export function filterParsesCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'filter-parses';
  const readFile = resolveReadFile(opts);
  const filePath = path.join(
    resolveRoot(opts),
    'profiles',
    opts.profileName,
    'filter.json',
  );
  return {
    name,
    async run(): Promise<DoctorFinding> {
      let raw: string;
      try {
        raw = await readFile(filePath);
      } catch (err) {
        if (isNotFound(err)) {
          return {
            check: name,
            status: 'warn',
            detail: `filter.json not found at ${filePath} (optional)`,
          };
        }
        return {
          check: name,
          status: 'red',
          detail: `could not read filter.json: ${errorMessage(err)}`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          check: name,
          status: 'red',
          detail: `filter.json is not valid JSON: ${errorMessage(err)}`,
        };
      }
      const result = FilterConfigSchema.safeParse(parsed);
      if (!result.success) {
        return {
          check: name,
          status: 'red',
          detail: `filter.json does not match the filter config schema: ${result.error.message}`,
        };
      }
      return {
        check: name,
        status: 'ok',
        detail: 'filter.json parses and matches the filter config schema',
      };
    },
  };
}

/** emptyLanesCheck — §10 P9 closure register: a freshly-`profile build`-ed
 * profile seeds `lanes: []` (picking a default ATS board would mean
 * guessing user intent — see `commands/profile.ts`), which runs zero
 * source lanes and reports `passed` with 0 jobs — indistinguishable from a
 * real, successful, quiet day. Rather than seed a guessed default, this
 * makes the empty-lanes case a loud, un-missable `red` doctor finding
 * instead: a profile with no lanes is a config problem, never a healthy
 * "everything is fine" state. Piggybacks on `profileParsesCheck`'s own
 * file: if `profile.json` is missing or fails schema validation, that's
 * already reported red by `profileParsesCheck` — this check stays silent
 * (`ok`) rather than double-reporting the same underlying problem. */
export function emptyLanesCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'empty-lanes';
  const readFile = resolveReadFile(opts);
  const filePath = path.join(
    resolveRoot(opts),
    'profiles',
    opts.profileName,
    'profile.json',
  );
  return {
    name,
    async run(): Promise<DoctorFinding> {
      let raw: string;
      try {
        raw = await readFile(filePath);
      } catch {
        return { check: name, status: 'ok', detail: 'skipped — profile.json unreadable' };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          check: name,
          status: 'ok',
          detail: 'skipped — profile.json not valid JSON',
        };
      }
      const result = PipelineConfigSchema.safeParse(parsed);
      if (!result.success) {
        return {
          check: name,
          status: 'ok',
          detail: 'skipped — profile.json invalid schema',
        };
      }
      if (result.data.lanes.length === 0) {
        return {
          check: name,
          status: 'red',
          detail:
            'profile.json has no lanes configured — a run would source zero jobs and ' +
            'report "passed" with 0 jobs, indistinguishable from a real quiet day. ' +
            'Add at least one lane to lanes[] before running.',
        };
      }
      return {
        check: name,
        status: 'ok',
        detail: `${result.data.lanes.length} lane(s) configured`,
      };
    },
  };
}

/** envTokensCheck — `NOTION_TOKEN` absent/empty ⇒ red (Notion is the
 * always-present source of truth); `TELEGRAM_BOT_TOKEN` absent/empty ⇒
 * warn (optional notifier). If both are missing, reports the worst
 * (red) and names both in the detail. */
export function envTokensCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'env-tokens';
  const env = resolveEnv(opts);
  return {
    name,
    async run(): Promise<DoctorFinding> {
      const missingNotion = !env.NOTION_TOKEN;
      const missingTelegram = !env.TELEGRAM_BOT_TOKEN;
      if (missingNotion && missingTelegram) {
        return {
          check: name,
          status: 'red',
          detail: 'NOTION_TOKEN is not set; TELEGRAM_BOT_TOKEN is not set',
        };
      }
      if (missingNotion) {
        return { check: name, status: 'red', detail: 'NOTION_TOKEN is not set' };
      }
      if (missingTelegram) {
        return { check: name, status: 'warn', detail: 'TELEGRAM_BOT_TOKEN is not set' };
      }
      return {
        check: name,
        status: 'ok',
        detail: 'NOTION_TOKEN and TELEGRAM_BOT_TOKEN are set',
      };
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

/** coreChecks — the five profile/config/env/daemon/claude checks above,
 * in a fixed order. Callers append adapter-contributed checks (e.g.
 * Notion/Telegram reachability) themselves before calling `runChecks`. */
export function coreChecks(opts: CoreCheckOpts): DoctorCheck[] {
  return [
    profileParsesCheck(opts),
    filterParsesCheck(opts),
    emptyLanesCheck(opts),
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
