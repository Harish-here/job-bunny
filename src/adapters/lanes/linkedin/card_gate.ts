import { z } from 'zod';
import type { FilterConfig } from '../../../core/filter/config.ts';
import { decide, evaluateCard } from '../../../core/filter/engine.ts';
import { type DroppedRecord, JDSchema, type Verdict } from '../../../core/jd/index.ts';
import { zodIssuesMessage } from './evidence.ts';
import type { HarvestedCard } from './harvest.ts';

/** Stand-in for an empty title/company (JDSchema requires both min 1) when
 * a card is still unsettled — only ever used on a record already being
 * dropped, never on one that reaches `pass`. */
const UNSETTLED_FIELD_PLACEHOLDER = '(unavailable)';

/**
 * Card-gate: runs the P2 evalCard rules (title, company) against each
 * harvested card (split out of harvest.ts, 2026-08-02, purely to keep
 * that file under the file-size cap). Kept cards pass through unchanged;
 * dropped cards get an identity-only JD (no content/structured yet — the
 * card gate runs before JD open) so the funnel can always answer "why did
 * this disappear?".
 *
 * Building that identity-only JD can itself fail JDSchema.parse when the
 * card's title/company is still empty (the intermittent paint race
 * `CARD_SETTLE_BUDGET_MS` in harvest.ts shrinks but can't eliminate) —
 * this must stay a per-card casualty, not escape and take the whole url
 * down with it (url_runner.ts's whole-url catch stays as a backstop for
 * other error shapes, unrelated to this one). On that ZodError, retry the
 * parse with a placeholder standing in for whichever field was blank, and
 * PREPEND the validation failure ahead of whatever verdict already
 * explained the drop — a verdict computed over an empty title/company is
 * meaningless, so "identity unreadable" is the TRUE reason, and
 * `buildFunnel` (spec: groups by each record's first failing verdict)
 * must see it first. Same `field-validation` shape (`zodIssuesMessage`)
 * `cards.ts`'s per-card catch uses for the same underlying problem.
 *
 * `identityInvalidCount` (2026-08-02 review) lets the caller
 * (`url_runner.ts`) tell "one unsettled card among otherwise-normal
 * cards" (a narrow casualty — the bug this module fixes) apart from "the
 * whole page came back identity-invalid" (a systemic paint-storm/
 * selector-drift signal indistinguishable from the pre-fix crash's own
 * symptom) — the caller restores loud-total-outage semantics for the
 * latter itself; this function only counts.
 */
export function gateCards(
  cards: HarvestedCard[],
  cfg: FilterConfig,
): { pass: HarvestedCard[]; dropped: DroppedRecord[]; identityInvalidCount: number } {
  const pass: HarvestedCard[] = [];
  const dropped: DroppedRecord[] = [];
  let identityInvalidCount = 0;
  for (const card of cards) {
    const verdicts = evaluateCard(card, cfg);
    if (decide(verdicts) === 'keep') {
      pass.push(card);
      continue;
    }
    const reasons: Verdict[] = verdicts;
    const identity = {
      id: card.id,
      lane: 'linkedin',
      url: card.url,
      company: card.company,
      title: card.title,
      scrapedAt: new Date().toISOString(),
    };
    let jd: ReturnType<typeof JDSchema.parse>;
    try {
      jd = JDSchema.parse({ identity });
    } catch (err) {
      if (!(err instanceof z.ZodError)) throw err;
      identityInvalidCount += 1;
      jd = JDSchema.parse({
        identity: {
          ...identity,
          company: card.company || UNSETTLED_FIELD_PLACEHOLDER,
          title: card.title || UNSETTLED_FIELD_PLACEHOLDER,
        },
      });
      reasons.unshift({
        rule: 'linkedin.cardIdentityInvalid',
        severity: 'hard',
        pass: false,
        detail: zodIssuesMessage(err),
      });
    }
    dropped.push({ jd, reasons });
  }
  return { pass, dropped, identityInvalidCount };
}
