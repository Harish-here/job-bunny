import type { StructuredJD, Verdict } from '../../jd/index.ts';
import { normalizeToken } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import type { Rule } from './types.ts';

/** No evalCard — needs structured location + workType data the card
 * doesn't carry. Severity is fixed 'hard': per-city severity is YAGNI
 * until a profile needs it (spec §6). */
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
