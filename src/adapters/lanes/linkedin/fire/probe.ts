import type { FilterConfig } from '../../../../core/filter/config.ts';
import { type JD, JDSchema } from '../../../../core/jd/index.ts';
import type { BrowserHandle, PageHandle } from '../../../../ports/browser.ts';
import type { RunContext } from '../../../../ports/context.ts';
import type { Storage } from '../../../../ports/storage.ts';
import type { LinkedinBreakerConfig, LinkedinBreakerState } from '../breaker_store.ts';
import { closeBreaker, openBreaker, recordProbe } from '../breaker_store.ts';
import type { CaptureStore } from '../capture_store.ts';
import type { UrlStat } from '../evidence.ts';
import { gateCards, harvestCards } from '../harvest.ts';
import type { Inventory } from '../inventory.ts';
import { buildJdRootPresenceScript, openJd } from '../jd_open.ts';
import type { SearchUrlGroup } from '../search_urls.ts';
import type { JdOutcome } from '../throttle.ts';

/** Own copy of the goto deadline used by both this module and
 * `url_runner.ts` — each traces back to the single `DEFAULT_GOTO_TIMEOUT_MS`
 * declared in `lane.ts` before this split; duplicated rather than
 * cross-imported so neither sibling file in `fire/` depends on the other
 * for a plain constant. */
const DEFAULT_GOTO_TIMEOUT_MS = 30_000;

/** Deadline for the tiny in-page jdRoot presence read run after a failed
 * JD open. Short on purpose: it is a diagnostic, and a page too sick to
 * answer it in 5s is classified `missing` (never a trip). */
const JD_ROOT_PRESENCE_TIMEOUT_MS = 5_000;

/** What one half-open probe concluded (spec §4.5 step 3). `inconclusive`
 * deliberately carries its message so the skipped reason can name the real
 * failure instead of implying the session is still blocked. `ok` carries
 * the probed `url` as well as the JD: a successful probe is a real attempt
 * against a real url and gets its own `UrlStat` back in `source()`. */
export type ProbeOutcome =
  | { result: 'ok'; jd: JD; cardId: string; url: string }
  | { result: 'shell' }
  | { result: 'inconclusive'; message: string };

/** Classifies a JD open that already FAILED, from the tri-state jdRoot
 * read (`buildJdRootPresenceScript`, spec D4). ONLY `'empty'` — jdRoot
 * matched and its text is empty — is `shell`, the server-withheld
 * content that counts toward a throttle. Everything else is `missing`,
 * the neutral verdict that never trips: `''` (matched nothing, i.e.
 * selector drift) and `'text'` (matched a pane that still holds text —
 * a stale/previous JD left in the DOM by e.g. a goto timeout, which is
 * a failed open but emphatically not a withheld one).
 *
 * Never returns `ok`: a successful open is recorded directly at the call
 * site. Any failure of the read itself (dead page, timeout) is
 * classified `missing` too, the conservative answer — an unknown must
 * never push the counter toward opening the breaker. */
export async function classifyJdOutcome(
  page: PageHandle,
  inv: Inventory,
  ctx: RunContext,
): Promise<JdOutcome> {
  try {
    const jdRoot = await page.evaluate<string>(
      buildJdRootPresenceScript(inv.selectors.jdRoot),
      { timeoutMs: JD_ROOT_PRESENCE_TIMEOUT_MS },
    );
    return jdRoot === 'empty' ? 'shell' : 'missing';
  } catch (err) {
    ctx.logger.debug(
      'linkedin lane: jdRoot presence check failed — classifying as missing',
      { message: err instanceof Error ? err.message : String(err) },
    );
    return 'missing';
  }
}

/** The lane fields `runProbe` reads — `inventories`/`filterCfg` per the
 * split brief, plus `urls` (the group/url it probes). */
export interface ProbeDeps {
  urls: SearchUrlGroup[];
  inventories: Inventory[];
  filterCfg: FilterConfig;
}

/** Half-open probe (D8): first url of the first group, one harvest,
 * exactly ONE JD open. Never throws — every failure becomes an
 * `inconclusive` outcome, because a broken page must not be allowed to
 * close a breaker (spec §5). Deliberately unpaced: two requests are not
 * a burst, and a blocked fire should learn its fate quickly. */
