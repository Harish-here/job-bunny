# PM dispatch brief — epic `settings-overhaul`

User-approved 2026-08-17 (advisor session). This is the dispatch contract for product-pm, first stage of the product-engineering pipeline (PM → UX → BE → UI → QA). Artifacts live in `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/`.

## Purpose

The board's Settings page is a pre-UI-era handover: its information architecture is the CLI era's config-file layout (one tab per doc: `profile.json`, `filter.json`, `resume.json`, `search_urls.md`), with raw-JSON escape hatches carrying everything the forms don't render and CLI commands printed as hint text. Author the product spec for a full overhaul that reorganizes the settings/control surface around user intents — tune matching, pace scraping, operate the machine, connect integrations, get set up — not around which file the answer lives in.

## Scope (frozen — do not re-slice)

ONE mega-epic covering all four drivers, decomposed by you into buildable phases inside one spec:

1. **Surface missing config** — expose the real knobs that today are JSON-hatch-only (see recon §3: filter companies/timezones, LinkedIn pacing, cleanup TTLs, Notion mirror/dryRun, Telegram digest).
2. **Organization & usability** — the intent-oriented restructure of the page itself.
3. **Ops control center** — live status plus control: daemon/schedule, run cadence, Chrome/login health, breaker state. Read-only visibility vs. actual control is yours to phase; control mechanisms carry a hard constraint (below). Breaker-state constraint: see Hard constraints.
4. **Onboarding/first-run** — the settings/control surface carries new-profile setup (secrets, resume, search URLs) with less dependence on the CLI wizard. WHICH surface (Hub or Settings) hosts this is the open Hub-vs-Settings boundary question below — decided at the mockup gate, not here.

**Override of the product-pm charter's default one-slice-per-spec rule**: this dispatch is a deliberate exception. All four drivers above are Must-level scope for this spec — none may be silently demoted to Should/Could under MoSCoW, and none may be dropped to a later spec. "Phasing" here means sequencing of build work *within* this one spec (build order, dependency order), not scope reduction via MoSCoW triage. The spec must deliver the derived build/reshape/not-needed verdict per driver and a phase decomposition ordered by value and risk, covering all four drivers.

## Closed decisions — do not reopen

- **Mega-epic slicing** (user, 2026-08-17): all four drivers in one spec; phasing happens inside it.
- **Hub-vs-Settings boundary is deliberately open**: the Hub ("Setup & Health": secrets, integrations, doctor) overlaps Settings today. product-ux proposes the boundary; the user rules at the mockup gate. Your job is to frame the question crisply in the spec (state the options and what rides on them) — NOT to answer it.

## Hard constraints (non-negotiable, from CLAUDE.md + architecture)

- **Board invariants**: the board binds `127.0.0.1` only and NEVER spawns runs — it inserts a `run_intents` row; the daemon is the sole spawner (one-Chrome invariant). For the full, authoritative enumeration of the board's write surface (which tables/routes it may touch and how), see `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/recon-settings-surface.md` §"2. Write-surface contract & guardrails" — this brief does not restate it in full. Any spec requirement that implies expanding that write surface must name the expansion explicitly as a design decision.
- **Daemon lifecycle control** (start/stop/autostart from the UI) is architecturally unresolved: the daemon can't poll an intent while stopped. If the spec wants it, state the requirement and defer the mechanism — it is decided at the BE-blueprint gate by the user, not in the spec.
- **Stability principle**: config writes from the UI touch pipeline inputs; blast radius and failure modes are design content, not implementation detail. Nothing here may destabilize the pipeline.
- **Onboarding boundary**: Chrome/LinkedIn login is a parked separate epic (setup-overhaul, scoped `jobbunny login`). The spec treats login as a dependency interface (e.g. "requires a logged-in Chrome profile; status surfaced, remediation handed off"), never as something the board implements.
- **Breaker-state visibility (driver 3)**: the LinkedIn throttle breaker's live/current state is NOT board-visible today — it is session-scoped, in-process, held in lane constants (not read by the recon, which scoped to the settings surface). The board can only infer that a *past* run tripped the breaker, by substring-matching warn text in `run_events` (`src/app/features/runs/soft_errors.ts:42-49`). Treat "breaker state" in driver 3 as this constraint, not as a live-status feed the spec can assume exists.
- Cross-platform (macOS/Windows/Linux); autostart is darwin-only today.

**Recon boundary vs. commissioning further recon**: "do not re-recon" (below, under Inputs) covers only the settings surface already inventoried by `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/recon-settings-surface.md`. For facts *outside* that surface — e.g. breaker internals, daemon lifecycle mechanics, or other lane/pipeline behavior the spec needs to ground a requirement in — you are authorized to commission targeted recon yourself (via your Agent tool) rather than guess or skip the requirement.

## Inputs (read these; do not re-recon the settings surface)

Target repo root: `/Users/harishamutha/Job-bunny`. All paths below are absolute; use your Read tool directly on them.

- `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/recon-settings-surface.md` — verified inventory of current controls, server write contracts, gap list, known friction. Treat as ground truth for "what exists today" **within the boundary the recon itself declares** — see its own "Recon NOTES" section (uncertainty boundary: Settings-section behavior inferred from live code, several call sites not read in full, `BoardSource` implementations not read). Outside that boundary, do not assume the recon is exhaustive.
- `/Users/harishamutha/Job-bunny/docs/product/personas.md` — the app's user persona.
- `/Users/harishamutha/Job-bunny/docs/product/run-experience-overhaul/spec.md` and `/Users/harishamutha/Job-bunny/docs/product/run-experience-overhaul/ux-notes.md` — prior board UX decisions the spec must not contradict (this epic built much of the current board UX).
- `/Users/harishamutha/Job-bunny/docs/product/pipeline-stability-hardening/spec.md` and `/Users/harishamutha/Job-bunny/docs/product/pipeline-stability-hardening/blueprint-be.md` exist as background only — read one if a specific claim in your spec needs grounding there, not by default (you cannot list the directory yourself; these two are the relevant files).
- Repo `/Users/harishamutha/Job-bunny/CLAUDE.md` — board write surface, hard rules, conventions.

## Process

- Interview the user through the orchestrator relay (return your questions; answers come back in a follow-up message). Front-load them: batch your interview into as few rounds as possible.
- Output: `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/spec.md` per your standard structure (your fixed ARTIFACT CONTRACT), plus the per-driver verdicts and phase decomposition — mapped onto that fixed structure as follows: the standard **Relevance Verdict** section carries all four per-driver build/reshape/not-needed sub-verdicts (one per driver, not a single epic-level verdict); add a **Phase Decomposition** section immediately after Requirements, ordered by value and risk, covering all four drivers.

## DONE-WHEN

- `spec.md` exists, covers all four drivers, contains the Phase Decomposition section (ordered by value and risk) placed after Requirements, four per-driver build/reshape/not-needed sub-verdicts inside the Relevance Verdict section, the Hub-boundary question framed (not answered), and every hard constraint above reflected as a spec constraint.
- The user interview (per Process, above) occurred, and the pipeline's `.state.md` exists, per your standing PM charter.
- A NOTES section listing assumptions made, open questions deferred to later stages, and anything in the inputs you found contradictory or stale.
