# UX Notes — Run Experience Overhaul

Slug: `run-experience-overhaul` · Author: product-ux · 2026-08-10
Spec: `/Users/harishamutha/Job-bunny/docs/product/run-experience-overhaul/spec.md` (authoritative)
Persona: `/Users/harishamutha/Job-bunny/docs/product/personas.md` — P1 "The Operator-Owner"
Scope: MVP slice **R1–R8**. R9–R12 designed-and-marked. R13–R15 designed-and-deferred. R16–R18 absent.

---

## 0. Design frame

One route (`#/runs`), two panes, one continuous story. Everything below sits inside the existing
shell: sidebar `w-56` (triage / tracker / **runs** / analytics / setup / settings), Run Now block at
`mt-auto`, profile switcher beneath it. The runs page keeps its master-detail grid —
`minmax(300px,360px) 1fr`, `gap-4 px-4` — because that is the layout the persona already has.

**Visual idiom (recon'd, match it):** bg `#faf8fd`, fg `#3d2c55`, card `#fff`, muted `#f1ecf8`,
primary `#7b5ea7`, success `#4caf6e`, destructive `#d64545`, `--radius: 1rem`, light theme default,
ring-1 `foreground/10` on cards, `text-lg font-semibold` page titles, `text-xs text-muted-foreground`
+ `font-mono` meta, lucide icons at `size-4`. Raw `<table>` + Tailwind, not a Table component.

**The four open usability concerns are resolved in §1 (a), §3 (b), §4 (c), §5 (d).**

---

## 1. The outcome vocabulary — resolving concern (a)

The spec's central problem: "ran clean, found nothing" and "broke" both show zero and today render
identically. The naive fix is grey-dot vs red-dot. **That fails**, twice: it is colour-only (dies on
colour-blindness and on peripheral vision) and both options are still "a coloured dot", so neither
stops the scanning eye.

**The resolution: urgency is encoded as VISUAL WEIGHT, not as hue.** Calm rows carry the fewest
elements on the page — no fill, no border accent, no badge, no tint. Urgent rows are the only rows
with a left border, a tinted background, and a filled icon. Scanning the list peripherally, an
urgent row is the only thing with mass.

**Second half, and the more load-bearing half: calm must positively assert health, not merely lack
an error.** A silent grey zero *is* today's bug. Every calm-empty row carries one muted sentence —
"Ran clean · 10/10 stages · 214 scraped, 0 passed filter" — that says the machine worked *and* the
filter did its job. If the weight hypothesis fails (it is unsourced, see §11), the language still
carries the distinction alone. That redundancy is deliberate, not belt-and-braces.

| Outcome | Icon (shape, never colour alone) | Weight treatment | Number slot | Label |
|---|---|---|---|---|
| **produced** | `check-circle`, filled, success | none — plain card | `7` `text-2xl font-heading` | "New jobs on your board" |
| **ran clean, empty** | `circle`, hollow 1.5px ring, muted-fg | **none — the lightest row on the page** | `0` same size, **full-contrast fg** | "Ran clean" + health sentence |
| **degraded** (modifier on passed) | `alert-circle`, hollow, amber `#c98a2e` | 2px left border amber, no tint | `0`–`n` | "Ran with warnings" |
| **failed** | `alert-triangle`, filled, destructive | 3px left border + `destructive/8` tint | `—` | "Failed at `structure`" |
| **crashed** | `plug-zap-off`, filled, destructive | 3px **dashed** left border + tint | `—` | "Lost contact" |
| **running** | pulsing dot, primary | 2px left border primary + `primary/5` tint | live stage count | "Running — `structure` 5/10" |
| **unrecorded** (R10) | `database-off`, muted | **dashed outline card**, no fill | `—` never `0` | "Telemetry missing" |

**Contrast rule, non-negotiable:** calm = *fewer elements*, never *fainter text*. The `0` stays at
full foreground weight and the health sentence stays at a 4.5:1-compliant muted token. The easy
mistake here is to express calm by fading text, which is an accessibility failure dressed as design.

**"Calm is earned, not defaulted."** A zero-yield run renders calm only if it passes a health gate:
all 10 stages completed **and** no failure record **and** no open throttle breaker **and** soft-error
rate below threshold. Fail the gate → the **degraded** treatment, not the calm one. This is a
derivation, not an addition: R6 enumerates "zero-yield-**but-healthy**" as a class, which only means
something if an unhealthy zero renders differently. See §11 for its dependency on R9.

---

## 2. Screen inventory

| # | Screen | Purpose |
|---|---|---|
| S1 | Runs page — history default (nothing running) | The 95% visit |
| S2 | Runs page — live run in flight | The 5% visit |
| S3 | Run detail — produced | JTBD-1 satisfied |
| S4 | Run detail — ran clean, empty | The central problem |
| S5 | Run detail — failed, diagnosed | JTBD-3, R6 |
| S6 | Run detail — failed, undiagnosed (raw fallback) | R6 fallback / R7 |
| S7 | Run detail — telemetry missing | R10 |
| S8 | Sidebar Run Now block — 6 states | Trigger + zero-click status, R5 |
| S9 | State matrix — loading / empty / error / disconnected | Five-states coverage |

---

## 3. S1 & S2 — page composition, resolving concern (b)

Top to bottom: **page header** (h-12, `px-4 py-3`; left `Runs` `text-lg font-semibold font-heading`;
right the freshness chip) → **live strip, conditional** → **two-pane grid**.

**When nothing is running the page contains zero pixels of live chrome.** No "no run in progress"
placeholder, no disabled progress bar, no empty live card. Occam's razor: an element that only ever
says "nothing" does not justify its space. The Run Now block in the sidebar is the affordance, and
it is already on screen.

**When a run is live**, a single strip appears between header and panes — `mx-4 mb-3 p-3`, `ring-1
ring-primary/25`, `bg-primary/5`, `rounded-lg`, height ~64px. Contents, left to right: pulsing dot ·
`Running — structure` `text-sm font-medium` · the 10-pip rail · `in stage 1m 42s` · `elapsed 6m 03s`
· alive/stalled chip · `[View]`. It is a strip, not a hero — one row tall, never more.

**The live run never steals the detail pane.** The list auto-selects the newest run on load (existing
behaviour), so a user who opens the board mid-run lands on the live run naturally. But if they are
deliberately reading an older run when a run starts, the strip appears and *offers* `[View]`. The
pane is not hijacked. User control over context awareness.

**Live list row.** The top card renders in the `running` treatment with the live stage count in the
number slot. Live and history are literally the same list — that is what "one continuous story"
means structurally, not just narratively.

---

## 4. The stage rail — resolving concern (c)

Ten segments in one row, each `h-1.5 rounded-full`, `flex-1`, `gap-1`. Grouped **3 / 3 / 4** with a
`gap-3` between groups (Miller): *acquire* (reconcile · farm · source), *understand* (compress ·
structure · assemble), *decide* (filter · dedup · rank · sync). Group labels render in the detail
view only (`text-[10px] uppercase tracking-wide text-muted-foreground`), never in the strip.

Segment states: **done** = filled `muted-foreground/40` (quiet); **current** = filled primary +
`animate-pulse`; **pending** = `bg-muted` outline; **failed** = filled destructive; **skipped** =
`bg-muted` with a diagonal-stripe overlay (the LinkedIn breaker skips lanes — a real state).

**The rule that stops it becoming decoration:** exactly one segment is visually distinct at a time
(Von Restorff) — the current one live, the failed one post-mortem — and **the rail always ships with
a text partner** (`stage 5 of 10 — structure`). Test applied: delete the rail and the sentence still
answers the question. It earns its place by adding *scan speed*, not by being the only carrier. A
rail that were the only carrier would be a widget; this one is an accelerator.

R14 upgrade path with no layout change: swap `flex-1` for `flex-grow: <elapsedMs>` and segment widths
become proportional to stage duration. Deferred, but the markup does not change.

**A11y:** in the detail view the rail is an `<ol>` of `<button>`s, each labelled
"stage 5 of 10, structure, failed, 2m 14s", `aria-current="step"` on the current one; clicking scrolls
to and highlights that stage's funnel row. In the live strip it is `role="img"` with a single
`aria-label` and is not focusable — nothing there is actionable.

---

## 5. The funnel — resolving concern (d)

**Verdict: a table with an inline retention bar. Not a waterfall, not a chart.**
Ten fixed rows, one user, no comparison need. A table wins on precision, on screen-reader
accessibility, and on the Viability constraint (no charting dependency is pre-approved). What a table
lacks is "which stage ate the most", so each row's out-cell carries a proportional bar behind the
number — a background width from Tailwind alone, zero new deps.

Columns: `Stage` · `in → out` · retention bar · `Drops by rule`. Read left to right.
Header `border-b text-xs`, `th py-1 pr-2 font-medium`, `td py-1.5 pr-2` — the existing table idiom.

**`farm`'s `jobsIn: 0` (R8, mandatory explicit handling).** The farm row renders its in-cell as
`—` with a superscript `info` marker, its retention bar as an **outward** left-anchored primary-tinted
bar (growth, not shrink), and the marker's popover reads: *"farm is additive — it discovers companies
and adds jobs, so there is no input to measure."* A literal `0` is never rendered. The funnel's
retention summary line excludes farm from its arithmetic.

**Generalised rule:** any stage whose in/out is not meaningful renders `n/a` plus a one-word reason,
never `0`. Assumption flagged in NOTES for product-ui to verify per stage.

---

## 6. Run detail — panel order and the diagnosis panel

Fixed order, identical for every outcome (memorability beats local optimisation):

1. **Outcome header** — the yield sentence at `text-2xl`, high-match badge when non-zero, `[View
   them →]` link, and a right-aligned meta cluster (status chip · duration · kind · started-at
   `font-mono`).
2. **Diagnosis panel** — present for failed / crashed / degraded / empty; absent for a clean produced
   run. Never rendered empty.
3. **Pipeline rail** — §4, with group labels and per-stage durations.
4. **Funnel** — §5.
5. **Evidence** — soft-error aggregate (R9) + `[Show full log (247 events)]` disclosure (R7).

Content Priority ranks evidence (#6) above the funnel (#7), which would argue for swapping 4 and 5.
Resolved differently: the *summary* of the evidence — the top three grouped warning causes — is
lifted **into the diagnosis panel at position 2**, so priority #6 is answered high on the page, while
the *full log* stays last because it is the deepest drill-down. Fixed order preserved, priority
honoured. (Callout C9.)

**Diagnosis panel anatomy.** 32px tinted circle icon, then:
line 1 `text-base font-medium` = the one-sentence diagnosis; line 2 `text-sm text-muted-foreground` =
the evidence clause; then an action row. **Exactly one primary action** (Hick's) plus at most one
quiet secondary. Never a menu of remedies.

| Class | Diagnosis (line 1) | Evidence (line 2) | Primary action | Secondary |
|---|---|---|---|---|
| i · expired login | "LinkedIn login has expired." | "All 6 saved-search URLs returned empty job shells at `source`." | `[Run again]` | "Show the 6 failed URLs" |
| ii · breaker open | "LinkedIn is soft-blocking us — the throttle breaker is open." | "12 consecutive withheld JD shells. Reopens ~21:40." | `[Run again]` **disabled**, with a `Retry in 34m` countdown chip | "What is the breaker?" |
| iii · daemon down | "The daemon isn't running, so your queued run won't start." | "No daemon process responded to the health probe." | `[Copy: jobbunny serve start]` | `[Keep queued]` / `[Cancel]` |
| iv · zero-yield healthy | "Ran clean — 214 jobs scraped, none passed your filter." | "Biggest drop: `filter` — 189 by `locations`." | **none** — a quiet link "Review filter rules →" | — |
| v · Chrome not found | "Chrome wasn't found at any known path." | "Tried 4 candidate paths for darwin." | `[Copy: jobbunny doctor --profile harish]` | "Show the paths tried" |
| **fallback** | *no invented diagnosis* — `Failed at \`structure\`` | raw error in a 2-line-clamped `<pre>`, expandable; last checkpoint shown | `[Run again]` | `[Show full log]` |

Class (iii) has **no run row** — a daemon-down intent never becomes a run. It therefore surfaces in
the sidebar block (S8) and the live strip, not in run detail. Two of the five classes live on two
different surfaces; that seam is real and is flagged in NOTES.

Class (iv) is the only panel with no button, deliberately. An alarming affordance on a healthy run
would re-create exactly the problem this spec exists to fix.

---

## 7. S7 — telemetry missing (R10)

Card renders with a **dashed** outline, `database-off` icon, number slot `—` (never `0`), label
"Telemetry missing". Detail pane shows a single panel and nothing else — no rail, no funnel, no
events, because rendering empty versions of those would itself be the lie R10 forbids:

> "This run's telemetry was never written. The run itself may have succeeded — the board cannot tell.
> Check `jobbunny runs --profile harish` or the daemon log."

This is the one place the design sends the user to a terminal. It is honest: the board genuinely does
not hold the answer, and pretending otherwise is worse than admitting it. (Callout C12.)

---

## 8. S8 — the sidebar Run Now block (R5, R15)

The block is **trigger + persistent last-run status**, not a button alone. Second line, always
present: outcome dot · `7 new` · `2h ago`, clickable → runs page with that run selected.

That line is what makes JTBD-1 a **zero-click** answer from whatever route the user landed on
(default landing is `triage`, not `runs`). Success Metric #2 requires the daily answer with no click;
without this line it costs one. Today's block shows the outcome only inside a 10-minute window —
extending it to persistent is the single highest-leverage efficiency change in this design.

States: **idle** (button + last-run line) · **queuing** (optimistic, <400ms, "Queuing…") ·
**queued** ("Starts within ~30s" + `[Cancel]`) · **daemon down** (destructive-outline, "Daemon isn't
running", `[Copy: jobbunny serve start]`, `[Keep queued]` / `[Cancel]`) · **daemon unknown** (amber,
"Can't reach the daemon — queued anyway"; a probe timeout must read as *unknown*, never *down*) ·
**running** (pulsing dot + `structure 5/10` + `[View]`) · **conflict** ("Run in progress — view it").

R15: a deduped POST fires one `sonner` toast — "Already queued — your click joined the existing
queued run." Marked Could.

---

## 9. Five states, every screen

| Screen | Default | Empty | Loading | Error | Success |
|---|---|---|---|---|---|
| List pane | run cards, newest first | "No runs recorded yet" + inline `[Run now]` (Fitts — put the action where the eye is) | 3 skeleton cards at exact `h-[76px]` card geometry | inline `ErrorRetry`: "Couldn't load runs." + `[Retry]` — not a toast | selected card `bg-accent` + `ring-primary/40` |
| Detail pane | fixed 5-panel order | list-empty → both panes collapse to one centred empty card | header + rail + 5 funnel rows skeleton; **diagnosis panel does not skeleton** | pane-scoped `ErrorRetry`; the list stays usable, so never a dead end | outcome header renders first, panels stream in |
| Live strip | mounts only with data | n/a — absent when nothing runs | no skeleton (mounts only when data exists) | **disconnected** treatment: amber ring, "Disconnected — last update 47s ago", `[Retry]`, dot stops pulsing | `Alive` chip, `aria-live="polite"` on stage change |
| Sidebar block | idle + last-run line | first-ever load: button only, no status line | button `[disabled]` + shimmer on the status line | last-run fetch fail → status line reads "status unavailable", button still works | "Queued", "Running", "Done: 7 new" |
| Event log | collapsed behind a disclosure | "No events at this level." + `[Clear filter]` | 8 skeleton lines inside the open disclosure | "Couldn't load events." + `[Retry]`, disclosure stays open | level filter lives *inside* the disclosure, not outside it |

**Never skeleton a state whose shape implies severity.** The diagnosis panel renders only once data
has arrived — a red-shaped skeleton would flash a false alarm for 300ms, and a false alarm is exactly
the failure mode this feature exists to eliminate. (Callout C13.)

**Stalled ≠ disconnected (R11).** Two states, two sentences, two icons. *Stalled*: we are connected
and the run is not beating — "No heartbeat for 11m" (`activity-off`, amber). *Disconnected*: we
cannot tell — "Disconnected — last update 47s ago" (`wifi-off`, amber, with `[Retry]`). Collapsing
them would let a dead poller masquerade as a dead run.

---

## 10. Efficiency pass — clicks counted, steps killed

| Job | Before | After | How |
|---|---|---|---|
| JTBD-1 "did I get anything" | 1 click (sidebar Runs) + read a duration and infer | **0 clicks** | persistent last-run line in the sidebar block |
| JTBD-3 "what broke, what do I do" | terminal, logs, or invoke `triager` | **1 click, 0 scrolls** | sidebar red → Runs (newest auto-selected) → diagnosis above the fold |
| JTBD-2 "is it alive" | open Runs, read a bar | **0 clicks** | sidebar block shows `structure 5/10` + pulsing dot |
| "see the jobs it produced" | no path existed | **1 click** | `[View them →]` on the outcome header |

**Killed** (Occam's razor, each with a reason):
- The detail pane's manual `Refresh` button → replaced by the freshness chip + refetch-on-window-focus.
  The most common visit is a cold open; a refresh button there is a click charged for nothing.
- The always-visible event **level filter** → moved inside the log disclosure. It is a tool for a
  session already in progress, not a control for the default view.
- The "0 high matches" badge → a badge reading `0` is noise (AC 2 explicitly forbids it).
- The "no run in progress" placeholder → §3.
- Confirmation on `Cancel pending` → the action is trivially reversible (click Run Now again). A
  confirm dialog on a reversible action buys nothing and costs a click.
- The separate "resumed from" line → folded into the meta cluster as a chip.

**Text inputs in this entire design: zero.**

---

## 11. Accessibility

- **Keyboard path:** sidebar nav → Run Now block → list (roving tabindex; ↑/↓ move selection, Enter/
  Space open — the existing idiom, preserved per Jakob) → Tab into the detail pane, whose **first
  focusable is the diagnosis panel's primary action**, because that is the thing an operator came for.
  Disclosures are `<button aria-expanded>`. Rail segments are buttons in an `<ol>`.
- **Focus:** 2px `--ring` outline at 2px offset, `:focus-visible` only, never removed. Opening a
  disclosure moves focus into it; collapsing returns focus to the trigger.
- **Contrast:** §1's rule — calm is fewer elements, not fainter text. Amber `#c98a2e` on `#faf8fd`
  and the muted-foreground token both verified ≥4.5:1 for body text; the amber is used for icons and
  1–2px borders where 3:1 applies.
- **Never colour alone:** every outcome carries icon *shape* + a text label. The list is legible in
  greyscale — that is the acceptance test for §1 and for AC 3.
- **Live regions:** stage changes and the alive→stalled flip announce `aria-live="polite"`; the
  disconnected state announces `assertive` because it invalidates everything else on screen.
- **Reduced motion:** `prefers-reduced-motion` swaps the pulsing dot for a static ring and the
  skeleton shimmer for a flat fill. Nothing conveys state by motion alone.
- **Labelled controls:** every icon-only control (`info` markers, `[Retry]`, rail segments) carries
  an `aria-label`; the funnel table has a `<caption class="sr-only">`.

---

## 12. Numbered callouts (mapped to mockup badges)

| # | Screen | Rationale |
|---|---|---|
| C1 | S1 list | **Urgency = weight, not hue.** Urgent rows are the only rows with a left border and tint; calm rows are the lightest thing on the page. Survives greyscale and peripheral vision. |
| C2 | S1 list | Calm **asserts health** in words ("Ran clean · 10/10 stages"). Redundant with the visual channel by design — §1's hypothesis is unsourced, so language carries it alone if the visual fails. |
| C3 | S1 list | **Von Restorff:** the yield number is the one distinct element on a produced row. On a calm row the one accented element is the health assertion — nothing else competes, because nothing else needs the user. |
| C4 | S1 list | **Jakob's Law:** status-icon-left, newest-top, click-row-for-detail-right is the GH Actions / Airflow model this engineer already runs on. It changed the decision — a card grid would have looked better and read slower. |
| C5 | S2 strip | **Live never hijacks.** Zero live chrome when idle; a one-row strip when live; the detail pane is offered, never stolen. Resolves concern (b). |
| C6 | S2 rail | **10 pips chunked 3/3/4** (Miller) with exactly one distinct segment (Von Restorff) and a mandatory text partner — the test that keeps it an accelerator, not a widget. Resolves concern (c). |
| C7 | S3 header | `[View them →]` closes the loop to the jobs. **UX-added, not in R1–R8** — see NOTES. |
| C8 | S4 panel | The zero-yield-healthy panel has **no button** on purpose. An action affordance here would re-manufacture the alarm this feature exists to remove. |
| C9 | S3–S6 | **Fixed panel order** across all outcomes; Content Priority #6 is satisfied by lifting the *evidence summary* into the diagnosis panel while the *full log* stays last. |
| C10 | S5 panel | **Hick's Law:** exactly one primary action per diagnosis, never a remedy menu. **Fitts's:** it sits adjacent to the sentence that motivates it, top of pane, not in a footer. |
| C11 | S5/S6 funnel | **`farm` renders `—` with an "additive" explanation and an outward bar, never `0`** (R8), and is excluded from retention arithmetic. |
| C12 | S7 | **Telemetry-missing is a first-class screen**, dashed and empty of rail/funnel/events. The one honest terminal hand-off in the design. |
| C13 | S9 | **Never skeleton a severity-shaped state.** A red-shaped placeholder is a 300ms false alarm. |
| C14 | S9 | **Stalled ≠ disconnected** (R11) — connected-but-not-beating vs cannot-tell. Two icons, two sentences. |
| C15 | S8 | **Persistent last-run line** turns the daily question into a zero-click answer from any route. Highest-leverage efficiency change here. |
| C16 | S8 | **Doherty:** the queue state flips optimistically in <400ms, independent of the daemon health probe; the probe result then refines it. A timeout reads "unknown", never "down". |
| C17 | S5 | **Tesler's Law:** "is this zero good or bad" is irreducible complexity — the *system* runs the health gate and states the verdict. The user is never handed a raw count to interpret. That inversion is the whole feature. |

---

## 13. Charter scorecard

| Pillar | Score | Rationale |
|---|---|---|
| **Learnability** | **Strong** | Borrows the CI run-list model the persona uses daily (Jakob). Every state is text-labelled, so nothing must be inferred from colour. Not top-of-scale: the calm/urgent *weight* language is novel and has no sourced precedent — a first-time reader may need one broken run to internalise it. |
| **Efficiency** | **Strong** | Daily answer at 0 clicks, failure diagnosis at 1 click and 0 scrolls, 0 text inputs, six controls killed outright. This is the pillar the design optimises hardest, and the counter-metric (time on page should *fall*) is aligned with it rather than against it. |
| **Memorability** | **Medium** | *Non-top score, named.* The outcome vocabulary is six-wide — produced / empty / degraded / failed / crashed / unrecorded. For a surface visited once a day, that is more distinctions than anyone will hold in memory. Mitigated (never memorised — every state is labelled in words) but not solved: **failed vs crashed** and **empty vs degraded** are genuinely subtle pairs. If real use shows the user cannot articulate the difference, collapse crashed into failed and keep the distinction as a sub-line. |
| **Error prevention** | **Medium-Strong** | Few destructive actions exist to prevent — the only reversible-window action is cancel-pending, and it needs no confirm. Skeletons never imply severity; stalled and disconnected cannot be confused. **But** the design cannot *prevent* this system's worst error, only disclose it: a run whose telemetry vanished (R10) and a health gate that says "ran clean" on a heuristic. |
| **Satisfaction** | **Medium-Strong** | The design's success looks like disengagement — the counter-metric says time on this page should fall. That is correct for the persona and it caps this pillar honestly: a runs page that felt *satisfying to browse* would have failed. What it can deliver is relief (the red row explains itself) and trust (the calm row justifies its calm). Neither is delight, and aiming for delight here would be the wrong instinct. |

### Named weaknesses — this scorecard is not a clean sweep

1. **The central visual hypothesis is unsourced and untested.** §1's weight-not-hue answer is
   reasoning, not precedent — the spec flags this and I am not able to remove the flag. It is
   cheaply falsifiable: one week of real runs, and ask whether a calm zero was ever mistaken for a
   broken one. Design accordingly hedged with redundant language (C2).
2. **The calm state has a scope dependency the MVP slice does not cover.** The health gate that
   *earns* calm leans on soft-error aggregation — **R9, a Should, not a Must.** If R9 slips, the gate
   degrades to `10/10 stages && no failure && no open breaker`, the health sentence drops its
   soft-error clause, and a run that limped through with 40 per-URL failures can still render calm.
   That is a weaker guarantee than §1 implies and it must be stated at build time, not discovered.
   **Recommendation to product-ui: R9 is load-bearing for R2 and should be promoted, or the calm
   copy softened to match what the gate can actually prove.**
3. **Six-state vocabulary risks over-design** — see Memorability. The honest read is that I added
   *degraded* and *unrecorded* to states the spec named five of; both are derivable from the spec,
   but the total is at the edge of what one user will retain.
4. **Two of the five diagnosis classes live on a different surface.** Class (iii), daemon-not-running,
   never produces a run row, so it cannot appear in run detail. The spec presents the five as one set;
   the UI must split them across the sidebar block and the detail pane. Not a defect, but a seam that
   an implementer reading R6 literally will trip over.
