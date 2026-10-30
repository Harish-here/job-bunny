/**
 * Boundary exception (sanctioned) — same narrow exception
 * `seed_misfiled_search_url.ts` documents at its own top: a second,
 * dedicated seeder (not folded into that one, whose own doc comment scopes
 * it to exactly one misfiled URL) for task 24's "re-file merges duplicates"
 * e2e case. Writes rajni's `search_urls.md` directly via
 * `SqliteConfigStore.writeText` — bypassing
 * `app/features/config/search_urls_save.ts`'s normalization entirely. That
 * bypass is the WHOLE POINT here: a normal PUT (`config set`/the board's
 * own config route) ALWAYS normalizes+merges search_urls.md server-side
 * (spec R9/R10), so seeding this scenario through the ordinary route would
 * merge the two rows down to one before the test ever navigates — this
 * direct write is the only way to get a genuinely misfiled, not-yet-merged
 * two-row doc onto disk.
 *
 * Files ONE url under two DIFFERENT headings — one wrong
 * (`linkedin__jobs-search`), one already correct
 * (`linkedin__jobs-search-results`) — both resolve to the identical
 * `page|cleanedUrl` key once the wrong one is re-filed, so Refile collapses
 * them to a single row (see the calling spec's own doc comment for why
 * this, not two independently-misfiled rows, is the only reachable variant
 * of this scenario given `classifyRowsForDisplay`'s duplicate-over-misfiled
 * precedence).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteConfigStore } from '../../src/adapters/db/sqlite/config/index.ts';

export const DUPLICATE_MISFILED_URL =
  'https://www.linkedin.com/jobs/search-results/?keywords=platform&location=Remote';

const DUPLICATE_MISFILED_DOC =
  '# Search URLs\n\n## linkedin\n### linkedin__jobs-search\n' +
  '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->\n' +
  `  • Old Filing - ${DUPLICATE_MISFILED_URL}\n` +
  '### linkedin__jobs-search-results\n' +
  '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search-results.json -->\n' +
  `  • Correct Filing - ${DUPLICATE_MISFILED_URL}\n`;

export async function seedDuplicateMisfiledSearchUrl(): Promise<void> {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const profileRoot = path.join(root, 'profiles', 'rajni');
  const dbPath = path.join(profileRoot, 'data', 'jobbunny.db');
  if (!dbPath.includes(`${path.sep}rajni${path.sep}`)) {
    throw new Error('refusing: not rajni'); // same belt-and-braces guard as seed.ts:55-57
  }
  const store = new SqliteConfigStore(dbPath, profileRoot);
  try {
    await store.writeText('search_urls.md', DUPLICATE_MISFILED_DOC);
  } finally {
    store.close();
  }
}