export async function runProbe(
  deps: ProbeDeps,
  handle: BrowserHandle,
  ctx: RunContext,
): Promise<ProbeOutcome> {
  const group = deps.urls[0];
  const url = group?.urls[0];
  const inv = group
    ? deps.inventories.find((candidate) => candidate.page === group.page)
    : undefined;
  if (!group || !url || !inv) {
    return { result: 'inconclusive', message: 'no url/inventory available to probe' };
  }

  let page: PageHandle | undefined;
  try {
    page = await handle.newPage();
    ctx.beat();
    await page.goto(url, { timeoutMs: DEFAULT_GOTO_TIMEOUT_MS });
    const cards = await harvestCards(page, inv, ctx);
    const { pass } = gateCards(cards, deps.filterCfg);
    const card = pass[0];
    if (!card) {
      return {
        result: 'inconclusive',
        message: `no gate-passing card to probe on ${url}`,
      };
    }

    let text: string;
    try {
      text = (await openJd(page, card, inv, ctx)).text;
    } catch (err) {
      const outcome = await classifyJdOutcome(page, inv, ctx);
      if (outcome === 'shell') return { result: 'shell' };
      return {
        result: 'inconclusive',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // Built outside the inner try on purpose: a JDSchema rejection here
    // is an empty-title/company problem, not a throttle verdict, so it
    // must fall to the outer catch as `inconclusive` rather than be
    // classified as a shell.
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
      content: { rawText: text },
    });
    return { result: 'ok', jd, cardId: card.id, url };
  } catch (err) {
    return {
      result: 'inconclusive',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (page) await page.close();
  }
}

/** What the half-open probe orchestration concluded — `skipped` means
 * `source()` must return early with that reason (a still-throttled or
 * inconclusive probe); its absence means the fire should continue, having
 * already recorded the probe's own capture/UrlStat/dedup entry into `io`. */
export interface HalfOpenProbeResult {
  skipped?: { reason: string };
}

/** The mutable collections a successful (`ok`) probe needs to update —
 * a deliberately narrow subset of `fire/loop`'s `UrlRunnerState`/`Deps`
 * (not imported directly: `loop/` imports FROM `probe.ts` for
 * `classifyJdOutcome`, so importing `loop/`'s types back here would be a
 * needless cross-module cycle for what is, at this call site, only four
 * fields). */
export interface HalfOpenProbeIo {
  captureStore: CaptureStore;
  storage: Storage;
  processedIds: Set<string>;
  stats: UrlStat[];
}

/** Orchestrates the half-open probe (D8) end to end: run it, then act on
 * its verdict — re-open the breaker on a shell, leave it open on an
 * inconclusive result, or close it and fold the probe's own capture into
 * this fire on real text. Extracted off `lane.ts`'s `source()` (the
 * `phase === 'half-open'` branch) so that orchestration doesn't have to
 * live inline in the class — `lane.ts` calls this once, then either
 * returns `result.skipped` or continues into `runUrlGroups`. */
export async function runHalfOpenProbe(
  breaker: LinkedinBreakerConfig,
  breakerState: LinkedinBreakerState,
  probeDeps: ProbeDeps,
  handle: BrowserHandle,
  io: HalfOpenProbeIo,
  ctx: RunContext,
): Promise<HalfOpenProbeResult> {
  const probe = await runProbe(probeDeps, handle, ctx);
  const { userDataDir, deps } = breaker;

  if (probe.result === 'shell') {
    // Still blocked. Re-open for another full cooldown, keeping the
    // record that a probe ran. ~2 requests spent instead of a fire.
    const breakerWritten = openBreaker(userDataDir, deps, {
      ...breakerState,
      lastProbeAt: deps.now().toISOString(),
    });
    ctx.logger.warn(
      'linkedin lane: half-open probe still got a server-withheld shell — breaker re-opened, ending this fire',
      { tripCount: breakerState.tripCount + 1, breakerWritten },
    );
    return { skipped: { reason: 'probe found the session still throttled' } };
  }

  if (probe.result === 'inconclusive') {
    // A broken page proves nothing (spec §5) — leave openedAt where
    // it is so the next fire past the window probes again.
    const breakerWritten = recordProbe(userDataDir, deps, breakerState);
    ctx.logger.warn(
      'linkedin lane: half-open probe was inconclusive — breaker left open, ending this fire',
      { message: probe.message, breakerWritten },
    );
    return { skipped: { reason: `probe inconclusive: ${probe.message}` } };
  }

  // Real text: the block cleared. Delete the file and carry on with
  // this same fire (D8) — the probe's own capture counts, and its
  // card id joins processedIds so the main loop does not re-open it.
  closeBreaker(userDataDir, deps);
  // Dedupe before appending: the probe always re-opens the FIRST
  // gate-passing card of the first url, which an earlier same-day
  // fire may already have flushed to captures.json (CaptureStore
  // seeds itself from it). Appending it again would cost a
  // compress `duplicate-id` drop and one wasted LLM row on every
  // single recovery.
  if (!io.captureStore.all().some((j) => j.identity.id === probe.cardId)) {
    await io.captureStore.append(io.storage, probe.jd);
  }
  // Unconditional, unlike the append above: captured now or captured
  // earlier today, the main loop must not spend a second JD open on
  // this card.
  io.processedIds.add(probe.cardId);
  // A successful probe IS an attempted url, so it gets a UrlStat like
  // any other attempt. Without one, the aggregates below undercount
  // the probe's card and capture by one, and — on a single-url
  // profile whose main-loop cards then all fail — the
  // all-urls-failed guard throws away a fire that demonstrably DID
  // capture a JD.
  io.stats.push({
    url: probe.url,
    cardsAttempted: 1,
    captured: 1,
    // Not tracked for the probe: `runProbe` reads only openJd's text,
    // and one probe is far too thin a sample to raise the
    // "the anchor fallback is carrying this run" warning on.
    anchorExtractions: 0,
    failed: false,
    failures: [],
  });
  ctx.logger.info(
    'linkedin lane: half-open probe returned real JD text — breaker closed, continuing this fire',
    { cardId: probe.cardId },
  );
  return {};
}
