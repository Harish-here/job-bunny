/**
 * `jobbunny migrate` read side (local-DB spec, PR 2 Task 2). Pulls every page
 * out of an existing Notion job DB and translates each into a
 * `MigratedRecord` — a synthesized `JD` plus the manual tracking fields
 * (absent when the page had none). Strictly READ-ONLY on Notion
 * (`NotionApi.queryDatabase` only, mirroring `cache.ts`'s `rebuildCache`) —
 * migrate performs zero writes; PR 3 owns writing the results into SQLite.
 *
 * Every page must produce a record — a malformed page throws loudly via
 * `JDSchema.parse`/`TrackingFieldsSchema.parse` rather than being silently
 * skipped (a half-import is worse than a loud failure here, since there is
 * no funnel/DroppedRecord concept on this one-shot import path).
 */
import type { JD, WorkType } from '../../../core/jd/index.ts';
import { JDSchema } from '../../../core/jd/index.ts';
import type { MigratedRecord } from '../../../core/tracking/index.ts';
import { TrackingFieldsSchema } from '../../../core/tracking/index.ts';
import type { RunContext } from '../../../ports/context.ts';
import { deriveId } from './cache.ts';
import type { NotionApi } from './client.ts';
import {
  propDateStart,
  propSelectName,
  propText,
  propUrl,
  type RawPage,
} from './properties.ts';
import {
  EXCITEMENT_OPTIONS,
  PROPERTIES,
  SENIORITY_OPTIONS,
  TIMEZONE_OPTIONS,
} from './schema.ts';

const WORK_TYPE_ENUM: Record<string, WorkType> = {
  'On-site': 'onsite',
  Hybrid: 'hybrid',
  Remote: 'remote',
};

const LANE_BY_PREFIX: Record<string, string> = {
  li: 'linkedin',
  gh: 'greenhouse',
  kk: 'keka',
};

export function pageToMigratedRecord(raw: unknown, now: string): MigratedRecord {
  const page = raw as RawPage;
  const props = page.properties ?? {};
  const idNoDashes = page.id.replace(/-/g, '');

  const jobUrl = propUrl(props[PROPERTIES.jobUrl.name]);
  const derivedId = deriveId(jobUrl);
  const id = derivedId || `nt-${idNoDashes}`;
  const prefix = id.split('-')[0] ?? '';
  const lane = LANE_BY_PREFIX[prefix] ?? 'notion-import';

  const url = jobUrl || `https://www.notion.so/${idNoDashes}`;
  const company = propText(props[PROPERTIES.company.name]) || 'Unknown company';
  const title = propText(props[PROPERTIES.jobTitle.name]) || 'Unknown title';

  const dateFound = propDateStart(props[PROPERTIES.dateFound.name]);
  const scrapedAt = dateFound ? `${dateFound.slice(0, 10)}T00:00:00.000Z` : now;

  const seniority = propSelectName(props[PROPERTIES.seniorityLevel.name]);
  const titleParts =
    seniority && (SENIORITY_OPTIONS as readonly string[]).includes(seniority)
      ? { seniority }
      : {};

  const city = propText(props[PROPERTIES.locationCity.name]);
  const locations = city ? [{ city }] : [];

  const workTypeLabel = propSelectName(props[PROPERTIES.workType.name]);
  const workType = workTypeLabel ? WORK_TYPE_ENUM[workTypeLabel] : undefined;

  const timezoneRaw = propSelectName(props[PROPERTIES.timezone.name]);
  const timezone =
    timezoneRaw && (TIMEZONE_OPTIONS as readonly string[]).includes(timezoneRaw)
      ? timezoneRaw
      : undefined;

  const skillsText = propText(props[PROPERTIES.keySkills.name]);
  const skills = skillsText ? skillsText.split(', ') : [];

  const matchReasonsText = propText(props[PROPERTIES.matchReasons.name]);
  const matchReasons = matchReasonsText ? matchReasonsText.split('\n') : [];

  const excitementRaw = propSelectName(props[PROPERTIES.excitement.name]);
  const excitement =
    excitementRaw && (EXCITEMENT_OPTIONS as readonly string[]).includes(excitementRaw)
      ? excitementRaw
      : undefined;

  const candidate: JD = {
    identity: { id, lane, url, company, title, scrapedAt },
    structured: {
      titleParts,
      locations,
      ...(workType ? { workType } : {}),
      ...(timezone ? { timezone } : {}),
      skills,
    },
    evaluation: {
      verdicts: [],
      matchReasons,
      ...(excitement ? { excitement } : {}),
    },
    sync: { pageId: page.id, syncedAt: now },
  };

  const trackingStatus = propSelectName(props[PROPERTIES.status.name]);
  const compRange = propText(props[PROPERTIES.compRange.name]);
  const notes = propText(props[PROPERTIES.notes.name]);
  const contact = propText(props[PROPERTIES.contact.name]);
  const dateAppliedRaw = propDateStart(props[PROPERTIES.dateApplied.name]);
  const nextAction = propText(props[PROPERTIES.nextAction.name]);
  const nextActionDateRaw = propDateStart(props[PROPERTIES.nextActionDate.name]);

  const fields = {
    ...(trackingStatus ? { status: trackingStatus } : {}),
    ...(compRange ? { compRange } : {}),
    ...(notes ? { notes } : {}),
    ...(contact ? { contact } : {}),
    ...(dateAppliedRaw ? { dateApplied: dateAppliedRaw.slice(0, 10) } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(nextActionDateRaw ? { nextActionDate: nextActionDateRaw.slice(0, 10) } : {}),
  };

  return {
    jd: JDSchema.parse(candidate),
    tracking:
      Object.keys(fields).length > 0 ? TrackingFieldsSchema.parse(fields) : undefined,
  };
}

export async function exportForMigration(
  api: NotionApi,
  dbId: string,
  ctx: RunContext,
  now: string = new Date().toISOString(),
): Promise<MigratedRecord[]> {
  const pages = await api.queryDatabase(dbId, ctx);
  return pages.map((page) => {
    try {
      return pageToMigratedRecord(page, now);
    } catch (err) {
      const id = (page as { id?: string }).id ?? 'unknown';
      throw new Error(
        `migrate: Notion page ${id} failed to map — ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  });
}
