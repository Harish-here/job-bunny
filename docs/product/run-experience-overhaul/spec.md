# Spec — Run Experience Overhaul

Slug: `run-experience-overhaul`
Status: ready for UX
Author: product-pm · 2026-08-10
Persona: `/Users/harishamutha/Job-bunny/docs/product/personas.md`
Scope: the board SPA (`ui/`) at `127.0.0.1:1994`, plus the backend work that serves it.

> **For the UX designer reading this cold:** Job Bunny is a personal, single-user job-search
> pipeline that runs on the user's own laptop. It scrapes job postings, filters and ranks them
> against a resume, and puts the survivors on a local web board. A "run" is one pass of a frozen
> 10-stage pipeline. There is one user, no login, no team, no network exposure. The user is also
> the developer of the tool.

---

## Problem & Goal

**The ask** was "overhaul the run functionality since current one is not intuitive and so
primitive." Treated as a solution hypothesis, not the problem. Five whys:

1. Why does the run functionality feel primitive? → Because firing a run tells you almost nothing
   while it runs and very little after.
2. Why does that matter? → Because you cannot tell a healthy run that found nothing from a broken
   run that found nothing. Both render identically: a green-ish row with a duration.
3. Why does that matter? → Because a break is discovered late, if at all, and only by noticing an
   absence — no new jobs — which is indistinguishable from a slow week in the job market.
4. Why does *that* matter? → Because the pipeline is the only lead source. Every silent broken day
   is a day of job-search leads lost, permanently, with no backfill.
5. Root: **the board reports the pipeline's mechanics (status, duration, stage names) but never its
   outcome (did anything useful reach my board, and if not, why).** The user is left doing the
   interpretation the software should do — in a terminal, in logs, or via a purpose-built AI agent.

**Goal (outcome, not output):** the user can answer "did this run do anything useful, and if not
what do I do" from the board alone, in seconds, without opening a terminal.

The functionality is not actually the problem. The trigger works, the daemon works, the pipeline
works. **Legibility** is the problem. That reshape drives the whole spec.

---

## Persona & JTBD

Full persona: `docs/product/personas.md` — **P1, "The Operator-Owner."** Sole user and sole
developer. Wears two hats: the **job-seeker hat** (wants leads, has zero patience for internals)
and the **operator hat** (worn only under duress, when something looks wrong, always as an
interruption to something else).

Two facts about this persona bound every decision below:

- **Runs are mostly met after the fact.** The daemon runs on a schedule; the user is usually not
  watching. The live view matters only in the minutes after they deliberately clicked Run Now.
  (Confirmed, Q1.)
- **Capability is not willingness.** They can read the code and the logs — that is exactly why the
  current UI has gotten away with being thin, and exactly why it is expensive. Every log dig is
  time not spent applying to jobs.

**Canonical job statement (JTBD):**

> When a run has finished while I wasn't watching, I want to know whether it put anything worth my
> attention on my board — and if it didn't, what broke and what I should do — so that I can spend
> my evening on job leads instead of on my own machinery.

Supporting jobs: **JTBD-2** (in-flight) is it actually progressing and should I wait; **JTBD-3**
(failure) what broke and what do I do, without a terminal.

**Evidence this is a real job, not a stated preference:** the repo ships a dedicated `triager`
agent (`.claude/agents/triager.md`) whose entire purpose is diagnosing failed or degraded runs
from run artifacts and recommending a remedy. The user built an AI agent to answer a question the
UI already holds the data to answer. A workaround that costly is the strongest available evidence
that the gap is real.

---

## Industry Research

One pass, covering product and interaction patterns together. **This is the pipeline's only
research pass — product-ux reuses this section rather than commissioning a second.**

Verified sources:
- GitHub Actions visualization graph — https://docs.github.com/actions/managing-workflow-runs/using-the-visualization-graph
- Apache Airflow UI — https://airflow.apache.org/docs/apache-airflow/stable/ui.html
- freeCodeCamp, debugging CI/CD pipelines — https://www.freecodecamp.org/news/how-to-debug-cicd-pipelines-handbook/

**Table stakes** (absence reads as a defect, not a missing nice-to-have):

