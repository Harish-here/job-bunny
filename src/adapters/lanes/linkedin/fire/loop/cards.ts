import { z } from 'zod';
import { JDSchema } from '../../../../../core/jd/index.ts';
import type { PageHandle } from '../../../../../ports/browser.ts';
import type { RunContext } from '../../../../../ports/context.ts';
import { openBreaker } from '../../breaker_store.ts';
import { toSoftError, type UrlStat, zodIssuesMessage } from '../../evidence.ts';
import type { HarvestedCard } from '../../harvest.ts';
import type { Inventory } from '../../inventory.ts';
import { openJd } from '../../jd_open.ts';
import { classifyJdOutcome } from '../probe.ts';
import type { UrlRunnerDeps, UrlRunnerState } from './url_runner.ts';

/** Per-URL mutable bookkeeping threaded through every card of a single url
 * (across every page of it) — split out of `stat`/`state` because it was
 * never part of either's own shape in the original inline loop, just a
 * local closure variable (`capLoggedThisUrl`). */
export interface CardLoopState {
  capLogged: boolean;
}

/**
 * One gate-passed card's cache/dedup/cap check (cheapest first: the card
 * gate already ran in `runUrlGroups`, so this is cache-skip and
 * cross-url dedup — cheap Set lookups — then the per-url cap, a backstop
 * that's loud when it fires, and only then the expensive JD open) plus,
 * if none of those skip it, the JD open itself. Extracted verbatim off
 * the inner card loop of `lane.ts`'s original `source()`. Mutates
 * `state`/`stat`/`capLoop` in place; a throttle trip sets
 * `state.throttleTripped`, which the caller loop uses to stop early.
 */
export async function processCard(
  card: HarvestedCard,
  page: PageHandle,
  inv: Inventory,
  url: string,
  stat: UrlStat,
  capLoop: CardLoopState,
  state: UrlRunnerState,
  deps: UrlRunnerDeps,
  ctx: RunContext,
): Promise<void> {
  ctx.beat();
  if (deps.cacheIds.has(card.id)) {
    return;
  }
  if (state.processedIds.has(card.id)) {
    return;
  }
  if (stat.cardsAttempted >= deps.maxCardsPerUrl) {
    if (!capLoop.capLogged) {
      capLoop.capLogged = true;
      ctx.logger.warn(
        'linkedin lane: maxCardsPerUrl cap hit — dropping remainder for this url',
        { url, maxCardsPerUrl: deps.maxCardsPerUrl },
      );
    }
    state.dropped.push({
      jd: JDSchema.parse({
        identity: {
          id: card.id,
          lane: 'linkedin',
          url: card.url,
          company: card.company,
          title: card.title,
          scrapedAt: new Date().toISOString(),
        },
      }),
      reasons: [
        {
          rule: 'linkedin.maxCardsPerUrlCap',
          severity: 'hard',
          pass: false,
          detail: `maxCardsPerUrl=${deps.maxCardsPerUrl} reached for url "${url}"`,
        },
      ],
    });
    return;
  }

  state.processedIds.add(card.id);
  stat.cardsAttempted += 1;
  try {
    // v0 parity placement: jitter before every JD open
    // (scripts/pipeline/extract.js:282 — `await jitter();`
    // immediately preceding captureJd). Inside this card's
    // own try (a deviation from v0, which has no abort
    // concept): an aborted jitter is this one card's
    // SoftError, same as any other openJd failure below, not
    // an uncaught throw out of the whole card loop.
    await deps.jitter(ctx);
    const { text: rawText, source } = await openJd(page, card, inv, ctx);
    if (source === 'anchor') stat.anchorExtractions += 1;
    const jd = JDSchema.parse({
      identity: {
        id: card.id,
        lane: 'linkedin',
        url: card.url,
        company: card.company,
        title: card.title,
        scrapedAt: new Date().toISOString(),
        location: card.location,
      },
      content: { rawText },
    });
    await state.captureStore.append(deps.storage, jd);
    stat.captured += 1;
    state.throttle?.record('ok');
  } catch (err) {
    // Distinguish "JD pane genuinely failed to open" (openJd
    // already wraps that as a SoftError) from "the card's own
    // identity fields — title/company — came back empty and
    // JDSchema.parse rejected them" (a plain ZodError, thrown
    // here rather than inside openJd). These are different bugs
    // with different fixes, so they must not be folded into one
    // failure kind below.
    stat.failures.push(
      err instanceof z.ZodError
        ? { kind: 'field-validation', message: zodIssuesMessage(err) }
        : {
            kind: 'jd-open',
            message: err instanceof Error ? err.message : String(err),
          },
    );
    const soft = toSoftError('url', card.url, err);
    ctx.logger.warn('linkedin lane: card JD open failed', {
      url: card.url,
      message: soft.message,
    });
    // A per-card JD-open failure must still show up in the
    // funnel — an identity-only JD (no content yet, same
    // shape as gateCards' card-gate drops) paired with the
    // failure reason, so it can always answer "why did this
    // disappear?" instead of only a log line.
    state.dropped.push({
      jd: JDSchema.parse({
        identity: {
          id: card.id,
          lane: 'linkedin',
          url: card.url,
          company: card.company,
          title: card.title,
          scrapedAt: new Date().toISOString(),
        },
      }),
      reasons: [
        {
          rule: 'linkedin.jdOpenFailed',
          severity: 'hard',
          pass: false,
          detail: soft.message,
        },
      ],
    });
    // Was this a server-withheld shell (throttle) or a
    // missing jdRoot (selector drift)? They demand opposite
    // responses, so ask the page rather than guess.
    //
    // A ZodError is excluded structurally, not incidentally:
    // it means openJd SUCCEEDED and JDSchema then rejected the
    // card's identity fields, so jdRoot is present and full of
    // text — the presence probe would answer 'shell' and a
    // drifted title/company selector would masquerade as a
    // throttle, the exact misdiagnosis this module exists to
    // end (throttle.ts's header). Today that is unreachable
    // only because the two JDSchema.parse calls happen to
    // agree; this makes it not depend on that.
    if (state.throttle && page && !(err instanceof z.ZodError)) {
      const outcome = await classifyJdOutcome(page, inv, ctx);
      if (outcome === 'shell') state.shellJdFailures += 1;
      state.throttle.record(outcome);
      if (state.throttle.tripped && deps.breaker) {
        state.throttleTripped = true;
        const wrote = openBreaker(
          deps.breaker.userDataDir,
          deps.breaker.deps,
          deps.breakerState,
        );
        ctx.logger.warn(
          'linkedin lane: 3 consecutive server-withheld JD shells — the session is throttled; opening the breaker and stopping this fire, keeping every capture so far',
          { url: card.url, breakerWritten: wrote },
        );
      }
    }
  }
}
