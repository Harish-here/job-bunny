/**
 * SqliteStore — the pipeline-side write/read surface over jobbunny.db.
 * Writes ONLY the `jobs` table (ownership zones, local-DB spec §3);
 * `tracking` is read (archive candidates) but never written here.
 * `db` is public readonly so tests (and PR 2's migrate) can reach the
 * raw handle; production callers go through the methods. Writes use
 * SAVEPOINT/RELEASE (not BEGIN/COMMIT) so these methods are safe to call
 * from inside an outer transaction (e.g. PR 2's migrate).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CacheEntry, JD } from '../../../../core/jd/index.ts';

const UPSERT_SQL = `
INSERT INTO jobs (
  id, lane, title, company, url, seniority, location_city, work_type,
  timezone, skills, excitement, score, match_reasons, date_found,
  jd_json, synced_at, archived, archived_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
ON CONFLICT(id) DO UPDATE SET
  lane = excluded.lane, title = excluded.title, company = excluded.company,
  url = excluded.url, seniority = excluded.seniority,
  location_city = excluded.location_city, work_type = excluded.work_type,
  timezone = excluded.timezone, skills = excluded.skills,
  excitement = excluded.excitement, score = excluded.score,
  match_reasons = excluded.match_reasons, date_found = excluded.date_found,
  jd_json = excluded.jd_json, synced_at = excluded.synced_at,
  archived = 0, archived_at = NULL
`;

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  upsertJobs(jobs: JD[], syncedAt: string): void {
    const stmt = this.db.prepare(UPSERT_SQL);
    this.db.exec('SAVEPOINT jb_upsert');
    try {
      for (const jd of jobs) {
        stmt.run(
          jd.identity.id,
          jd.identity.lane,
          jd.identity.title,
          jd.identity.company,
          jd.identity.url,
          jd.structured?.titleParts.seniority ?? null,
          jd.structured?.locations[0]?.city ?? null,
          jd.structured?.workType ?? null,
          jd.structured?.timezone ?? null,
          jd.structured ? JSON.stringify(jd.structured.skills) : null,
          jd.evaluation?.excitement ?? null,
          jd.evaluation?.score ?? null,
          jd.evaluation ? JSON.stringify(jd.evaluation.matchReasons) : null,
          jd.identity.scrapedAt,
          JSON.stringify(jd),
          syncedAt,
        );
      }
      this.db.exec('RELEASE jb_upsert');
    } catch (err) {
      this.db.exec('ROLLBACK TO jb_upsert');
      this.db.exec('RELEASE jb_upsert');
      throw err;
    }
  }

  listCacheEntries(): CacheEntry[] {
    const rows = this.db
      .prepare(
        'SELECT id, company, title, location_city FROM jobs WHERE archived = 0 ORDER BY id',
      )
      .all() as {
      id: string;
      company: string;
      title: string;
      location_city: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      company: row.company,
      title: row.title,
      pageId: row.id,
      ...(row.location_city ? { city: row.location_city } : {}),
    }));
  }

  listArchiveCandidates(): { id: string; dateFound: string; status: string | null }[] {
    return this.db
      .prepare(
        `SELECT jobs.id AS id, jobs.date_found AS dateFound, tracking.status AS status
         FROM jobs LEFT JOIN tracking ON tracking.job_id = jobs.id
         WHERE jobs.archived = 0 ORDER BY jobs.id`,
      )
      .all() as { id: string; dateFound: string; status: string | null }[];
  }

  markArchived(ids: string[], archivedAt: string): number {
    const stmt = this.db.prepare(
      'UPDATE jobs SET archived = 1, archived_at = ? WHERE id = ? AND archived = 0',
    );
    let archived = 0;
    this.db.exec('SAVEPOINT jb_archive');
    try {
      for (const id of ids) {
        archived += Number(stmt.run(archivedAt, id).changes);
      }
      this.db.exec('RELEASE jb_archive');
    } catch (err) {
      this.db.exec('ROLLBACK TO jb_archive');
      this.db.exec('RELEASE jb_archive');
      throw err;
    }
    return archived;
  }
}
