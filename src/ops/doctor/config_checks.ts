import { PipelineConfigSchema } from '../../core/config/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import type { ConfigDocKey } from '../../ports/config_store.ts';
import type { DoctorCheck, DoctorFinding } from '../../ports/doctor.ts';
import type { DaemonPidfileDeps } from '../daemon/index.ts';

/**
 * ops/doctor/config_checks.ts (P8; split out of `aggregate.ts`, task 5 of
 * the 2026-07-28 file-size split plan) — the profile/filter "config"
 * doctor checks (no adapter access — inputs are the profile's config docs),
 * plus the resolver helpers they share with `aggregate.ts`'s own env/daemon
 * checks (`resolveRoot`, `isNotFound`, `errorMessage`) — kept in this ONE
 * place and imported by `aggregate.ts` rather than duplicated.
 *
 * `readDoc` (fix round, config→db Phase 4 follow-up) replaces the old raw
 * `readFile`-against-`profiles/<name>/{profile,filter}.json` seam: these
 * checks now read through the SAME profile `ConfigStore` (readonly lift
 * mode) that `cli/wire/compose.ts` already wires for `doctor` — so a
 * profile whose config lives ONLY in `config_docs` (no legacy file at all)
 * is no longer reported as a false "not found" red, and `empty-lanes`
 * (which exists specifically to catch a freshly-`profile build`-ed
 * profile's `lanes: []`) is no longer silently skipped for exactly that
 * profile shape. `ops/` itself never constructs a `ConfigStore` (no
 * adapter import here — `adapters-only-ports-core`/this module's own
 * boundary) — `readDoc` is always injected; `resolveReadDoc`'s default
 * (a bare "always undefined" stub) is a safety net for a caller that
 * forgets to supply one, never a real fallback path.
 *
 * `readLegacyFile` is a SEPARATE seam, still raw `node:fs/promises`
 * `readFile` by default: `configLegacyDivergenceCheck` (below) needs BOTH
 * the store's view (`readDoc`, db-row-wins-after-lift) and the legacy
 * file's raw on-disk content, to detect when the two have drifted apart —
 * `ops/` reading a plain file directly is not an adapter access, so no
 * boundary issue.
 *
 * `root`/`readDoc`/`readLegacyFile` are all injected so tests hit no real
 * disk/db. Every `run()` here never throws — failures are caught and
 * turned into a `red`/`warn`/`ok` finding — matching the `DoctorCheck`
 * contract in `ports/doctor.ts`.
 *
 * `configLegacyDivergenceCheck` (the fourth consumer of `readLegacyFile`,
 * plus `CONFIG_DOC_KEYS`/its own `resolveReadLegacyFile` default) lives in
 * `aggregate.ts` instead of here — purely a file-size-cap split (this file
 * was already at 2 implementation files' worth of content before that
 * check existed; the two-pair rule caps `ops/doctor/` at two without a
 * subfolder reorg, which is out of this fix's scope), not a boundary or
 * ownership distinction. `CoreCheckOpts.readLegacyFile` is still declared
 * HERE since this is where `CoreCheckOpts` itself lives.
 */

