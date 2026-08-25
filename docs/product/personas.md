# Personas — Job Bunny

Job Bunny is a single-user, local-first tool. There is exactly one persona, and they wear two
hats. Every product decision resolves against this one person.

Status: v1.4, derived 2026-08-10 during the `run-experience-overhaul` spec and confirmed in that
spec's interview round 1; extended 2026-08-13 during the `pipeline-stability-hardening` spec,
which closed the open discovery-channel question; extended again 2026-08-17 during the
`settings-overhaul` spec, which named a **third hat** and added **JTBD-4**; extended again
2026-08-25 during the `ui-design-system` spec, which added **JTBD-5** — the first job that belongs
squarely to the job-seeker hat rather than to the machine. Derived from repo recon + the
orchestrator's grounding, then corrected against the user's own answers. Refine this file on
every product run — it is not frozen.

---

## P1 — "The Operator-Owner"

The sole user and the sole developer of Job Bunny. A working software engineer who is
job-searching and who built their own pipeline rather than trust a job board's feed.

### Context

- Runs the whole thing on their own laptop. No server, no team, no one to escalate to.
  When the pipeline breaks, the person who noticed and the person who must fix it are the
  same person, at the same moment, usually in the middle of something else.
- Has two profiles: `harish` (real data) and `rajni` (committed fixture).
- The pipeline runs on a daemon schedule as well as on demand, so runs happen when the
  user is not watching. **Confirmed:** they meet runs both ways, but weighted toward
  after-the-fact. They watch a run live only in the minutes after deliberately clicking Run
  Now. Any design that assumes an audience is designing for the minority case.
- The stakes are personal, not professional: a run that silently yields nothing is a day of
  job-search leads quietly lost. There is no monitoring, no alerting team, no SLA — only
  whether this one person happened to notice.

### The three hats

*(Named as "two hats" until 2026-08-17; the `settings-overhaul` spec identified a third that the
first two do not cover, because it is the only one worn when nothing is wrong.)*

**Job seeker hat** (the reason the tool exists)
- Wants leads, not telemetry. Opens the board to see what is new and worth applying to.
- Cares about a run only insofar as it answers: *did I get anything today?*
- **Confirmed:** "anything" means **jobs that survived the filter and landed on the board** —
  not raw scrape volume. High-match count is a useful secondary signal. Raw scrape yield was
  explicitly rejected: a run that captured 200 jobs they would never apply to is not a good
  run. Design the headline number accordingly, everywhere.
- Has zero patience for the pipeline's internals when wearing this hat.

**Operator hat** (only worn under duress)
- Put on the moment something looks wrong: no new jobs, a red badge, a run that never
  finished. This is a mode switch, and it is always an interruption.
- Wants the shortest possible path from "something's off" to "here's what broke and what I
  do about it" — and then wants to take the hat off again.
- Is fully capable of reading code and logs. That is exactly why the current UI gets away
  with being thin, and exactly why it is expensive: capability is not the same as
  willingness, and every log dig is time not spent applying to jobs.

**Tuner hat** (added 2026-08-17, `settings-overhaul`)
- Worn **deliberately and calmly**, not under duress — typically right after reading a run's
  results and thinking "that's not quite what I want." Nothing is broken. The user is *aiming*
  the machine, not repairing it.
- This is the only hat that involves sustained **editing** rather than glancing, and the only one
  where the user chose to be there. Designs that assume interruption-mode urgency are wrong here.
- **Capability is not the constraint, and this hat proves it.** The user wrote the config schema.
  He is not lost — he is paying a toll: leave the board, find the file, hand-edit JSON, and trust
  himself not to have broken it. Design for **friction removal**, never for teaching.
- Worn less often than the job-seeker hat, more deliberately than the operator hat.

### Jobs to be done

- **JTBD-1 (primary, job-seeker hat):** When a run finishes, I want to know within seconds
  whether it produced anything worth my attention, so I can spend my time on the leads
  instead of on the machinery.
- **JTBD-2 (operator hat):** When a run is in flight, I want to know it is actually
  progressing and roughly how much longer, so I can decide whether to wait, walk away, or
  intervene.
- **JTBD-3 (operator hat):** When a run fails or comes back empty, I want to know what broke
  and what to do about it without opening a terminal, so a bad run costs me minutes instead
  of an evening.
- **JTBD-4 (tuner hat, added 2026-08-17):** When my board isn't showing what I expect — too
  little, too much, or the wrong things ranked first — I want to find and change the rule or
  limit responsible without opening a file, so I can correct the machine's aim in a few minutes
  rather than losing an evening to it.
- **JTBD-5 (job-seeker hat, added 2026-08-25, `ui-design-system`):** When a run has put new jobs on
  my board, I want to decide apply / lead / pass on each one in seconds — without reading every
  posting in full — so triage costs me minutes rather than an evening, and the good ones don't get
  buried under the mediocre ones.
  - **Why this was missing until now.** JTBD-1 stops one step short: it covers *"did this run produce
    anything worth my attention"* — a question about a **batch**, answered on the runs page in
    seconds. JTBD-5 is what happens next, job by job. The first three epics were all about the
    machine; this is the first job about the **leads**, and it is the one the tool exists for.
  - **Standing design consequence:** triage is the highest-frequency screen for the primary hat.
    Density and ranking beat friendliness there, and anything that costs a second per job costs that
    second on every job in every batch, every day.

