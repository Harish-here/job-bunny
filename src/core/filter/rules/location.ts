import type { StructuredJD, Verdict } from '../../jd/index.ts';
import { normalizeToken } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import type { Rule } from './types.ts';

/** No evalCard — needs structured location + workType data the card
 * doesn't carry. Severity is fixed 'hard': per-city severity is YAGNI
 * until a profile needs it (spec §6).
 *
 * Missing-data posture: workType===undefined always passes ('workType
 * unknown') regardless of locations. When workType is known but
 * locations=[] (schema allows this — the LLM found no city, e.g.
 * "Remote — APAC"), city matching is impossible, so the verdict rests
 * on workType alone against the config entries (any city, including
 * non-wildcard ones): pass if any entry accepts that workType at all,
 * hard-fail only when no entry does (positive evidence of a workType
 * mismatch, independent of the missing city). */
export const locationRule: Rule = {
  name: 'location',
  eval: (jd: StructuredJD, cfg: FilterConfig): Verdict[] | undefined => {
    if (!cfg.locations) return undefined;
    const { workType, locations } = jd.structured;
    if (workType === undefined) {
      return [
        {
          rule: 'location.workType',
          severity: 'hard',
          pass: true,
          detail: 'workType unknown',
        },
      ];
    }
    if (locations.length === 0) {
      const hit = cfg.locations.some((entry) => entry.workTypes.includes(workType));
      return [
        {
          rule: 'location.workType',
          severity: 'hard',
          pass: hit,
          detail: hit
            ? undefined
            : 'no config entry accepts this workType (location unknown)',
        },
      ];
    }
    const hit = locations.some((loc) =>
      cfg.locations?.some(
        (entry) =>
          (entry.city === '*' ||
            normalizeToken(entry.city) === normalizeToken(loc.city)) &&
          entry.workTypes.includes(workType),
      ),
    );
    return [
      {
        rule: 'location.workType',
        severity: 'hard',
        pass: hit,
        detail: hit ? undefined : 'no location/workType match',
      },
    ];
  },
};
