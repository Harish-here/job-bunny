/**
 * Playwright `globalSetup` — seeds `profiles/rajni`'s local sqlite DB with
 * `FIXTURE_JOBS` before the e2e suite runs. Touches ONLY
 * `profiles/rajni/data/jobbunny.db` (+ WAL siblings): the `refusing: not
 * rajni` guard is a deliberate belt-and-braces check, never Notion, never
 * any other profile's data (T11 constraint).
 */
import { rmSync } from 'node:fs';
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
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }

  const db = openJobsDb(dbPath);
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
