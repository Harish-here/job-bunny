import type { StructuredJD, Verdict } from '../../jd/index.ts';
import { normalizeToken } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import type { Rule } from './types.ts';

/** No evalCard — needs structured skills extracted from the JD body. */
export const skillsRule: Rule = {
  name: 'skills',
  eval: (jd: StructuredJD, cfg: FilterConfig): Verdict[] | undefined => {
    if (!cfg.skills) return undefined;
    const skillSet = new Set(jd.structured.skills.map(normalizeToken));
    const intersection = cfg.skills.core.filter((c) => skillSet.has(normalizeToken(c)));
    const pass = intersection.length >= cfg.skills.minMatch;
    return [
      {
        rule: 'skills.core',
        severity: cfg.skills.severity,
        pass,
        detail: `matched: [${intersection.join(', ')}]`,
      },
    ];
  },
};