export interface CoreCheckOpts {
  profileName: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Reads one config doc's raw text via the profile's `ConfigStore`
   * (readonly lift mode) — `undefined` on a genuinely missing doc (no
   * `config_docs` row, no legacy file); MAY throw for a malformed legacy
   * file (mirrors `ConfigStore.readText`'s own contract — a real adapter's
   * lift-time check can fail). Real callers (`cli/wire/compose.ts`) always
   * inject one bound to the profile's actual `ConfigStore`; the default
   * here (always `undefined`) is a bare safety net, never a real reader —
   * `ops/` may not construct an adapter itself. */
  readDoc?: (key: ConfigDocKey) => Promise<string | undefined>;
  /** Reads a config doc's LEGACY FILE directly off disk (never the db) —
   * `undefined` on ENOENT. Used only by `configLegacyDivergenceCheck` to
   * compare against `readDoc`'s (possibly db-sourced) view. Defaults to a
   * real `node:fs/promises` `readFile` against
   * `<root>/profiles/<profileName>/<key>`. */
  readLegacyFile?: (key: ConfigDocKey) => Promise<string | undefined>;
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

export function resolveReadDoc(
  opts: CoreCheckOpts,
): (key: ConfigDocKey) => Promise<string | undefined> {
  return opts.readDoc ?? (async () => undefined);
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

/** profileParsesCheck — `profile.json` must exist (as a `config_docs` row
 * or a legacy file) and validate against `PipelineConfigSchema`. Missing
 * or parse/schema failure ⇒ red (profile.json is required to run the
 * pipeline at all). */
export function profileParsesCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'profile-parses';
  const readDoc = resolveReadDoc(opts);
  return {
    name,
    async run(): Promise<DoctorFinding> {
      let raw: string | undefined;
      try {
        raw = await readDoc('profile.json');
      } catch (err) {
        return {
          check: name,
          status: 'red',
          detail: `could not read profile.json: ${errorMessage(err)}`,
        };
      }
      if (raw === undefined) {
        return {
          check: name,
          status: 'red',
          detail: `profile.json not found for profile '${opts.profileName}' (no config_docs row, no legacy file)`,
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

/** filterParsesCheck — `filter.json` is optional (missing ⇒ warn), but if
 * present it must validate against `FilterConfigSchema` (parse/schema
 * failure ⇒ red). */
export function filterParsesCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'filter-parses';
  const readDoc = resolveReadDoc(opts);
  return {
    name,
    async run(): Promise<DoctorFinding> {
      let raw: string | undefined;
      try {
        raw = await readDoc('filter.json');
      } catch (err) {
        return {
          check: name,
          status: 'red',
          detail: `could not read filter.json: ${errorMessage(err)}`,
        };
      }
      if (raw === undefined) {
        return {
          check: name,
          status: 'warn',
          detail: `filter.json not found for profile '${opts.profileName}' (optional)`,
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

/** sqlitePathRetiredCheck (config→db Phase 4) — `settings.sqlite.path` is
 * retired (see `cli/wire/builders.ts`'s `assertSqlitePathRetired`, the LOUD
 * wire-time enforcement this check mirrors for the tolerant doctor surface).
 * Piggybacks on `profileParsesCheck`'s own doc, same as `emptyLanesCheck`:
 * a missing/malformed profile.json is already red from that check, so this
 * one stays silent (`ok`) rather than double-reporting. NOTE: in the real
 * `doctor` CLI path this red finding is only reachable when `wire()` itself
 * does not already throw for the identical condition first — `doctorCommand`
 * now degrades that throw to its own synthetic red finding (see
 * `cli/commands/doctor.ts`) rather than aborting, but the two remain
 * deliberately redundant, not merged. */
export function sqlitePathRetiredCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'sqlite-path-retired';
  const readDoc = resolveReadDoc(opts);
  return {
    name,
    async run(): Promise<DoctorFinding> {
      let raw: string | undefined;
      try {
        raw = await readDoc('profile.json');
      } catch {
        return { check: name, status: 'ok', detail: 'skipped — profile.json unreadable' };
      }
      if (raw === undefined) {
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
      const settings = (parsed as { settings?: unknown } | null)?.settings;
      const sqliteSlice =
        settings && typeof settings === 'object'
          ? (settings as { sqlite?: unknown }).sqlite
          : undefined;
      const hasPath =
        sqliteSlice !== null &&
        typeof sqliteSlice === 'object' &&
        'path' in (sqliteSlice as object);
      if (hasPath) {
        return {
          check: name,
          status: 'red',
          detail:
            `settings.sqlite.path is no longer supported — the database always lives at ` +
            `profiles/${opts.profileName}/data/jobbunny.db; move the file there and delete the setting`,
        };
      }
      return { check: name, status: 'ok', detail: 'settings.sqlite.path not set' };
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
 * doc: if `profile.json` is missing or fails schema validation, that's
 * already reported red by `profileParsesCheck` — this check stays silent
 * (`ok`) rather than double-reporting the same underlying problem. */
export function emptyLanesCheck(opts: CoreCheckOpts): DoctorCheck {
  const name = 'empty-lanes';
  const readDoc = resolveReadDoc(opts);
  return {
    name,
    async run(): Promise<DoctorFinding> {
      let raw: string | undefined;
      try {
        raw = await readDoc('profile.json');
      } catch {
        return { check: name, status: 'ok', detail: 'skipped — profile.json unreadable' };
      }
      if (raw === undefined) {
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