| Pattern | Source |
|---|---|
| Status icon + colour leading every run row; pass/fail answerable without clicking | GH Actions, Airflow |
| Multi-stage runs show execution order *and* per-stage timing | GH Actions viz graph |
| Hierarchical drill-down: run summary consolidates outcomes **before** logs | GH Actions |
| Error summary / log preview shown before the full log; full log on click | Airflow task instance view |
| Liveness on long jobs: elapsed clock plus output with backscroll, so "stalled" is distinguishable from "catching up" | GH Actions live tail |
| Chronological lifecycle timeline (start / complete / error / retry), filterable — not a raw dump | freeCodeCamp |
| Hover reveals the error summary; click opens the log | Airflow |

**Differentiators worth borrowing:** Airflow's grid view (rows = stages, columns = runs, colour-
coded cells) is the densest known way to answer "what failed" and "is this a trend" in one glance;
per-stage duration encoded visually to spot the slow stage; exemplar links from a summary element
to the exact evidence behind it.

**Marked as INFERENCE, not sourced** — no source addresses these, and they are the two most
load-bearing patterns for this product. Flagged again in the scorecard:
- Giving "ran fine, found nothing" a **visually distinct state** from "broke silently." No
  CI/orchestration tool needs this, because in CI a zero-output job is a bug. For a scraper it is
  routine — and telling the two apart is this spec's central problem.
- **Per-stage** stall thresholds calibrated to each stage's own historical baseline. A uniform
  timeout is wrong when stage durations differ by an order of magnitude, as they do here.

**Anti-patterns explicitly rejected for a single-user local tool:** metrics theater (CPU/memory
charts that never explain a failure); auth/RBAC/audit surface; over-dashboarding where KPI cards
crowd out single-run debugging; log-first instead of summary-first; rendering "zero results"
identically to "connection error."

---

## Classification

**Change to existing.** Evidence, not assumption: `ui/src/features/runcontrol/` already implements
a seven-state machine (`runState.ts:32-83`) and `ui/src/features/runs/` already renders a stage
funnel table (`RunDetailView.tsx`). This is a redesign of working surfaces, not a greenfield build.

Consequently **the stack question does not arise** — it is settled and inherited: React 19, Vite 8,
Tailwind v4, shadcn/Radix primitives in `ui/src/components/ui/`, TanStack React Query v5, custom
hash router (`ui/src/lib/router.ts`, no router library), `sonner` for toasts, lucide icons.
Vitest + Playwright. UX and UI stages should design to these primitives.

---

## Current State

### What exists today

**Trigger** — `ui/src/features/runcontrol/`. A sidebar Run Now button with seven derived states:
idle, queued ("Queued (waiting for daemon)" + Cancel), expired ("Daemon isn't running" + Queue
again), running ("Running — `<stage>` N/10", disabled), conflict ("Run in progress — view it"),
failed, done ("Done: N new"). Errors render as a red line under the secondary action.

