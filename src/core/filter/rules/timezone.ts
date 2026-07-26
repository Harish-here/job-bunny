import type { StructuredJD, Verdict } from '../../jd/index.ts';
import { normalizeToken } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import type { Rule } from './types.ts';

/** No evalCard — needs structured workType + timezone. Only runs for
 * remote roles with a known timezone and a configured accept list
 * (spec §6); otherwise the rule doesn't run (undefined). */
export const timezoneRule: Rule = {
  name: 'timezone',
  eval: (jd: StructuredJD, cfg: FilterConfig): Verdict[] | undefined => {
    const { workType, timezone } = jd.structured;
    if (workType !== 'remote' || timezone === undefined || !cfg.timezones)
      return undefined;
    const folded = normalizeToken(timezone);
    const hit = cfg.timezones.accept.some((tz) => normalizeToken(tz) === folded);
    return [
      {
        rule: 'timezone.accept',
        severity: cfg.timezones.severity,
        pass: hit,
        detail: hit ? undefined : `timezone not in [${cfg.timezones.accept.join(', ')}]`,
      },
    ];
  },
};
