import type { StructuredJD, Verdict } from '../jd/index.ts';
import type { FilterConfig } from './config.ts';
import { companyRule } from './rules/company.ts';
import { locationRule } from './rules/location.ts';
import { skillsRule } from './rules/skills.ts';
import { timezoneRule } from './rules/timezone.ts';
import { titleRule } from './rules/title.ts';
import type { CardInput, Rule } from './rules/types.ts';

export const RULES: Rule[] = [
  titleRule,
  companyRule,
  locationRule,
  timezoneRule,
  skillsRule,
];

/** Full evaluation against a structured JD — concat-maps every rule's
 * `eval`, dropping rules whose config section is absent. */
export function evaluate(jd: StructuredJD, cfg: FilterConfig): Verdict[] {
  return RULES.flatMap((rule) => rule.eval(jd, cfg) ?? []);
}

/** Card-gate evaluation — only rules with an `evalCard` (title, company)
 * run; the rest need structured data the card doesn't carry. */
export function evaluateCard(card: CardInput, cfg: FilterConfig): Verdict[] {
  return RULES.flatMap((rule) => rule.evalCard?.(card, cfg) ?? []);
}

/** drop iff any verdict is a failing hard rule; soft failures keep
 * (recorded for rank). */
export function decide(verdicts: Verdict[]): 'keep' | 'drop' {
  return verdicts.some((v) => !v.pass && v.severity === 'hard') ? 'drop' : 'keep';
}
