import { FilterConfigSchema } from '../filter/config.ts';
import { PipelineConfigSchema } from './schema.ts';

/** Write-boundary validation for the four config docs (config→db Phase 4).
 * Every production `writeText` call goes through this FIRST — throws
 * naming the doc + the underlying parse/schema error on failure, writes
 * nothing on the caller's behalf (this function has no side effects; the
 * caller decides what "nothing written" means for its own store).
 *
 * `key`'s type is inlined rather than imported from `ports/config_store.ts`'s
 * `ConfigDocKey` — `core/` may not import `ports/` (`core-is-pure`); the
 * literal union is kept byte-identical to that port's so a caller passing a
 * real `ConfigDocKey` still typechecks structurally. */
export function validateConfigDoc(
  key: 'profile.json' | 'filter.json' | 'resume.json' | 'search_urls.md',
  rawText: string,
): void {
  switch (key) {
    case 'profile.json':
      try {
        PipelineConfigSchema.parse(JSON.parse(rawText));
      } catch (err) {
        throw new Error(`profile.json is invalid: ${errorMessage(err)}`);
      }
      return;
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
