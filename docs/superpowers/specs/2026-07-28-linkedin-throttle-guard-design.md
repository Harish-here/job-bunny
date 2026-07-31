# LinkedIn throttle guard — pacing + circuit breaker

Status: design spec, decisions final. Target branch: `main`. Do not redesign — implement as specified; disagreements go in an implementer's own NOTES, never into the code.

## 1. Problem statement

On 2026-07-28 the LinkedIn farming lane produced a total outage that looked like selector drift but was not.

| Time (local) | Event |
|---|---|
| 09:00 | Fire runs. Farm succeeds. |
| 11:30 | Fire runs. Farm harvests ~1700 cards across 21 URLs; **every one of 11 JD-opens returns empty text**. The outage guard falls back to 10 prior same-day captures, so the run survives farm. |
| 14:00 | Fire runs. Two URLs fail card extraction, the third harvests 72 cards but **every JD-open is empty**. Zero capture ⇒ the total-outage rule throws loud. |

Live inspection of the same session established the mechanism: LinkedIn was **soft-throttling the shared `.chrome-debug` session**, not changing its DOM.

- The JD hydration request (`POST linkedin.com/flagship-web/…`) returned **503** while every other request on the page returned 200.
- `jdRoot` (`[componentkey^="JobDetails_AboutTheJob"]`) was **present in the DOM with `textContent.length === 0`** — a skeleton shell — on both the `/jobs/view/` direct-navigation page and the in-page details pane.
- The **same job rendered its full description immediately to a logged-out guest**, proving LinkedIn itself was healthy.
- Card title/company selectors were re-verified against 50 live cards with a 100% match rate: **the page inventory needs no regeneration.**

Two aggravating factors, both structural:

1. **No backoff.** Nothing in the lane detects a throttle. At 11:30 it attempted 11 JD-opens into an active block; at 14:00 it attempted three more URLs. Pushing into a soft block deepens it.
2. **Misdiagnosis.** The lane's own total-outage message asserts that empty title/company "points at drifted sub-selectors … **NOT a session problem**" — which sent this investigation toward `/page-analyse` when the answer was rate-limiting.

Contributing volume, for context: 21 saved-search URLs × 5 daily fires ≈ **105 saved-search visits per day** from one session, and today three fires landed inside five hours.

**Goal**: make a normal fire slower and less bursty, and make a throttled session a first-class, self-recovering state rather than a mystery outage.

## 2. Goals and non-goals

**Goals**

- Pace a normal fire ~2.5× slower than today, staying well inside the farm stage's existing budget.
- Detect the server-withheld-shell signature and stop the fire rather than grinding through the remaining URLs.
- Persist a cooldown so subsequent fires do not stack into an active block, and recover automatically with a cheap probe.
- Report a throttle honestly, in both the lane's error text and the run's digest.

**Non-goals** (explicitly out of scope)

- **URL rotation.** Visiting a subset of saved searches per fire on rotation was considered and rejected for this spec — it needs rotation state and changes coverage semantics. Revisit only if pacing plus the breaker prove insufficient.
- **Changing the fire schedule.** `schedule.times` stays a user decision in `profile.json`, untouched by this design.
- **A new profile-level configuration *surface*.** See D3 — pacing extends the `settings.linkedin` keys that already exist; the breaker's thresholds stay lane constants. No new settings block is invented.
- **Page-inventory regeneration.** The selectors are correct (§1); this design must not touch `page_inventory/*.json`.
- **Any change to the ATS lanes, `source`, or `sync`.** A skipped LinkedIn lane leaves the rest of the pipeline running normally.
- **Raising `farm.timeoutMs`.** The new pacing must fit the existing 90-minute budget (D2).

