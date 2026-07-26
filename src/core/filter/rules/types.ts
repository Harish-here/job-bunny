import type { StructuredJD, Verdict } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';

export interface CardInput {
  title: string;
  company: string;
  location?: string;
}

/** A rule returns undefined when its config section is absent (rule
 * doesn't run) — never a passing verdict for "not configured". */
export interface Rule {
  name: string;
  eval(jd: StructuredJD, cfg: FilterConfig): Verdict[] | undefined;
  /** Card-gate variant using only bare-card fields; omit if the rule
   * needs structured data. */
  evalCard?(card: CardInput, cfg: FilterConfig): Verdict[] | undefined;
}
