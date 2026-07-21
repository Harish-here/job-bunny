import type { z } from 'zod';
import type { Verdict } from '../../jd/index.ts';
import { normalizeToken } from '../../jd/index.ts';
import type { FilterConfig, MatchRuleSchema } from '../config.ts';
import type { CardInput, Rule } from './types.ts';

type MatchRule = z.infer<typeof MatchRuleSchema>;

function evalMatchRule(name: string, haystack: string, rule: MatchRule): Verdict {
  const folded = normalizeToken(haystack);
  const hit = (list: string[]) => list.some((t) => folded.includes(normalizeToken(t)));
  if (rule.reject.length > 0 && hit(rule.reject)) {
    return {
      rule: name,
      severity: rule.severity,
      pass: false,
      detail: 'matched reject list',
    };
  }
  if (rule.match.length > 0 && !hit(rule.match)) {
    return {
      rule: name,
      severity: rule.severity,
      pass: false,
      detail: `no match in [${rule.match.join(', ')}]`,
    };
  }
  return { rule: name, severity: rule.severity, pass: true };
}

function evalTitleText(title: string, cfg: FilterConfig): Verdict[] | undefined {
  if (!cfg.title) return undefined;
  const out: Verdict[] = [];
  if (cfg.title.domain) out.push(evalMatchRule('title.domain', title, cfg.title.domain));
  if (cfg.title.function)
    out.push(evalMatchRule('title.function', title, cfg.title.function));
  if (cfg.title.seniority)
    out.push(evalMatchRule('title.seniority', title, cfg.title.seniority));
  return out.length > 0 ? out : undefined;
}

export const titleRule: Rule = {
  name: 'title',
  eval: (jd, cfg) => evalTitleText(jd.identity.title, cfg),
  evalCard: (card: CardInput, cfg) => evalTitleText(card.title, cfg),
};
