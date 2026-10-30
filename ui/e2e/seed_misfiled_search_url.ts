/**
 * Boundary exception (sanctioned) — extends the same narrow exception
 * ui/e2e/seed.ts documents at its own top (:2-6): this seeder also imports
 * an adapter (SqliteConfigStore) directly, the one allowed pattern outside
 * cli/wire for TEST SEEDING ONLY. A second, deliberate instance rather than
 * folding into seed.ts: seed.ts is a once-per-suite Playwright
 * `globalSetup` (every spec sees its seed), while R13's misfiled-link state
 * must exist for exactly one spec — filing it globally would make every
 * OTHER settings spec see a spurious misfile notice.
 *
 * Writes rajni's search_urls.md directly via SqliteConfigStore.writeText —
 * bypassing app/features/config/search_urls_save.ts's normalization
 * entirely, which is safe specifically because this blueprint (§1) never
 * modifies writeText's own "stores rawText unmodified" contract. Files one
 * /jobs/search-results/ URL under the WRONG (linkedin__jobs-search)
 * heading — the exact misfile shape R13's card notice detects.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteConfigStore } from '../../src/adapters/db/sqlite/config/index.ts';

const MISFILED_DOC =
  '# Search URLs\n\n## linkedin\n### linkedin__jobs-search\n' +
  '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->\n' +
  '  • Acme DevOps - https://www.linkedin.com/jobs/search-results/?keywords=devops&location=Remote\n';

export async function seedMisfiledSearchUrl(): Promise<void> {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const profileRoot = path.join(root, 'profiles', 'rajni');
  const dbPath = path.join(profileRoot, 'data', 'jobbunny.db');
  if (!dbPath.includes(`${path.sep}rajni${path.sep}`)) {
    throw new Error('refusing: not rajni'); // same belt-and-braces guard as seed.ts:55-57
  }
  const store = new SqliteConfigStore(dbPath, profileRoot);
  try {
    await store.writeText('search_urls.md', MISFILED_DOC);
  } finally {
    store.close();
  }
}