### Frustrations (evidenced)

- Fires a run and cannot tell which stage it is in, whether it is stuck, or how long is left.
  (User-stated.)
- When a run fails or yields nothing, cannot tell why or what to do next without digging into
  logs. (User-stated.) **Corroborating evidence:** the repo contains a dedicated `triager`
  agent (`.claude/agents/triager.md`) whose entire purpose is to diagnose failed or degraded
  runs from run artifacts and recommend a remedy. Building an AI agent to answer a question
  the UI already has the data to answer is a workaround, and workarounds are the strongest
  evidence a gap is real.
- Run history and run detail do not answer "did this run do anything useful?"; funnels and
  drops are buried. (User-stated.) The runs list today shows only timestamp, status, kind,
  and duration — nothing about yield.

- **Confirmed 2026-08-17 (`settings-overhaul`, Q1).** Three frictions hit within the preceding
  month, in the user's own selection: (i) **hand-editing raw JSON** because a form lacked the knob;
  (ii) **daemon and login blindness** — wanting to start/stop the daemon from the board, and not
  knowing whether Chrome is still signed into LinkedIn; (iii) **a thin run where a cap or a filter
  rule was suspected** but could not be confirmed. Explicitly **not** selected, and therefore to be
  treated as plausible-but-unevidenced: changing scrape pacing after a soft-block, and setting up a
  new profile.
- **Corroborating evidence for (iii):** the knobs that bound a run's yield (`maxNewPerLane: 40`,
  `maxProbesPerRun: 25`) are live, unsurfaced, and reachable only as raw JSON in a document the
  board never touches. The user suspected a cap and had no way to check — the suspicion was
  well-founded and the surface simply could not answer it.

### What this persona is NOT

- Not a team. No handoffs, no shared dashboards, no "who triggered this", no audit trail,
  no permissions. Anything that assumes a second human is waste.
- Not an SRE. Does not want infrastructure metrics, CPU/memory charts, or an observability
  stack. Wants pipeline semantics, not system telemetry.
- Not a novice. Does not need hand-holding or tutorials; needs density and directness.
  Explanations should be short and technical, not friendly and long.
- Not always at the keyboard. The design cannot assume the run is being watched.

### Resolved about this persona

- **Closed (Q1):** meets runs both live and after the fact, weighted to after the fact. The
  live view is what they check when they *did* just click Run Now.
- **Closed (Q2):** the number that answers "did this run do anything useful" is **jobs that
  survived the filter onto the board**, with high-match count as a secondary signal.
- **Closed 2026-08-13 (`pipeline-stability-hardening`, Q2b): Telegram first.** A failed run is
  discovered via the **Telegram digest**, read on a phone; the board is opened afterwards as the
  diagnostic drill-down surface. This resolves the question v1.1 left open, and it has two
  standing design consequences:
  - **Alert quality is load-bearing, not cosmetic.** The digest is the primary signal, so
    notification correctness (dedup, and never suppressing a *different* failure) is a
    first-class product requirement rather than a nicety. Evidence: the 2026-08-12 incident sent
    six identical failure pages overnight, all of them wrong about the cause.
  - **The board optimises for drill-down from an alert, not for at-a-glance monitoring.** The
    user arrives already knowing something is wrong and wanting to know *what*. Designs that
    assume the board is being watched are designing for the minority case — the same correction
    already recorded above for live run-watching.

- **Closed 2026-08-17 (`settings-overhaul`, Q3): the audience is one person, permanently.** The user
  confirmed this tool is **not** being handed to other people and is not being prepared for
  distribution. Standing design consequence: **onboarding-for-strangers is not a real requirement**
  in this product. Anything justified by "a new user would need this" is justified by nobody. Setup
  surfaces earn their place only as *repair and completeness* aids for the profiles that already
  exist — never as first-run tutorials.

- **Closed 2026-08-25 (`ui-design-system`, Q1): the user reads the board in both colour schemes.**
  The SPA follows the OS setting — `ui/src/main.tsx:8-11` toggles the `.dark` class from
  `matchMedia('(prefers-color-scheme: dark)')`, with no in-app control. Standing design consequence:
  **dark mode is a live user-facing surface, not dead code.** Every design pass must cover it, every
  colour token must exist in both blocks, and contrast must be verified in both. This had gone
  unnoticed through three prior epics, every one of whose mockups is light-only — so the evening
  surface has never been designed against.
- **Closed 2026-08-25 (`ui-design-system`, Q5): the excitement vocabulary is reserved, not drift.**
  `Vera level` / `Kandipa podu` / `Try panalam` (`src/core/tracking/vocab.ts:31`) are deliberate
  product vocabulary in the user's own idiom, and they are byte-exact to Notion. They are recorded in
  the glossary as reserved terms; they are never "normalised" to neutral English.

### Still open (?)

- (?) How much of the job-search happens outside Job Bunny (direct applications, referrals),
  which would bound how much of the user's attention this tool can legitimately claim.
