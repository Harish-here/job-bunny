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
import { type DroppedRecord, JDSchema } from '../../../core/jd/index.ts';
import type { ArchivePolicy } from '../../../ports/connector.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { NotionApi } from './client.ts';
import { PROPERTIES, type STATUS_OPTIONS } from './schema.ts';

/** The narrow slice of a raw Notion page this module reads — title/
 * rich_text/url added alongside select/date so a page that fails to
 * archive can still be turned into a DroppedRecord (same property-reader
 * idiom as `cache.ts`'s `propText`/`propUrl`). */
interface RawPropertyValue {
  select?: { name: string } | null;
  date?: { start: string } | null;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  url?: string | null;
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

/** Same reader idiom as `cache.ts`'s `plainText`/`propText`/`propUrl` — kept
 * as a private local copy (not imported) since `cache.ts` doesn't currently
 * export these and this module's own `RawPropertyValue` is a strict subset
 * anyway. */
function plainText(parts: { plain_text: string }[] | undefined): string {
  return (parts ?? []).map((t) => t.plain_text).join('');
}

function propText(p: RawPropertyValue | undefined): string {
  if (p?.title) return plainText(p.title);
  if (p?.rich_text) return plainText(p.rich_text);
  return '';
}

function propUrl(p: RawPropertyValue | undefined): string | null {
  return p?.url ?? null;
}

/** Builds a DroppedRecord for a page that failed to archive, so the
 * caller can account for it (same funnel-visibility idiom as `sync.ts`'s
 * `sync.failed` DroppedRecords) instead of it vanishing into a warn log
 * line. Best-effort identity: Job Title/Company/Job URL read straight off
 * the page's own properties (populated by `sync.ts` on write), falling
 * back to placeholder values when a property is empty so JDSchema's
 * min-length/url constraints are always satisfiable — a page can legally
 * lack these (e.g. `sync.ts` never wrote them) without losing the drop
 * accounting. */
function toDroppedRecord(page: RawPage, detail: string): DroppedRecord {
  const props = page.properties ?? {};
  const title = propText(props[PROPERTIES.jobTitle.name]) || 'Unknown title';
  const company = propText(props[PROPERTIES.company.name]) || 'Unknown company';
  const url =
    propUrl(props[PROPERTIES.jobUrl.name]) ||
    `https://www.notion.so/${page.id.replace(/-/g, '')}`;
  return {
    jd: JDSchema.parse({
      identity: {
        id: page.id,
        lane: 'notion-archive',
        url,
        company,
        title,
        scrapedAt: new Date().toISOString(),
      },
    }),
    reasons: [
      {
        rule: 'archive.failed',
        severity: 'hard',
        pass: false,
        detail,
      },
    ],
  };
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
 * performed) plus every page that failed to archive as a DroppedRecord
 * (see `toDroppedRecord`) — mirrors `sync.ts`'s `sync.failed` drops, so a
 * caller (the `Connector.archiveStale` port, and above it the `cleanup`
 * routine) can account for it instead of it only reaching a warn log
 * line. `now` defaults to the real current time — the optional override
 * exists purely so tests can pin `cutoffISO`'s output deterministically;
 * the `Connector` port (and every real caller) never passes it. */
export async function archiveStale(
  api: NotionApi,
  dbId: string,
  policy: ArchivePolicy,
  dryRun: boolean,
  ctx: RunContext,
  now: Date = new Date(),
): Promise<{ archived: number; dropped: DroppedRecord[] }> {
  const rawPages = (await api.queryDatabase(dbId, ctx)) as RawPage[];
  const passedCutoff = cutoffISO(policy.passedOlderThanDays, now);
  const untouchedCutoff = cutoffISO(policy.untouchedOlderThanDays, now);
  const stale = rawPages.filter((page) => isStale(page, passedCutoff, untouchedCutoff));

  if (dryRun) {
    ctx.logger.info('notion archive: dry-run — no writes', {
      wouldArchive: stale.length,
    });
    return { archived: stale.length, dropped: [] };
  }

  let archived = 0;
  const dropped: DroppedRecord[] = [];
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
      dropped.push(toDroppedRecord(page, err.message));
    }
  }
  return { archived, dropped };
}
