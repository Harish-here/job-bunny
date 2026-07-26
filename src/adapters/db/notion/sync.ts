/**
 * Notion sync (P7 Task 4). Ports v0's `scripts/notion/notion_sync.js`
 * `buildProperties`/insert loop onto the v2 `JD`/`Connector` shape: writes
 * AUTOMATED FIELDS ONLY (pinned in `schema.ts`'s `AUTOMATED_FIELDS`, itself
 * ported byte-exact from v0's `schema.js` lines 58-74) — manual tracking
 * fields (Status, Notes, Contact, …) are never touched, so a human's
 * tracking data is never clobbered. Insert-only when the job has no known
 * `sync.pageId` (`pages.create`, v0's only path); update-only-the-automated-
 * properties when it does (a v2 generalization the Connector port requires
 * — never a whole-page overwrite, never a delete).
 *
 * Inputs: an already-constructed `NotionApi`, the target database id, a
 * batch of `JD`, and a `RunContext`. Output: `SyncedJD[]` — one entry per
 * job that was successfully inserted or updated, `sync.pageId`/`syncedAt`
 * filled in. A job whose write fails is dropped from the batch's output
 * rather than aborting the whole call — see the per-job try/catch below.
 *
 * Invariant: a per-page failure is recorded and the batch continues. This
 * relies entirely on `NotionApi.createPage`/`updatePage`'s own contract:
 * an exhausted-retry failure is a `SoftError` (caught here, logged, job
 * skipped); anything else (auth/validation/other non-retryable error) is
 * NOT a `SoftError` and propagates, failing the whole `syncJobs` call
 * loudly — a broken token or a malformed select value is a config problem,
 * not a one-page casualty.
 */
import { isSoftError, type SoftError } from '../../../core/errors/soft_error.ts';
import type { JD, SyncedJD, WorkType } from '../../../core/jd/index.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { NotionApi } from './client.ts';
import {
  EXCITEMENT_OPTIONS,
  PROPERTIES,
  SENIORITY_OPTIONS,
  TIMEZONE_OPTIONS,
} from './schema.ts';

/** True iff `value` is an exact member of `options` — used to guard every
 * free-form LLM-derived select value (`titleParts.seniority`,
 * `structured.timezone`, `evaluation.excitement`) before it's written as a
 * Notion select property. An invalid select name is a non-retryable Notion
 * 400 (`isSoftError` is false for it) that would abort the whole
 * `syncJobs` batch — omitting the property is strictly safer than risking
 * that, and matches this function's existing "omit rather than write a
 * false placeholder" posture for missing data. `workType` doesn't need this
 * — it's already mapped through the fixed `WORK_TYPE_LABELS` lookup below. */
function isValidOption(value: string, options: readonly string[]): boolean {
  return options.includes(value);
}

const richText = (content: string) => [{ type: 'text', text: { content } }];

const titleProp = (v: string) => ({ title: richText(v) });
const richTextProp = (v: string) => ({ rich_text: richText(v) });
const selectProp = (name: string) => ({ select: { name } });
const urlProp = (v: string) => ({ url: v });
const dateProp = (isoDate: string) => ({ date: { start: isoDate } });

/** v0's `work_type` was already the Notion select label ('Remote'/'Hybrid'/
 * 'On-site'); v2's `structured.workType` is the lower-case enum
 * (`WorkTypeSchema`) instead — this is the one-line translation between
 * them, pinned against `schema.ts`'s `WORK_TYPE_OPTIONS`. */
