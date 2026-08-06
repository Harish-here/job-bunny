import { FilterConfigSchema } from '../filter/config.ts';
import { PipelineConfigSchema } from './schema.ts';

/** BYTE-EXACT retirement message for `settings.sqlite.path` (config→db
 * Phase 4) — the ONE canonical wording. Shared by wire-time enforcement
 * (`cli/wire/builders.ts`'s `assertSqlitePathRetired`, which now calls
 * this function to build its own message rather than duplicating the
 * string) and this module's OWN write-boundary enforcement below (fix
 * round), so every surface that rejects the setting says the identical
 * thing. Lives here, not in `builders.ts`, because `validateConfigDoc`
 * needs it and `core/` may not import `cli/wire/` (the reverse direction
 * is fine — `cli/wire` already imports freely from `core/`). */
export function sqlitePathRetiredMessage(profileName: string): string {
  return (
    `settings.sqlite.path is no longer supported — the database always lives at ` +
    `profiles/${profileName}/data/jobbunny.db; move the file there and delete the setting`
  );
}

function hasSqlitePathSetting(settings: unknown): boolean {
  if (settings === null || typeof settings !== 'object') return false;
  const sqliteSlice = (settings as { sqlite?: unknown }).sqlite;
  return (
    sqliteSlice !== null &&
    typeof sqliteSlice === 'object' &&
    'path' in (sqliteSlice as object)
  );
}

/** Write-boundary validation for the four config docs (config→db Phase 4).
 * Every production `writeText` call goes through this FIRST — throws
 * naming the doc + the underlying parse/schema error on failure, writes
 * nothing on the caller's behalf (this function has no side effects; the
 * caller decides what "nothing written" means for its own store).
 *
 * `key`'s type is inlined rather than imported from `ports/config_store.ts`'s
 * `ConfigDocKey` — `core/` may not import `ports/` (`core-is-pure`); the
 * literal union is kept byte-identical to that port's so a caller passing a
 * real `ConfigDocKey` still typechecks structurally.
 *
 * `profileName` (fix round, config→db Phase 4 follow-up) — when supplied
 * AND `key` is `'profile.json'`, this ALSO rejects a retired
 * `settings.sqlite.path` (the same check `assertSqlitePathRetired` makes
 * at wire time), closing the write-boundary gap that previously let the
 * board's `PUT /api/profiles/:name/config/profile.json` persist a config
 * that then bricked every CLI command reading that profile (`wire()`/
 * `doctor` both throw on it AFTER it's already stored). Optional, not
 * required, because the only production caller (`SqliteConfigStore.
 * writeText`) always has a profile name to pass; omitting it (as every
 * existing pure-validator test in `validators.test.ts` does) simply skips
 * this one extra check, unchanged from before this fix. */
export function validateConfigDoc(
  key: 'profile.json' | 'filter.json' | 'resume.json' | 'search_urls.md',
  rawText: string,
  profileName?: string,
): void {
  switch (key) {
    case 'profile.json': {
      let parsed: { settings: Record<string, unknown> };
      try {
        parsed = PipelineConfigSchema.parse(JSON.parse(rawText));
      } catch (err) {
        throw new Error(`profile.json is invalid: ${errorMessage(err)}`);
      }
      if (profileName !== undefined && hasSqlitePathSetting(parsed.settings)) {
        throw new Error(sqlitePathRetiredMessage(profileName));
      }
      return;
    }
    case 'filter.json':
      try {
        FilterConfigSchema.parse(JSON.parse(rawText));
      } catch (err) {
        throw new Error(`filter.json is invalid: ${errorMessage(err)}`);
      }
      return;
    case 'resume.json':
      try {
        JSON.parse(rawText);
      } catch (err) {
        throw new Error(`resume.json is not valid JSON: ${errorMessage(err)}`);
      }
      return;
    case 'search_urls.md':
      if (rawText.trim().length === 0) {
        throw new Error('search_urls.md must not be empty');
      }
      return;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
