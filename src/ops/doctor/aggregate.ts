import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import type {
  DoctorCheck,
  DoctorFinding,
  DoctorReport,
  DoctorStatus,
} from '../../ports/doctor.ts';

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

/** coreChecks — the three profile/config/env checks above, in a fixed
 * order. Callers append adapter-contributed checks (e.g. Notion/Telegram
 * reachability) themselves before calling `runChecks`. */
export function coreChecks(opts: CoreCheckOpts): DoctorCheck[] {
  return [
    profileParsesCheck(opts),
    filterParsesCheck(opts),
    emptyLanesCheck(opts),
    envTokensCheck(opts),
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