const WORK_TYPE_LABELS: Record<WorkType, string> = {
  onsite: 'On-site',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

/** Builds the automated-only Notion properties payload for one job — used
 * for both insert and update, since both write exactly the same field set
 * (v0 never distinguished the two; here the only asymmetry is which
 * `NotionApi` call receives the payload, in `syncJobs` below). Every key is
 * one of `schema.ts`'s `AUTOMATED_FIELDS` by construction — a field the v2
 * `JD` has no data for (no v0 counterpart yet, e.g. YoE, Source URL) is
 * simply omitted rather than written as a false/empty placeholder, so an
 * omission never looks like "explicitly cleared". The three select-backed
 * fields sourced from free-form LLM output (`seniority`/`timezone`/
 * `excitement`) are additionally validated against their `schema.ts` option
 * lists (`isValidOption` above) and omitted — not written — when the LLM's
 * value isn't an exact match, since an invalid select name is a
 * non-retryable Notion 400 that would otherwise abort the whole batch. */
export function buildAutomatedProperties(job: JD): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [PROPERTIES.jobTitle.name]: titleProp(job.identity.title),
    [PROPERTIES.company.name]: richTextProp(job.identity.company),
    [PROPERTIES.jobUrl.name]: urlProp(job.identity.url),
    // v0's `date_found` is set once, at extraction time — the closest v2
    // equivalent is `identity.scrapedAt` (also set once, at fetch time),
    // sliced from a datetime down to the date the schema's `date` property
    // expects.
    [PROPERTIES.dateFound.name]: dateProp(job.identity.scrapedAt.slice(0, 10)),
  };

  const city = job.structured?.locations[0]?.city;
  if (city) props[PROPERTIES.locationCity.name] = richTextProp(city);

  const seniority = job.structured?.titleParts.seniority;
  if (seniority && isValidOption(seniority, SENIORITY_OPTIONS))
    props[PROPERTIES.seniorityLevel.name] = selectProp(seniority);

  const workType = job.structured?.workType;
  if (workType) props[PROPERTIES.workType.name] = selectProp(WORK_TYPE_LABELS[workType]);

  const timezone = job.structured?.timezone;
  if (timezone && isValidOption(timezone, TIMEZONE_OPTIONS))
    props[PROPERTIES.timezone.name] = selectProp(timezone);

  if (job.structured)
    props[PROPERTIES.keySkills.name] = richTextProp(job.structured.skills.join(', '));

  const excitement = job.evaluation?.excitement;
  if (excitement && isValidOption(excitement, EXCITEMENT_OPTIONS))
    props[PROPERTIES.excitement.name] = selectProp(excitement);

  if (job.evaluation) {
    props[PROPERTIES.matchReasons.name] = richTextProp(
      job.evaluation.matchReasons.join('\n'),
    );
  }

  // v0's Review Flags column held `filter.js`'s soft-fail `filter_flags`,
  // distinct from rank's `match_reasons` — v2's filter stage folds a soft
  // verdict's detail into `matchReasons` too (see core/rank/rank.ts), so
  // this recomputes the same soft-fail subset from `evaluation.verdicts` as
  // the closest available analogue, rather than leaving the column empty.
  const reviewFlags = (job.evaluation?.verdicts ?? [])
    .filter((v) => v.severity === 'soft' && !v.pass)
    .map((v) => v.detail ?? `${v.rule}: soft-fail`);
  if (reviewFlags.length > 0)
    props[PROPERTIES.reviewFlags.name] = richTextProp(reviewFlags.join('; '));

  return props;
}

/** Syncs a batch of jobs: insert (no `job.sync.pageId`) or update (has one),
 * automated properties only. One job's write failure (`SoftError` from
 * `NotionApi`) is logged and skipped — the rest of the batch still runs.
 * Any other thrown error (non-retryable — auth/validation/etc.) propagates
 * and fails the whole call. */
export async function syncJobs(
  api: NotionApi,
  dbId: string,
  jobs: JD[],
  ctx: RunContext,
): Promise<SyncedJD[]> {
  const results: SyncedJD[] = [];

  for (const job of jobs) {
    const properties = buildAutomatedProperties(job);
    const knownPageId = job.sync?.pageId;

    try {
      const pageId = knownPageId
        ? (await api.updatePage(knownPageId, properties, ctx)).id
        : (await api.createPage(dbId, properties, ctx)).id;
      results.push({ ...job, sync: { pageId, syncedAt: new Date().toISOString() } });
    } catch (err) {
      if (!isSoftError(err)) throw err;
      logDroppedPage(ctx, job, knownPageId, err);
    }
  }

  return results;
}

function logDroppedPage(
  ctx: RunContext,
  job: JD,
  pageId: string | undefined,
  err: SoftError,
): void {
  ctx.logger.warn('notion sync: dropped one page after exhausted retries', {
    action: pageId ? 'update' : 'create',
    jobId: job.identity.id,
    company: job.identity.company,
    title: job.identity.title,
    pageId,
    error: err.message,
  });
}
