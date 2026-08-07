/**
 * commands/migrate.ts (local-DB spec PR 2, Task 5; config→db Phase 4,
 * Task 7) — the `migrate` CLI command: reads an existing Notion job
 * database via `wireMigrate`, prints a summary, and — ONLY with `--apply`
 * — imports it into local sqlite (insert-only, `wire.importRecords`) and
 * flips the profile's connector to `sqlite`. Dry-run (the default)
 * performs ZERO writes: `importRecords` is never called, so
 * `wireMigrate`'s lazily-opened DB file is never created, and
 * `profile.json` is left byte-unchanged.
 *
 * The `--apply` connector flip reads/writes `profile.json` through
 * `wire.configStore` (Task 4's readwrite `ConfigStore` field on
 * `MigrateWire`), not raw `readFile`/`writeFile` — validation is
 * automatic: `writeText`'s own internal `validateConfigDoc` call already
 * runs `PipelineConfigSchema.parse` on the result before storing, so this
 * command adds no second, redundant validation step.
 *
 * No `src/adapters/**` import here — `wireMigrate` is injected (real
 * default: `cli/wire/index.ts`'s `wireMigrate`, which reaches
 * `cli/wire/builders.ts`, one of the two adapter-import chokepoints).
 *
 * A partial --apply (jobs imported, tracking failed) is recoverable by
 * re-running --apply — both imports are insert-only, so completed work is
 * never redone or clobbered.
 */
import { createWireLogger } from '../../ops/observability/index.ts';
import type { RunContext } from '../../ports/context.ts';
import { wireMigrate as defaultWireMigrate, type MigrateWire } from '../wire/index.ts';

/** Bounds the whole export + import — a Notion database read plus a
 * bulk sqlite import is a one-shot, not a long-running server call. */
const MIGRATE_DEADLINE_MS = 300_000;

export interface MigrateCommandOptions {
  profile: string;
  apply: boolean;
}

export interface MigrateDeps {
  wireMigrate: (profileName: string) => Promise<MigrateWire>;
  write: (line: string) => void;
}

function defaultDeps(): MigrateDeps {
  return {
    wireMigrate: defaultWireMigrate,
    write: (line: string) => console.log(line),
  };
}

export async function migrateCommand(
  opts: MigrateCommandOptions,
  deps: Partial<MigrateDeps> = {},
): Promise<number> {
  const resolved: MigrateDeps = { ...defaultDeps(), ...deps };
  const wire = await resolved.wireMigrate(opts.profile);

  if (wire.dbId === '') {
    resolved.write(
      'no settings.notion.dbId configured for this profile — nothing to migrate',
    );
    return 1;
  }

  const ctx: RunContext = {
    profile: opts.profile,
    signal: AbortSignal.timeout(MIGRATE_DEADLINE_MS),
    logger: createWireLogger(),
    beat() {},
  };

  const records = await wire.exportRecords(ctx);

  const total = records.length;
  const withTracking = records.filter((r) => r.tracking !== undefined).length;
  const fallback = records.filter((r) => r.jd.identity.id.startsWith('nt-'));

  resolved.write(
    `total: ${total}, withTracking: ${withTracking}, fallback: ${fallback.length}`,
  );
  for (const r of fallback) {
    resolved.write(
      `${r.jd.identity.id} ${r.jd.identity.title} — ${r.jd.identity.company}`,
    );
  }
  resolved.write(`db: ${wire.dbPath}`);

  if (!opts.apply) {
    resolved.write(
      'dry-run — nothing written (no DB file created). Re-run with --apply to import and flip the connector.',
    );
    return 0;
  }

  const now = new Date().toISOString();
  const counts = wire.importRecords(records, now);

  const raw = await wire.configStore.readText('profile.json');
  if (raw === undefined) {
    // Should not happen — wireMigrate already successfully loaded this same
    // doc earlier in this same command run (via loadPipelineConfig). Throw
    // loud rather than silently no-op if it somehow does.
    throw new Error(`profiles/${opts.profile}/profile.json unexpectedly missing`);
  }
  const parsed = JSON.parse(raw);
  parsed.connector = 'sqlite';
  parsed.settings ??= {};
  parsed.settings.sqlite ??= {};
  await wire.configStore.writeText(
    'profile.json',
    `${JSON.stringify(parsed, null, 2)}\n`,
  );

  resolved.write(
    `imported ${counts.jobs} jobs (${total - counts.jobs} already present, left untouched), ` +
      `${counts.tracking} tracking rows; connector flipped to sqlite`,
  );
  return 0;
}