**Live run** — `ui/src/features/runs/LiveRunHeader.tsx`. Shows "Running — `<stage>` index/total", a
progress bar at index/total, elapsed time, and a heartbeat line ("Alive" / "No heartbeat for over
10 minutes" / "No heartbeat yet"). Polls every 2500ms.

**History** — `RunsList.tsx` shows four columns: timestamp, status badge, kind, duration.
**Nothing about what the run produced.**

**Detail** — `RunDetailView.tsx`: header (timestamp, status, kind, duration, resumed-from); a
single red failure line "Failed at stage: `<name>` — `<error>`"; a funnel table (Stage | Jobs in→out
| Drops by rule); and a flat event list with full ISO timestamps and a level filter.

**Backend read surface** — `GET /runs` (paged, max 100), `GET /runs/:id` (includes an opaque
`result` blob and `failure` blob), `GET /runs/:id/events` (paged, max 500), `GET /run-intents`
(hard cap 20). `POST /run-intents` returns 201 new / 200 deduped / 409 `run_in_progress`.
`DELETE /run-intents/:id` cancels a pending intent.

**Trigger path.** The board never spawns runs. It inserts a `run_intents` row; the daemon (sole
spawner, one-Chrome invariant) claims it on a ≤30s tick and awaits the child process. A partial
unique index guarantees at most one pending intent. Latency from click to run start is 0–30s plus
pipeline startup — longer if a prior run is still in flight.

### What the runner actually records — the ceiling on any redesign

This is the most important section for a designer: **you cannot design a display for data that is
not recorded.**

| Recorded | Where | Usable? |
|---|---|---|
| Run status, start/finish, kind, resumed-from, heartbeat | `runs` table columns | Yes, SQL-queryable |
| Per-stage name, elapsedMs, attempts, jobsIn, jobsOut, dropsByRule | **JSON inside `result_json` only** | Parseable, **not** queryable — no per-stage table |
| Failure: stage name, error message, elapsedMs, last checkpoint | `failure_json` | Yes |
| Soft errors (per-URL, per-company failures) | warn-level `run_events` rows with structured `data_json` | Present but **never aggregated** |
| Crash detection | **Derived on read** — a `running` row with heartbeat older than 10 min reads as `crashed` | Yes, but a 10-min lag |
| Mid-stage progress | **Nothing.** `beat()` only resets the stall watchdog; it emits no event | **No** |

### Named current-state defects

These are facts about today, not opinions, and each drives a requirement below.

1. **The live stage indicator is a guess.** "Stage N/10" is derived by regex over log message
   prefixes (`^([a-z]+):`), matched against a frozen stage order, last-match-wins. It is inference
   from log text, not a recorded fact.
2. **A stage is an opaque black box from start to end.** With no mid-stage signal, a ten-minute
   stage is indistinguishable from a hung one except via the 10-minute heartbeat rule.
3. **Daemon-down costs ten minutes of silence.** If the daemon is not running, the intent sits
   `pending` and the UI says nothing until a *derived* 10-minute expiry flips it to "Daemon isn't
   running." This is the single worst latency in the current experience.
4. **Observability can silently vanish.** If the run store fails, it degrades to a no-op store
   (`runId -1`) — the run proceeds and may fully succeed while recording nothing. The UI has no
   way to distinguish "this run did nothing" from "this run's telemetry was never written."
   Checkpoint writes are fail-loud; observability writes are not.
5. **`farm`'s funnel row reports `jobsIn: 0`** because the funnel helper measures before/after and
   `farm` is additive (documented in CLAUDE.md as a known limitation). Cosmetic in today's table;
   it will read as a bug in any redesigned funnel visualization.
6. **Three uncoordinated pollers** run at 2500ms with different activation conditions
   (run control, runs page detail, live header).
7. **No abort path exists from the board once the daemon has claimed an intent.** Cancellation
   works only pre-claim. An in-flight run cannot be stopped from the UI at all. *(Known and
   deliberately deferred — see Out of Scope.)*
8. **`deduped: true`** is returned by the intent POST and never surfaced to the user.

---

## Gaps

Delta between the persona's jobs and the current state.

| # | Gap | Job blocked |
|---|---|---|
| G1 | The run row answers "did it run" but never "did it produce anything." Yield is not shown anywhere in history. | JTBD-1 |
| G2 | A successful-but-empty run and a broken run are visually identical. | JTBD-1, JTBD-3 |
| G3 | In-flight stage position is inferred from log text, not recorded — so it can be wrong, and it cannot be trusted or extended. | JTBD-2 |
| G4 | No stall signal finer than a global 10-minute heartbeat; no sense of "how much longer." | JTBD-2 |
| G5 | Failure is one red line of raw error text. No cause, no remedy, no grouping of the warn events that explain it. | JTBD-3 |
| G6 | Soft errors — the per-URL and per-company failures that explain most degraded runs — exist as scattered, unaggregated warn rows. | JTBD-3 |
| G7 | Daemon-down is invisible for ten minutes. | JTBD-2 |
| G8 | Funnel and drops exist but are buried below the fold in a plain table, and one row (`farm`) is knowingly wrong. | JTBD-1 |
| G9 | The UI cannot tell the user when its own telemetry is missing (no-op store), so it can present an incomplete run as a complete one. | Trust in all three |

---

## Relevance Verdict

### The case against building this — stated first, and it is not weak

- **The pipeline works.** This is polish on a functioning system. Nothing here scrapes one more job
  or ranks one better. Measured in leads, the direct yield of this entire spec is zero.
- **There is exactly one user, and he can read the code.** Every gap above has a working
  workaround: `jobbunny runs`, the log events, the DB itself. The cost of the gap is inconvenience,
  not incapability.
- **The failure question is already answered elsewhere.** The `triager` agent diagnoses degraded
  runs today. Rebuilding a subset of that capability in the UI is arguably duplication, and the UI
  version will be strictly less capable than the agent.
- **There is a bigger fish, and it is a lead-loss fish.** The repo's own memory records an open
  ~67% empty-identity yield loss in the LinkedIn lane. That is leads actually being lost, right
  now, in volume. A spec that makes lost leads *more legible* is worth less than one that stops
  losing them. Opportunity cost here is real and specific, not theoretical.
- **It touches a stability-critical area for a non-functional benefit.** The one instrumentation
  change (R3) reaches into `runner/` and `ports/` — the exact code the repo's stability principle
  says must never be changed casually. Trading pipeline risk for UI comfort is a bad trade if the
  change goes wrong.

### Verdict: **BUILD — reshaped**

Derived from the scorecard at the foot of this document, not asserted ahead of it. The case
against is real and partly survives; it reshapes the work rather than stopping it.

**Reshape:** this is *not* an overhaul of run functionality. The functionality — trigger, daemon,
pipeline — is sound and stays untouched. What ships is **outcome legibility**: making a run's
result and health readable without a terminal. That reframing is what converts "overhaul," an
unbounded epic, into one shippable slice.

**What survives the case against:** the yield-loss argument is a genuine competing priority and
this spec does not claim precedence over it — but the two are complementary, because a silent
break today is discovered by luck. The G2 gap (broken and empty look identical) means the *next*
yield regression will also be found late. Legibility is how you notice the fish.

**What the case against successfully cuts:** it is why full triager-grade classification is out
(duplication), why within-stage instrumentation is out (pipeline risk disproportionate to the
benefit), and why the one pipeline-touching change is scoped to a single additive record.

This is a recommendation. The orchestrator decides whether to proceed.

---

## Resolved Q&A

One interview round; all seven recommended defaults accepted without a flip.

| # | Question | Resolution |
|---|---|---|
| 1 | How does the user meet a run? | Both, weighted to after-the-fact. **History is the primary surface; the live view is secondary.** |
| 2 | The headline number per run | **Jobs that survived the filter and landed on the board.** High-match count as a secondary badge when non-zero. Raw scrape yield explicitly rejected. |
| 3 | Mid-run visibility depth | **Stage-level only, made truthful.** Replace the regex guess with a first-class progress record — designed so within-stage counters can be added later **without another schema change**. Forward-compatibility is a stated design constraint, not a nice-to-have; the user chose the cheaper option on that understanding. |
| 4 | Failure explanation depth | **Raw surfacing + plain-language diagnosis and next action for a closed set of five classes**, falling back to raw for anything unrecognised. |
| 5 | Where it lives | **No new route.** Upgrade the existing runs page; the sidebar button stays as trigger + glanceable status. Live and history are one continuous story. |
| 6a | Stopping a stuck run | **Out** — daemon/process control, not visibility. |
| 6b | Daemon-down latency | **In** — check daemon health immediately instead of waiting out a 10-minute silence. |
| 7 | Slice size | **One slice**, all three pains, at the depth reachable with existing recorded data plus the single Q3 instrumentation addition. |

---

## Tech Story

Written backwards from the completion moment.

> **The completion moment:** the user closes the board without having opened a terminal.

> It's 8pm. Last night's scheduled run finished hours ago. I open the board and the top run row
> tells me, without a click, that it put **7 new jobs** on my board and that **2 are high matches**.
> That's what I came for. I go read them.
>
> The night before, the top row instead said **0 new jobs** — but it said so in the "ran fine,
> found nothing" state, calm and grey, not the alarming one. I trusted it and went to bed.
>
> The night before *that*, the row was red. I opened it and the first thing on the screen was not
> a stack trace: it was one sentence — **"LinkedIn login has expired"** — and one instruction —
> **"open Chrome and sign in, then re-run."** Below it, the failing stage was marked in the pipeline
> and the 14 related warnings were grouped under it, ready if I wanted them. I didn't.
>
> And this morning, when I clicked Run Now myself, I knew within two seconds that **the daemon
> wasn't running** — instead of watching a "Queued" label for ten silent minutes before being told.
> Once it was going, I could see it was on stage 3 of 10, had been there 90 seconds, and was alive.
> I walked away.

Small, testable, and every clause maps to a numbered acceptance criterion below.

**Riskiest assumption, named:** that the five enumerated failure classes cover enough of the real
failure distribution to be worth the build. If real failures are mostly long-tail, R6 degrades to
R7 (raw surfacing) and the spec's headline value collapses to "the same information, better
organised." This is the assumption to validate first — cheaply, by classifying the failure rows
already sitting in the existing runs table before writing any diagnosis code.

---

## Content Priority

A ranking of **what information matters most**, by the moment it is needed. Screen layout, visual
hierarchy, and component choice belong to product-ux — this ranks the content, not the pixels.

**Moment 1 — "I just opened the board" (the dominant case, Q1):**
1. Did the last run put anything on my board? *(yield count)*
2. Is that number trustworthy — did the run succeed, come back legitimately empty, or break?
3. If it broke: what broke, in one sentence.

**Moment 2 — "It broke, I'm now in operator mode":**
4. What do I do about it? *(the next action)*
5. Which stage failed, and where in the 10 is that?
6. What evidence supports the diagnosis? *(grouped warn events, soft-error aggregate)*
7. Where did jobs drop out, and by which rule? *(funnel)*

**Moment 3 — "I just clicked Run Now":**
8. Is it actually going to run? *(daemon health, queue position)*
9. Which stage is it in, and is it alive or stalled?
10. Roughly how much longer?

**Always, quietly:**
11. Can I trust this screen — is the data fresh, and is any of it missing?
12. Is this run normal compared to recent ones? *(trend — lowest priority)*

---

## Requirements

Every requirement carries a source. An unsourced requirement is a defect.
Source keys: **Ask** = the user's ask or an interview answer; **JTBD** = persona job;
**Industry** = research table-stakes; **Recon** = an observed gap or defect in the current code.

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| R1 | Every run row shows, as its headline, the count of jobs that survived the filter onto the board; a secondary high-match badge appears only when non-zero. | Ask (Q2), JTBD-1, G1 | **Must** |
| R2 | Run outcome renders as five visually distinct states: **produced / ran-clean-but-empty / failed / crashed / running**. "Empty" must never look like "broken," and vice versa. | Ask (pain b+c), Industry (inference), G2 | **Must** |
| R3 | The runner records stage progress as a **first-class, additive record** replacing regex-over-log-prefix derivation. The record's shape must accommodate within-stage counters (current/total) later **without a further schema change**. | Ask (Q3), G3 | **Must** |
| R4 | The live view shows current stage, its position in the frozen 10, time in that stage, total elapsed, and an explicit alive/stalled state. | Ask (pain a), JTBD-2, Industry (GH Actions), G4 | **Must** |
| R5 | Daemon health is checked at queue time and surfaced within seconds. A queued intent with no running daemon must never present as normal progress. | Ask (Q6b), G7 | **Must** |
| R6 | A failed or zero-yield run shows a plain-language diagnosis and a recommended next action for this **closed set**: (i) expired LinkedIn login, (ii) throttle circuit-breaker open, (iii) daemon not running, (iv) zero-yield-but-healthy, (v) Chrome not found. Anything unrecognised falls back cleanly to R7. | Ask (Q4), JTBD-3, triager-agent evidence, G5 | **Must** |
| R7 | Raw failure surfacing, summary-first: the failing stage, its error, and the warn-level events attributable to that stage, grouped — full detail on demand, never as the first thing shown. | Ask (Q4a), Industry (Airflow, freeCodeCamp), G5 | **Must** |
| R8 | The funnel is legible at a glance — per stage, jobs in → out, with drops attributed by rule. **`farm`'s known `jobsIn: 0` artifact must be handled explicitly** (rendered as "additive — no input measured", or the row suppressed), never displayed as a literal zero. | Ask (pain c), Recon (CLAUDE.md known limitation), G8 | **Must** |
| R9 | Soft errors are aggregated per run — a count, grouped by lane/company/error class — rather than left as scattered warn rows. | Recon (no aggregation exists), JTBD-3, G6 | **Must** (promoted — see Amendment A1) |
| R10 | When the run store degraded to the no-op store, the UI **must say the run's telemetry is missing** rather than render it as a complete run with no results. | Recon (no-op store, `runId -1`), G9 | Should |
| R11 | Polled data carries a freshness indicator, and poll failure is visibly distinct from "nothing is happening." | Industry (liveness table-stakes), G4 | Should |
| R12 | The three uncoordinated 2500ms pollers are consolidated into one coordinated source of run state. | Recon (three pollers), G3 | Should |
| R13 | Recent-runs trend: yield across the last N runs, viewable at a glance. | Industry (Airflow grid, differentiator) | Could |
| R14 | Per-stage duration encoded visually so the slow stage is identifiable without reading numbers. | Industry (differentiator) | Could |
| R15 | A deduplicated intent (`deduped: true`) tells the user their click landed on an existing queued run rather than silently doing nothing. | Recon (returned, never surfaced) | Could |
| R16 | Abort an in-flight run from the board. | — | **Won't** (this slice) |
| R17 | Within-stage progress counters. | — | **Won't** (this slice; R3 must keep it cheap) |
| R18 | Full triager-grade failure classification. | — | **Won't** |

**The MVP slice is R1–R9** (R9 promoted from Should — see Amendment A1). R10–R12 ship if the slice
lands cheaply; R13–R15 are explicitly deferrable without harming the story.

### Orchestrator amendments — post-spec decisions

Recorded after the UX stage, decided by the user at the UX gate. These override the text above
where they conflict; the PM's original reasoning is left intact rather than rewritten.

| # | Amendment | Rationale |
|---|---|---|
| **A1** | **R9 promoted Should → Must.** The MVP slice is R1–R9. | product-ux found R9 load-bearing for R2: the health gate that *earns* the calm state leans on soft-error aggregation. Without it the gate degrades to `10/10 stages && no failure && no open breaker`, so a run that limped through with 40 per-URL failures still renders calm — a weaker guarantee than the calm copy claims. The alternative (soften the copy) was considered and rejected: the calm state is the mechanism by which a silent break becomes noticeable, which is the spec's root problem. "Ran clean" must be a claim the system can prove. |
| **A2** | **R19 (new, conditional Should): a run's yield links to the jobs it produced.** | Added by product-ux beyond R1–R8 and flagged rather than applied silently. The Tech Story's completion moment is "I go read them," and recon confirmed no such path exists today — a dead end the UX charter forbids. **Conditional on feasibility:** product-ui must verify jobs are attributable to a specific run. If they are not, cut it; nothing else depends on it. |
| **A3** | **R6's five classes span two surfaces, not one.** | Class (iii) daemon-not-running never produces a run row, so it cannot appear in run detail. The five split across the sidebar Run Now block and the detail pane. Not a defect in R6, but a seam an implementer reading it literally will trip over. |

### Backend dependencies — blast radius review required

Per the repo's stability principle, anything touching `pipeline/`, `runner/`, `adapters/`, or
`ports/` is designed deliberately and reviewed for blast radius and failure modes, never shipped
on unit tests alone. This spec creates exactly three such dependencies, and deliberately no more:

| Req | Touches | Blast radius | Failure mode to review |
|---|---|---|---|
| R3 | `runner/`, `ports/run_store.ts`, sqlite migration | **Highest in this spec.** The runner is on every run's hot path. | Must be **additive and non-fatal**: a failed progress write must never fail a run. Note the asymmetry with checkpoints, which are deliberately fail-loud. |
| R5 | daemon health read path (`ops/`, `app/`) | Low — a read-only health probe. | Probe must not perturb the daemon or the one-Chrome invariant; a probe timeout must read as "unknown," not "down." |
| R9 | read-side aggregation over existing `run_events` | Low — pure read, no pipeline change. | Aggregation cost over large event sets; needs a bounded query. |

**The 10-stage pipeline and its order stay frozen.** Nothing in this spec adds, removes, reorders,
or changes the semantics of a stage. product-ui confirms feasibility; these ratings are
provisional.

---

## Acceptance Criteria

Objectively checkable. Each maps to a requirement.

1. The runs list shows, for every completed run, the number of jobs that reached the board from
   that run, without the user opening the run. *(R1)*
2. A run that produced ≥1 high-match job shows a high-match badge; a run with zero high matches
   shows no badge (not a badge reading "0"). *(R1)*
3. Given two runs — one succeeded with 0 jobs, one failed with 0 jobs — a user can tell which is
   which from the list alone, with no click and no reading of numbers. *(R2)*
4. Stage position during a live run is read from a recorded progress value; grepping the UI source
   finds no regex-over-log-message derivation of stage position. *(R3)*
5. The progress record can express "item 42 of 120 within stage X" without a schema migration.
   Demonstrated by a written-down record shape, reviewed, before the slice is called done. *(R3)*
6. A failed progress write does not fail or stall the run. Demonstrated by a fault-injection test,
   not by inspection. *(R3, stability principle)*
7. During a live run the UI shows current stage name, its position in the 10, time in stage, and
   total elapsed, all updating without a manual refresh. *(R4)*
8. A run whose heartbeat has gone stale is shown as stalled, distinctly from running. *(R4)*
9. With the daemon stopped, clicking Run Now surfaces "daemon is not running" in under 5 seconds.
   *(R5)* — today this takes 10 minutes.
10. For each of the five enumerated failure classes, a run in that state displays a one-sentence
    diagnosis and a specific next action. Checkable per class: (i) expired LinkedIn login,
    (ii) throttle breaker open, (iii) daemon not running, (iv) zero-yield-but-healthy,
    (v) Chrome not found. *(R6)*
11. A failure matching none of the five classes displays the raw summary with no invented
    diagnosis, and no error state or blank panel. *(R6 fallback, R7)*
12. On opening a failed run, the failing stage and its error are visible without scrolling; the
    full event log requires an explicit action. *(R7)*
13. The funnel shows each stage's jobs in → out with drops attributed by rule, and the `farm` row
    displays an explanatory label rather than a literal `0` input. *(R8)*
14. A run with soft errors shows an aggregate count grouped by cause, not only individual warn
    rows. *(R9)*
15. A run recorded under the degraded no-op store is labelled as having missing telemetry and is
    never presented as a complete run with zero results. *(R10)*
16. When polling fails, the UI shows a stale/disconnected indicator distinct from an idle state.
    *(R11)*

---

## Success Metrics

Observable outcomes. Deliberately not counts of features shipped or screens built.

1. **Terminal-free resolution.** The user resolves a failed or empty run from the board alone.
   Directly observable proxy: **the `triager` agent stops being invoked for routine run failures.**
   If it is still being invoked after this ships, the spec failed at its central job.
2. **Zero-click daily answer.** "Did last night's run do anything useful?" is answered from the
   runs list with no click. Observable by watching one real usage session.
3. **Break-detection lag.** A silently broken run is noticed within one run cycle instead of being
   discovered later by the absence of leads. Observable: the next real breakage is caught on the
   run that broke, not days later.
4. **Daemon-down latency.** From 10 minutes of silence to under 5 seconds. Directly measurable.
5. **Counter-metric (guards against over-building):** the runs page must not become somewhere the
   user spends *more* time. Time on the runs page should fall for healthy runs — the goal is a
   glance, not engagement. If this feature increases attention on the machinery, it has failed the
   persona even if every criterion above passes.

---

## Out of Scope

| Excluded | Reason |
|---|---|
| The CLI's run UX (`jobbunny run \| stage \| routine \| runs`) | Scope is the board SPA. Settled with the user up front. Backend work serving the UI remains in scope. |
| Telegram notification path | Same — out as a user-facing surface. |
| The scheduling and daemon **trigger model** (tick interval, autostart, queueing policy) | Out as a user-facing surface. Reading daemon *health* (R5) is in; redesigning how runs are triggered is not. |
| **Aborting an in-flight run** | Daemon/process control, not visibility. Deliberately deferred, not overlooked: there is currently **no abort path from the board at all** once the daemon has claimed an intent — cancellation works only pre-claim. A reader should know this gap is known. Strong candidate for the next slice. |
| Within-stage progress counters | Pipeline-risk disproportionate to benefit for this slice. R3 exists to keep this cheap to add later — that forward-compatibility is a hard design constraint, not an aspiration. |
| Full triager-grade failure classification | The `triager` agent already covers it. The UI ships a small closed set (R6); duplicating the agent's full capability is waste. |
| Stage-picking / scope-picking run controls | The user explicitly did **not** select "no control over what runs" as a pain. Letting it in would crowd out the three real pains. |
| Any multi-user concern: auth, permissions, "who triggered this," audit trail, shared dashboards | Single-user local tool on 127.0.0.1. Assuming a second human is waste. |
| System telemetry (CPU, memory, network charts) | Research anti-pattern: metrics theater that never explains a failure. The persona wants pipeline semantics. |
| Changing the 10 stages or their order | Frozen by architectural contract. |

---

## Four-Risks Scorecard

Cagan's four risks. Feasibility is **PROVISIONAL** — product-pm has no engineering tools;
product-ui confirms.

| Risk | Score | Rationale |
|---|---|---|
| **Value** — will they use it? | **Strong** | The strongest evidence in the spec is behavioural, not stated: the user built an entire AI agent (`triager`) to answer the question this UI can't. Three pains were named unprompted. Not top-of-scale only because the direct yield is zero leads — this makes a working system legible, it does not make it more productive. |
| **Usability** — can they figure it out? | **Medium — OPEN, handed to UX** | Deliberately unresolved here. Open concerns for product-ux, not answered by product-pm: (a) how to make "ran clean, found nothing" read as *calm* while "broke" reads as *urgent*, when both are zero — the spec's central visual problem and it has no sourced precedent; (b) how live and history coexist on one route without the live state hijacking the page for the 95% of visits when nothing is running; (c) how a 10-stage progress indicator stays glanceable and doesn't become a decorative widget; (d) whether the funnel reads better as table, bar, or waterfall at this scale (10 stages, one user, no comparison need). |
| **Feasibility** — can we build it? | **Medium — PROVISIONAL** | Most requirements are pure read-side UI over data that already exists. But R3 reaches into `runner/` and `ports/` — precisely where the repo's stability principle says changes are reviewed for blast radius, never shipped on unit tests alone. The forward-compatibility constraint (support within-stage counters later with no second migration) means the record shape must be right the *first* time, which is a design-review dependency, not a coding one. R6's five classes must each be reliably detectable from recorded data — unverified per class, and the likeliest place this spec cracks. |
| **Viability** — does it work for the business? | **Medium-Strong** | No business model, no revenue, no compliance surface; "viability" here means maintenance cost against a strict architecture. Real constraints: the two-pair module rule, 400-line implementation file caps covering `ui/src/`, and a runtime-dependency budget. **R13/R14's visualizations must be built from existing Tailwind + shadcn primitives — adding a charting dependency is a decision, not an implementation detail, and is not pre-approved by this spec.** Not top-scored because every screen added is a screen maintained forever by the one person who also has to keep the scraper working. |

### Named weaknesses — this scorecard is not a clean sweep

1. **The research base is thin, and honestly so.** Only **three verified sources**. Prefect,
   Dagster, and Docker Desktop searches returned overview-level material with no incremental UX
   detail. Worse, the **two most load-bearing patterns for this product** — giving "empty" a
   distinct visual state from "broken," and calibrating stall thresholds per stage — are explicitly
   the researcher's **inference, not sourced**. The spec's central design idea therefore rests on
   reasoning rather than precedent. Since the pipeline runs no second research pass, product-ux
   inherits this thinness and should treat those two patterns as hypotheses to design carefully
   around, not as validated practice.
2. **The riskiest assumption is unvalidated.** Whether the five failure classes cover the real
   distribution is unknown. Cheap validation exists and should happen first: classify the failure
   rows already in the runs table before building R6.
3. **The trust problem is partly unsolved by design.** R10 asks the UI to disclose when its own
   telemetry is missing — but the underlying asymmetry remains: checkpoint writes are fail-loud
   while observability writes degrade silently to a no-op store. This slice makes that failure
   *visible*; it does not fix it. Every trust claim in this spec carries that asterisk, and the
   fix belongs to a backend slice, not this one.
4. **The opportunity-cost argument survives the verdict.** The known ~67% LinkedIn empty-identity
   yield loss costs real leads today, while this spec costs zero and returns legibility. "Build"
   is not a claim that this outranks that.