## 3. Decision register

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Levers | Slow the cadence **and** add a circuit breaker. Not URL rotation, not schedule changes. | Pacing alone cannot help once a block is active; a breaker alone leaves the burst pattern that likely triggered it. The two are complementary — one lowers the trigger probability, the other bounds the damage. |
| D2 | Cadence | Per-navigation jitter **5–12s** (from 2–5s); new **20–45s** pause between saved-search URLs. Target ≈25 min farm runtime. | Today's fire is ~10 min of a 90-min budget (11% utilized) at ~1 navigation/12s. The moderate tier lands ~25 min — still 3.5× inside the budget, so `farm.timeoutMs` and its `STAGE_BUDGETS` mirror are both untouched. The conservative tier (~50 min) was rejected: a heavy JD-open day could approach the timeout and force changing both. |
| D3 | Config home | **Pacing** values extend the **existing** `settings.linkedin` zod schema in `cli/wire.ts`: raise the two `jitterMinMs`/`jitterMaxMs` defaults and add `interUrlDelayMinMs`/`interUrlDelayMaxMs` alongside them, keeping the lane's constructor-param seam. The **breaker's own thresholds** (consecutive-shells-to-trip, cooldown) stay lane-module constants. **No `behaviors` key.** | Corrects this row's first draft, which assumed no `profile.json` surface existed: `cli/wire.ts` already defines `DEFAULT_JITTER_MIN_MS`/`DEFAULT_JITTER_MAX_MS` and a zod-validated `settings.linkedin` surface exposing `jitterMinMs`/`jitterMaxMs` (`resolveJitterRange`). Deleting a live, validated surface to satisfy a "lane constants only" rule would be a gratuitous breaking change for any `profile.json` already carrying those keys, so pacing extends it instead. The breaker's thresholds do **not** get that treatment: they describe the shared `.chrome-debug` session, not a profile, and per-profile values would let two profiles disagree about how long one blocked session must rest. `behaviors` was rejected because there are two inventories (`jobs-search`, `jobs-search-results`) — pacing would be duplicated and could drift — and because `/page-analyse` rewrites that file. |
| D4 | Detection signal | **`jdRoot` matched but `textContent.trim().length === 0`** — the server-withheld shell. Distinct from `jdRoot` not found, which stays the genuine selector-drift signal. | This is the exact observed signature (§1) and it is what separates a throttle from DOM drift. Conflating the two is precisely the misdiagnosis this spec exists to fix. |
| D5 | Trip threshold | **3 consecutive** shell outcomes. A real-text outcome resets the counter. | One or two empty JDs happen for benign reasons (a pulled posting, a slow pane). Three in a row is the block. Consecutive rather than cumulative so a mostly-healthy fire is never tripped by scattered failures. |
| D6 | Trip action | Stop farming immediately, **keep everything already captured**, write the breaker open. The fire returns normally (it did attempt work). | Discarding a partial harvest punishes the run for a condition it detected correctly. The existing outage-guard and prior-capture rules then apply unchanged to that partial harvest. |
| D7 | Cooldown | **4 hours** from the trip, persisted. | Long enough to outlast a typical soft block and to break the three-fires-in-five-hours stacking pattern; short enough that same-day recovery is still possible. |
| D8 | Recovery | **Half-open probe**: after the cooldown, the next fire tries 1 URL and exactly 1 JD-open. Real text ⇒ close the breaker and **continue that same fire normally**. Shell ⇒ re-open for another cooldown and end the fire. | The classic half-open breaker. Discovering the block is still active costs ~2 requests instead of a fire's worth, and recovery is free — the probe's own capture counts and the fire proceeds. |
| D9 | Open-state behavior | Return a **skipped** result and **do not launch the browser at all**. | A blocked fire should leave zero footprint on the session. LinkedIn is the only browser lane in `farm`, so an open breaker means Chrome is never started. |
| D10 | Skipped ≠ outage | A skipped lane is excluded from the "every attempted lane failed" computation — it attempted nothing. | Without this, a deliberate skip would trip the total-outage rule and throw loud, converting a healthy degradation into a run failure. This is the one place the design touches the `farm` stage. |
| D11 | State home | **`.chrome-debug/.jobbunny-linkedin-breaker.json`**, session-scoped, shared by every profile. | The throttle is a property of that session, and this follows the existing precedent of `.chrome-debug/.jobbunny-chrome.json` (the Chrome pid file). Profile-scoped state would make each profile relearn the same session-wide block. Costs one injected path dep, since the lane's `Storage` is rooted at the profile data dir. |
| D12 | Failure posture | Breaker state never breaks a run: a corrupt/unreadable file is treated as **closed**; a failed write logs a warning and continues. | Fail toward working. The worst case of a lost write is that the next fire re-detects the throttle — the same position as today. |
| D13 | Message fix | The total-outage message stops asserting "NOT a session problem" for empty-shell failures and names the throttle. | The current text actively misdirects (§1). Retires the separately-queued cleanup task. |

