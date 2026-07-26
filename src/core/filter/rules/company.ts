import type { Verdict } from '../../jd/index.ts';
import { companyKey } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import type { CardInput, Rule } from './types.ts';

/** Avoid-list is non-negotiable (spec §6): severity is always 'hard'
 * regardless of config — there is no per-rule severity to configure. */
function evalCompany(company: string, cfg: FilterConfig): Verdict[] | undefined {
  if (!cfg.companies) return undefined;
  const key = companyKey(company);
  const hit = cfg.companies.avoid.some((avoid) => companyKey(avoid) === key);
  return [
    {
      rule: 'company.avoid',
      severity: 'hard',
      pass: !hit,
      detail: hit ? 'matched avoid list' : undefined,
    },
  ];
}

export const companyRule: Rule = {
  name: 'company',
  eval: (jd, cfg) => evalCompany(jd.identity.company, cfg),
  evalCard: (card: CardInput, cfg) => evalCompany(card.company, cfg),
};
