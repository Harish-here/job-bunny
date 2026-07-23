/**
 * Notion archive (P7 Task 4). Ports v0's `scripts/notion/cleanup.js`: two
 * staleness rules, both keyed on Date Found —
 *   passed      — Status=Passed pages older than `policy.passedOlderThanDays`
 *   stale lead  — pages with NO Status at all (never triaged — `syncJobs`
 *                 never writes Status) older than `policy.untouchedOlderThanDays`
 * — and archives matches by flipping Notion's own `archived` flag
 * (`NotionApi.archivePage`, Notion's own trash — recoverable, never a hard
 * delete; there is no permanent-delete call on the public API at all).
 *
 * v0 filters server-side (`databases.query`'s `filter` argument); the P7
 * Task 3 `NotionApi.queryDatabase` deliberately exposes no `filter`
 * parameter (whole-DB pagination only, one un-opinionated read path for
 * every caller), so this module pages the whole live DB once and applies
 * both rules client-side instead — logically equivalent to v0's two
 * server-side queries, at the cost of one extra full read on a DB this
 * small (see NOTES in the handoff for this task).
 *
 * Invariant: `policy.dryRun`-equivalent — actually sourced from the
 * connector's settings (`dryRun`, defaulting to true — v0's cleanup.js
 * requires an explicit `--apply`/`CLEANUP_APPLY` opt-in) — is honored here:
 * in dry-run, returns the count that WOULD be archived and performs zero
 * writes. A per-page archive failure (`SoftError`) is recorded and the
 * batch continues, same contract as `sync.ts`.
 */
import { isSoftError } from '../../../core/errors/soft_error.ts';
import type { ArchivePolicy } from '../../../ports/connector.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { NotionApi } from './client.ts';
import { PROPERTIES, type STATUS_OPTIONS } from './schema.ts';

/** The narrow slice of a raw Notion page this module reads. */
interface RawPropertyValue {
  select?: { name: string } | null;
  date?: { start: string } | null;
}

interface RawPage {
  id: string;
  properties?: Record<string, RawPropertyValue | undefined>;
}

// A typed const referencing the option string directly (not
// `STATUS_OPTIONS[STATUS_OPTIONS.indexOf('Passed')]`) so a future rename of
// the 'Passed' option is a compile error here, not a silent `undefined` that
// disables the passed-staleness rule.
const PASSED_STATUS: (typeof STATUS_OPTIONS)[number] = 'Passed';

function propSelectName(p: RawPropertyValue | undefined): string | null {
  return p?.select?.name ?? null;
}

function propDateStart(p: RawPropertyValue | undefined): string | null {
  return p?.date?.start ?? null;
}

/** v0 cleanup.js's `cutoffISO` — `now` minus `daysOld`, as a `YYYY-MM-DD`
 * string (ISO date strings compare lexicographically, so a plain `<`
 * against Date Found's own `date.start` is exact). Built from **local**
 * date components, not `toISOString()` (which serializes in UTC) — Date
 * Found is a local wall-clock date, so in any timezone ahead of UTC
 * (`toISOString()` after local `setDate` arithmetic) the cutoff would land
 * on the wrong side of the local midnight boundary and be a day early.
 * Exported for direct unit testing; `now` defaults to the real current time
 * and is otherwise only ever overridden by tests. */
export function cutoffISO(daysOld: number, now: Date = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - daysOld);
  const year = cutoff.getFullYear();
  const month = String(cutoff.getMonth() + 1).padStart(2, '0');
  const day = String(cutoff.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** True if `page` matches either staleness rule. A page with no Date Found
 * at all can't be evaluated against either cutoff and is never stale (v0's
 * filter required Date Found `before` cutoff too, so a missing date was
 * never a match there either). */
function isStale(page: RawPage, passedCutoff: string, untouchedCutoff: string): boolean {
  const props = page.properties ?? {};
  const status = propSelectName(props[PROPERTIES.status.name]);
  const dateFound = propDateStart(props[PROPERTIES.dateFound.name]);
  if (!dateFound) return false;
  if (status === PASSED_STATUS) return dateFound < passedCutoff;
  if (status === null) return dateFound < untouchedCutoff;
  return false;
}

/** Archives every page matching either staleness rule. Returns the number
 * archived (or, in dry-run, the number that WOULD be archived — no writes
 * performed). `now` defaults to the real current time — the optional
 * override exists purely so tests can pin `cutoffISO`'s output
 * deterministically; the `Connector` port (and every real caller) never
 * passes it. */
export async function archiveStale(
  api: NotionApi,
  dbId: string,
  policy: ArchivePolicy,
  dryRun: boolean,
  ctx: RunContext,
  now: Date = new Date(),
): Promise<number> {
  const rawPages = (await api.queryDatabase(dbId, ctx)) as RawPage[];
  const passedCutoff = cutoffISO(policy.passedOlderThanDays, now);
  const untouchedCutoff = cutoffISO(policy.untouchedOlderThanDays, now);
  const stale = rawPages.filter((page) => isStale(page, passedCutoff, untouchedCutoff));

  if (dryRun) {
    ctx.logger.info('notion archive: dry-run — no writes', {
      wouldArchive: stale.length,
    });
    return stale.length;
  }

  let archived = 0;
  for (const page of stale) {
    try {
      await api.archivePage(page.id, ctx);
      archived++;
    } catch (err) {
      if (!isSoftError(err)) throw err;
      ctx.logger.warn('notion archive: dropped one page after exhausted retries', {
        pageId: page.id,
        error: err.message,
      });
    }
  }
  return archived;
}
