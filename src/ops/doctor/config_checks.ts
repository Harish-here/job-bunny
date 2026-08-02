import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import type { DoctorCheck, DoctorFinding } from '../../ports/doctor.ts';
import type { DaemonPidfileDeps } from '../daemon/index.ts';

/**
 * ops/doctor/config_checks.ts (P8; split out of `aggregate.ts`, task 5 of
 * the 2026-07-28 file-size split plan) — the three profile/filter "config"
 * doctor checks (no adapter access — inputs are `profiles/<name>/profile.json`
 * and `profiles/<name>/filter.json`), plus the resolver helpers they share
 * with `aggregate.ts`'s own env/daemon checks (`resolveRoot`, `isNotFound`,
 * `errorMessage`) — kept in this ONE place and imported by `aggregate.ts`
 * rather than duplicated.
 *
 * `root`/`readFile` are injected (default to `process.cwd()`, `node:fs/
 * promises` `readFile` utf8) so tests hit no real disk. Every `run()` here
 * never throws — failures are caught and turned into a `red`/`warn`
 * finding — matching the `DoctorCheck` contract in `ports/doctor.ts`.
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
  /** The profile's configured connector name (`profile.json`'s
   * `connector` field). Used by `envTokensCheck` to decide whether
   * `NOTION_TOKEN` is mandatory (`'notion'`) or merely optional
   * (any other value, or omitted). */
  connector?: string;
  /** Whether `settings.notion.mirror` is on (local-DB spec PR 3's opt-in
   * sqlite→Notion mirror). Used by `envTokensCheck` to give a missing
   * `NOTION_TOKEN` a mirror-specific warn detail instead of the generic
   * "only needed for the notion connector" one. */
  notionMirror?: boolean;
}

export function resolveReadFile(opts: CoreCheckOpts): (path: string) => Promise<string> {
  return opts.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
}

export function resolveRoot(opts: CoreCheckOpts): string {
  return opts.root ?? process.cwd();
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isNotFound(err: unknown): boolean {
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