## 4. Architecture

### 4.1 Components

| Unit | Responsibility | Depends on |
|---|---|---|
| Pacing (existing `jitter` + new inter-URL pause), in the lane | Spread requests in time | injected `sleepFn` (AbortSignal-aware), `randomFn` |
| Throttle classifier — **pure** | Given per-card JD outcomes, decide "throttled" | nothing (pure function) |
| Breaker store | Persist/read `{ openedAt, tripCount, lastProbeAt }`, decide closed/open/half-open | injectable fs deps + injected `now` |
| `farm` stage (one change) | Treat a skipped lane as not-attempted | the lane's result shape |

Each unit is independently testable: the classifier with plain data, the store with fake fs deps, pacing with a spy `sleepFn`, and the stage change with a fabricated lane result.

### 4.2 Pacing

Existing `cli/wire.ts` defaults change; one pair is added there and threaded into the lane. All keep the constructor-param seam, whose in-lane default stays a no-op `0` so existing tests inject nothing (D3).

| Constant | Today | New |
|---|---|---|
| `DEFAULT_JITTER_MIN_MS` | 2_000 | **5_000** |
| `DEFAULT_JITTER_MAX_MS` | 5_000 | **12_000** |
| `DEFAULT_INTER_URL_DELAY_MIN_MS` | — | **20_000** |
| `DEFAULT_INTER_URL_DELAY_MAX_MS` | — | **45_000** |

Jitter keeps its two existing call sites (after page `goto`, before `openJd`). The inter-URL pause is applied **between** iterations of the per-URL loop — never before the first URL, never after the last, and never when the lane is skipping a URL it has already done.

Expected effect on the observed 11:30 shape (28 page-loads, 21 JD-opens, 21 URLs): ~7 min of jitter + ~11 min of inter-URL pauses + ~7 min of real work ≈ **25 min**, against a 90-min stage timeout.

### 4.3 Throttle classifier

Pure function over the per-card JD outcomes the lane already produces. One outcome is classified as:

- `shell` — `jdRoot` matched, extracted text length 0 (D4)
- `missing` — `jdRoot` not found (selector drift; **not** a throttle signal)
- `ok` — real text

The classifier tracks consecutive `shell` outcomes; `ok` resets the counter to zero, `missing` does **not** count toward a trip. At `THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP = 3` (D5) it reports tripped.

Note that the `shell`-vs-`missing` distinction **does not exist in today's code** and has to be built: `jd_open.ts`'s `buildJdTextScript` returns `''` both when `jdRoot` matched nothing and when it matched an empty element, so the lane currently cannot tell the two apart — a separate in-page presence check is required.

### 4.4 Breaker store

File: `.chrome-debug/.jobbunny-linkedin-breaker.json`

```ts
interface LinkedinBreakerState {
  openedAt: string;    // ISO 8601 — when the breaker was last opened
  tripCount: number;   // cumulative, diagnostic only
  lastProbeAt?: string; // ISO 8601 — when a half-open probe last ran
}
```

State is derived, never stored as a string:

| Condition | State | Fire behavior |
|---|---|---|
| No file (or unreadable/corrupt, D12) | closed | Farm normally |
| `now < openedAt + THROTTLE_COOLDOWN_MS` (4h, D7) | open | Skip; no browser launch (D9) |
| `now >= openedAt + THROTTLE_COOLDOWN_MS` | half-open | Probe (D8) |

Injectable fs deps and an injected `now`, mirroring `ops/scheduling/run_lock.ts` and `ops/daemon/pidfile.ts` — so no test touches a real filesystem or clock.

### 4.5 Data flow: one fire

