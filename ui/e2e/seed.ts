/**
 * Boundary exception (sanctioned): this fixture seeder imports
 * src/adapters/db/sqlite directly. depcruise's only-wire-imports-adapters
 * rule scopes to src/** and cannot see ui/e2e/**; this is the one allowed
 * adapter consumer outside cli/wire, for test seeding only — do not copy
 * this pattern.
 *
 * Playwright `globalSetup` — seeds `profiles/rajni`'s local sqlite DB with
 * `FIXTURE_JOBS` before the e2e suite runs. Touches ONLY
 * `profiles/rajni/data/jobbunny.db` (+ WAL siblings): the `refusing: not
 * rajni` guard is a deliberate belt-and-braces check, never Notion, never
 * any other profile's data (T11 constraint).
 *
 * Truncates in place (`DELETE FROM` both tables) rather than deleting and
 * recreating the file: Playwright's `webServer` plugin starts the board
 * server (which lazily opens+memoizes this DB) BEFORE `globalSetups` run,
 * so swapping the inode out from under an already-open handle would pin a
 * deleted file (order-independent here; also avoids an EBUSY on Windows
 * where the open handle blocks `rmSync`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openJobsDb, SqliteStore } from '../../src/adapters/db/sqlite/store/index.ts';
import { FIXTURE_JOBS } from './fixtures.ts';

function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function seed(): void {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const dbPath = path.join(root, 'profiles', 'rajni', 'data', 'jobbunny.db');
  if (!dbPath.includes(`${path.sep}rajni${path.sep}`)) {
    throw new Error('refusing: not rajni');
  }

  const db = openJobsDb(dbPath);
  db.exec('DELETE FROM tracking; DELETE FROM jobs;');
  const store = new SqliteStore(db);
  const now = new Date().toISOString();
  store.upsertJobs(FIXTURE_JOBS, now);
  store.importTracking([
    { jobId: 'rajni-e2e-2', fields: { status: 'Applied' }, updatedAt: now },
    {
      jobId: 'rajni-e2e-3',
      fields: {
        status: 'Tech Round',
        nextAction: 'prep sys design',
        nextActionDate: yesterday(),
      },
      updatedAt: now,
    },
    { jobId: 'rajni-e2e-4', fields: { status: 'Rejected' }, updatedAt: now },
  ]);
  db.close();
}
