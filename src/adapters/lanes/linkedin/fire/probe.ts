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

/** How many search urls the half-open probe will try before concluding it
 * has nothing to test. One is not enough: the gate (title/company, from
 * filter.json) passes ~0–2 cards per 25-card page, and a narrow first url —
 * harish's is a last-24h Australia-remote search — routinely yields zero.
 * Pinning the probe to urls[0] made a barren first url indistinguishable
 * from a live block, and parked the breaker open indefinitely (2026-07-28). */
const PROBE_MAX_URLS = 3;

/** What one half-open probe concluded (spec §4.5 step 3). `inconclusive`
 * deliberately carries its message so the skipped reason can name the real
 * failure instead of implying the session is still blocked. `ok` carries
 * the probed `url` as well as the JD: a successful probe is a real attempt
 * against a real url and gets its own `UrlStat` back in `source()`.
 * `no-candidate` means every url the probe tried harvested fine but gated
 * out every card — a barren search, not proof of anything either way. It
 * fails the breaker OPEN (closes it and lets the fire continue) rather than
 * holding it shut, because `closeBreaker` is otherwise reachable only via
 * `'ok'`, and no-evidence must not mean permanently shut. */
export type ProbeOutcome =
  | { result: 'ok'; jd: JD; cardId: string; url: string }
  | { result: 'shell' }
  | { result: 'no-candidate'; message: string }
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
  /** Pause between probe targets — same gap the main loop puts between
   * urls. Optional so existing callers/tests need no change; when absent
   * the probe runs unpaced. */
  interUrlPause?: () => Promise<void>;
}

/** Half-open probe (D8): walks up to `PROBE_MAX_URLS` urls, one harvest
 * and at most ONE JD open each, stopping at the first gate-passing card.
 * Every failure of the probed page itself becomes an `inconclusive`
 * outcome rather than a throw, because a broken page must not be allowed
 * to close a breaker (spec §5) — the one exception is an aborted
 * `ctx.signal` during the inter-target pause below, which propagates
 * loud like everywhere else in this lane (AbortSignal is the deadline
 * mechanism, not a SoftError source).
 * Paced like the main loop: `interUrlPause` runs between targets (never
 * before the first). Up to `PROBE_MAX_URLS` back-to-back navigations
 * right after a 4-hour cooldown is exactly the burst shape that pacing
 * exists to prevent, and a barren first url is the expected path for this
 * profile, not a rare one — unpaced, every recovery fire would open with
 * a real navigation burst. */
export async function runProbe(
  deps: ProbeDeps,
  handle: BrowserHandle,
  ctx: RunContext,
): Promise<ProbeOutcome> {
  // Flattened (url, inventory) pairs in configured order, capped at
  // PROBE_MAX_URLS. A group whose inventory is missing is skipped rather
  // than aborting the probe: one unusable group must not make the whole
  // recovery unprovable.
  const targets: { url: string; inv: Inventory }[] = [];
  for (const group of deps.urls) {
    const inv = deps.inventories.find((candidate) => candidate.page === group.page);
    if (!inv) continue;
    for (const url of group.urls) {
      if (targets.length >= PROBE_MAX_URLS) break;
      targets.push({ url, inv });
    }
    if (targets.length >= PROBE_MAX_URLS) break;
  }
  if (targets.length === 0) {
    return { result: 'inconclusive', message: 'no url/inventory available to probe' };
  }

  let attemptedAnyTarget = false;
  for (const { url, inv } of targets) {
    if (attemptedAnyTarget) await deps.interUrlPause?.();
    attemptedAnyTarget = true;
    let page: PageHandle | undefined;
    try {
      page = await handle.newPage();
      ctx.beat();
      await page.goto(url, { timeoutMs: DEFAULT_GOTO_TIMEOUT_MS });
      const cards = await harvestCards(page, inv, ctx);
      const { pass } = gateCards(cards, deps.filterCfg);
      const card = pass[0];
      // Barren url — not evidence of anything, so try the next one rather
      // than concluding. The `finally` below still closes this page.
      if (!card) continue;

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
      // A real failure (navigation, harvest, schema) IS conclusive enough
      // to stop here: unlike a barren url it is a malfunction, and the
      // half-open block keeps the breaker open on it.
      return {
        result: 'inconclusive',
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (page) await page.close();
    }
  }

  return {
    result: 'no-candidate',
    message: `no gate-passing card on the first ${targets.length} url(s) tried`,
  };
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

  if (probe.result === 'no-candidate') {
    // No card to test is the ABSENCE of evidence, not evidence of a
    // block — the same posture breaker_store takes for unreadable state
    // (D12): degrade to closed and let the next fire re-detect. Holding
    // shut here is strictly worse, because closeBreaker is reachable only
    // via an 'ok' probe: a profile whose probed urls are reliably barren
    // would never open again (2026-07-28, harish). Deliberately no
    // UrlStat push here — the probe attempted no card, and a zero/zero
    // stat would dilute the all-urls-failed denominator; `lane.ts` marks
    // the fire as started for pacing purposes regardless of this branch.
    closeBreaker(userDataDir, deps);
    ctx.logger.warn(
      'linkedin lane: half-open probe found no card to test — failing the breaker OPEN and farming normally',
      { message: probe.message },
    );
    return {};
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