1. Lane start: read the breaker **before requesting a page**.
2. **Open** ⇒ return a skipped result carrying the reason and the reopen time. Browser never launched. Stop.
3. **Half-open** ⇒ probe: first URL of the first group, harvest, **exactly one** JD-open. Write `lastProbeAt`.
   - Real text ⇒ delete the breaker file (closed) and **continue this same fire normally**, including the probe's capture.
   - `shell` ⇒ rewrite `openedAt = now`, increment `tripCount`, return skipped (reason: probe failed). ~2 requests spent.
4. **Closed** ⇒ farm normally with §4.2 pacing, feeding every JD outcome to the classifier.
5. Classifier trips ⇒ write the breaker open, stop the remaining URLs and pages, keep every capture so far, return a normal (not skipped) result (D6).
6. Captures flow onward; the existing outage-guard and prior-capture rules apply unchanged to whatever was captured.

### 4.6 Skipped is not outage (D10)

The lane's result gains a way to say "skipped, and why". The `farm` stage excludes skipped lanes from its every-attempted-lane-failed computation. With LinkedIn as the only farming lane, a skipped fire means `farm` completes with no LinkedIn jobs and **the pipeline continues** — `source` still fetches the ATS lanes and `sync` still writes.

The reason string reaches the run result and therefore the Telegram digest, e.g. `LinkedIn skipped — throttle cooldown until 18:42`, so a low-yield day explains itself.

## 5. Error handling

| Situation | Behavior |
|---|---|
| Breaker file corrupt/unreadable | Treated as closed; warn logged. Never blocks a run (D12). |
| Breaker write fails (ENOSPC, EACCES) | Warn logged, fire continues. Worst case: the next fire re-detects. Never thrown. |
| Stage deadline expires during a pause | `sleepFn` is bound to `ctx.signal`, so the abort cuts the pause immediately — pacing can never outlive the stage. |
| Probe throws (navigation/harvest error) | Treated as an inconclusive probe: leave the breaker open with `openedAt` unchanged, return skipped. A broken page must not silently close the breaker. |
| `.chrome-debug/` absent | The directory is created on write, same as the Chrome pid file's own path handling. |

## 6. Testing

Hermetic throughout — no real browser, network, filesystem, or clock (repo hard rule).

- **Classifier** (pure, table tests): shell / missing / ok classification; 3 consecutive shells trips; an `ok` between shells resets the counter; `missing` never trips.
- **Store** (fake fs deps + fixed `now`): closed with no file; open inside the window; half-open at and past the boundary; corrupt file ⇒ closed; write failure swallowed.
- **Pacing** (spy `sleepFn`, fixed `randomFn`): the inter-URL pause fires exactly *urls − 1* times and within range; existing zero-injection tests still pass unchanged.
- **Open path**: open breaker ⇒ lane returns skipped, `BrowserProvider` is never called, and `farm` does not throw total-outage.
- **Half-open path**: probe returning real text ⇒ file deleted and the fire proceeds; probe returning a shell ⇒ `openedAt` rewritten and the fire stops after one JD-open.
- **Trip path**: 3 shells mid-fire ⇒ breaker written, remaining URLs not visited, prior captures preserved in the result.

## 7. Risks and accepted trade-offs

| Risk / trade-off | Accepted because |
|---|---|
| Every fire now takes ~25 min instead of ~10, throttled or not. | Still 3.5× inside the farm budget, and slots are 150 min apart. Wall-clock is the cheapest thing this pipeline can spend. |
| A 4-hour cooldown can skip 1–2 slots after a false trip. | Three consecutive shells is a strong signal, and the half-open probe recovers automatically at the next fire past the window — worst case ~4h of LinkedIn freshness on a rare false positive, while the ATS lanes keep running. |
| The breaker cannot distinguish a session-wide block from LinkedIn being globally down. | Both call for the same action (stop, wait, probe), so the distinction has no behavioral consequence. |
| The breaker's thresholds are not runtime-tunable without a code change (D3), even though pacing is. | Deliberate: the alternative homes are each incoherent for a session-scoped property, and nobody has needed to tune a cooldown per profile. Pacing gets the surface only because it already had one. |
| Session-scoped state means one profile's trip pauses LinkedIn for all profiles. | Correct by construction — they share the session that is blocked. Today only one profile is enabled. |
