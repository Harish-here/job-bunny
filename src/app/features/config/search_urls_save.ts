/**
 * search_urls_save.ts — the ONE call site for validating + normalizing +
 * writing `search_urls.md` (blueprint-be.md Step 5). Shared by both the CLI
 * (`cli/commands/config.ts`) and the board (`cli/wire/board.ts`) — neither
 * duplicates this orchestration; both import it via this module's barrel
 * (`./index.ts`), never directly (two-pair rule).
 *
 * Lives in `app/features/config/` rather than `cli/wire/` because it needs
 * no adapter import: it operates on an already-constructed `ConfigStore`
 * handed in by its caller, so it satisfies `app-only-ports-core`.
 */

import {
  buildSearchUrlsSaveReport,
  normalizeSearchUrlsDoc,
  type SearchUrlsSaveReport,
} from '../../../core/config/search_urls/index.ts';
import { validateConfigDoc } from '../../../core/config/validators.ts';
import type { ConfigStore } from '../../../ports/config_store.ts';

export async function saveSearchUrlsDoc(
  store: ConfigStore,
  rawText: string,
): Promise<{ text: string; report: SearchUrlsSaveReport }> {
  // N2 fix: validate the RAW text FIRST, before normalizing — normalize's
  // own "header-only, zero rows" behavior turns an EMPTY string into a
  // legitimate-looking non-empty header doc, which would let a `{text: ''}`
  // PUT (routes.ts's PutConfigBodySchema has no min length) or an empty
  // `config set` stdin silently WIPE a profile's search_urls.md down to a
  // bare header instead of being refused. This call throws
  // validateConfigDoc's existing "search_urls.md must not be empty"
  // message on raw-empty input, BEFORE normalize ever runs.
  validateConfigDoc('search_urls.md', rawText);
  const normalized = normalizeSearchUrlsDoc(rawText); // throws — nothing written, propagates to caller
  validateConfigDoc('search_urls.md', normalized.text); // defense-in-depth; writeText re-checks too
  await store.writeText('search_urls.md', normalized.text);
  return { text: normalized.text, report: buildSearchUrlsSaveReport(normalized) };
}
