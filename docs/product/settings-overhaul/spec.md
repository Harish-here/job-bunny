# Spec — Settings & Control Surface Overhaul

Slug: `settings-overhaul`
Status: ready for UX
Author: product-pm · 2026-08-17
Persona: `/Users/harishamutha/Job-bunny/docs/product/personas.md`
Dispatch brief: `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/pm-brief.md`
Scope: the board SPA (`ui/`) at `127.0.0.1:1994` — its Settings page and its Hub — plus the backend
work that serves them.

> **For the UX designer reading this cold:** Job Bunny is a personal, single-user job-search pipeline
> that runs on the user's own laptop. It scrapes job postings from LinkedIn and a few ATS APIs,
> filters and ranks them against a resume profile, and puts the survivors on a local web board. A
> "run" is one pass of a frozen 10-stage pipeline, fired either by the user or by a background
> daemon on a schedule. There is one user, no login, no team, no network exposure. The user is also
> the developer of the tool. **This spec is about the surface where that user aims the machine** —
> the settings and the operational controls — not about the job board itself.

> **Scope note, deliberate and non-standard.** The product-pm charter says one spec is one shippable
> slice. This dispatch overrides that: four drivers ship as one spec, decomposed into build phases
> rather than sliced into separate specs. See §Phase Decomposition. The override is the brief's, not
> the author's.

---

## 1. Problem & Goal

**The ask** was to reorganize the settings/control surface around user intents — tune matching, pace
scraping, operate the machine, connect integrations, get set up — "not around which file the answer
lives in." Treated as a solution hypothesis, not the problem. Five whys:

1. Why does the Settings page feel wrong? → Because to change one thing, you must first know which
   config file that thing lives in. The tabs are literally named after documents.
2. Why does that matter? → Because a large fraction of the knobs are in no form at all, so changing
   them means editing raw JSON. **Evidenced:** the user did exactly this in the last month (Q1).
3. Why does *that* matter? → Because the knobs that are hardest to reach are the ones that decide
   what reaches the board: the per-lane yield caps, the filter rules, and the entire ranking model.
4. Why does *that* matter? → Because when a run comes back thin, the user cannot tell whether the
   market was quiet, a cap truncated the fetch, or a filter rule ate the results. **Evidenced:** the
   user hit exactly this in the last month and suspected "a cap or a filter rule" without being able
   to confirm which (Q1).
5. **Root:** *the board can tell you what the pipeline did, but not why it was configured to do
   that.* Configuration is the last part of this system still legible only in a text editor — and it
   is precisely the part that determines the outcome the previous epic taught the user to read.

That last sentence is the whole spec. The `run-experience-overhaul` epic made a run's **outcome**
legible. It did not make the outcome's **cause** legible, because the cause is configuration, and
configuration lives in files.

**The sharpest single piece of evidence** that the current information architecture is not merely
untidy but *structurally incapable*: the user intent "where am I willing to work" is split across
two different documents with two different meanings, and no surface connects them.

| Where | Key | What it actually does |
|---|---|---|
| `filter.json` | `timezones` | **Pass/fail.** Drops a remote job outside the acceptable set (`src/core/filter/rules/timezone.ts:13,16,20`). |
| `profile.json` | `settings.rank.location.acceptableTimezones` / `.borderlineTimezones` | **Score.** Adds or withholds ranking points (`src/core/rank/rank.ts:127,129`). |

One intent. Two documents. Different semantics. A file-shaped IA *cannot* express this — not because
it was built carelessly, but because the intent does not correspond to a file. That is the
difference between a taste argument and a structural one, and it is why this epic is worth running.

**Goal (outcome, not output):** the user can go from "my board isn't showing what I expected" to
"here is the rule, cap, or limit responsible — changed" without opening a text editor; and can see
whether the machine that produces those results is actually healthy and running, from the same place.

---

## 2. Persona & JTBD

Full persona: `docs/product/personas.md` — **P1, "The Operator-Owner."** Sole user, sole developer.
Two hats: **job-seeker** (wants leads, zero patience for internals) and **operator** (worn only under
duress, always an interruption).

This spec surfaces a **third hat the persona doc did not previously name**, and it is the one this
epic serves:

**The tuner hat.** Worn deliberately and calmly, not under duress — usually right after reading a
run's results and thinking "that's not quite what I want." Unlike the operator hat, nothing is
broken. The user is aiming the machine, not repairing it. This hat is worn *less* often than the
job-seeker hat and *more* deliberately than the operator hat, and it is the only one that involves
sustained editing rather than glancing.

**Canonical job statement (JTBD-4, new — added to `personas.md` by this run):**

> When my board isn't showing what I expect — too little, too much, or the wrong things ranked
> first — I want to find and change the rule or limit responsible without opening a file, so I can
> correct the machine's aim in a few minutes rather than losing an evening to it.

Supporting jobs already in the persona doc: **JTBD-3** (operator hat — what broke and what do I do,
without a terminal) is directly served by this spec's ops driver, because two of its named blind
spots (is Chrome still logged in; is the throttle breaker open) are *configuration and state*
questions the board cannot currently answer.

**Persona facts that bound every decision below:**

- **Capability is not willingness.** The user wrote this config schema. Every argument about
  "discoverability" is weak here — he knows where everything is. The cost is not confusion, it is
  the friction of leaving the board, finding the file, hand-editing JSON, and trusting himself not
  to have broken the schema. Design for **friction removal**, not for teaching.
- **Not a novice.** Density and directness over hand-holding. No tutorials, no wizards-for-the-sake
  of-wizards, short technical copy.
- **Not a team.** No permissions, no audit trail, no "who changed this."
- **Not always at the keyboard.** Config edits take effect on the *next* run, which may be unattended
  at 07:00. A setting saved wrongly is discovered hours later, by absence. This is why save-time
  validation is a Must and not a nicety.

---

## 3. Industry Research

One pass, covering product and interaction patterns together. **This is the pipeline's only research
pass — product-ux reuses this section rather than commissioning a second.**

### Table stakes (absence reads as a defect)

| Pattern | Source |
|---|---|
| Settings IA must mirror the user's mental model, established empirically (card sort), not the system's storage structure | NN/g — https://www.nngroup.com/topic/information-architecture/ |
| Sidebar navigation, not tabs, once sections are many and hierarchical; nav stays fixed, content scrolls | https://www.alfdesigngroup.com/post/improve-your-sidebar-design-for-web-apps (2026) |
| Progressive disclosure: advanced controls hidden until relevant; a novice tier and an expert tier over the same settings | https://lollypop.design/blog/2025/may/progressive-disclosure/ (2025) |
| Validate on submit, not as-you-type; error summary at the top **and** inline per field | GOV.UK — https://design-system.service.gov.uk/components/error-message |
| **Do not disable the submit button** — users read a disabled control as system status, not as their own error | GOV.UK — https://design-system.service.gov.uk/patterns/forms |
| Secrets are never returned by the API; show *configured / not configured* only | https://docs.apify.com/actors/development/actor-definition/input-schema/secret-input |
| Destructive-action friction should be **proportional to blast radius** — none for reversible, type-to-confirm for permanent | https://www.saasui.design/blog/saas-destructive-actions-confirmation-ux-patterns (2026) |
| Scheduler consoles surface *last run* + *next run* + a per-task manual trigger | Sonarr/Radarr System→Tasks — https://wiki.servarr.com/radarr/system |
| Circuit-breaker state shown as Closed / Open / Half-Open **with transition history** — "bouncing" reads differently from "closed for weeks" | https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker · https://grafana.com/grafana/dashboards/21307-circuit-breaker/ |
| Clients should pace themselves *before* the server pushes back; jitter plus backoff is the norm | https://www.zenrows.com/blog/429-too-many-requests |

### Differentiators worth borrowing

- **VS Code's `ui | json` toggle** over one source of truth — a structured settings editor and a raw
  JSON editor as two views of the *same* document, not two competing stores
  (https://code.visualstudio.com/docs/languages/json). This is the exact pattern for R21 and it is
  shipped, mainstream, and validated — not an invention.
- **Grafana's provisioning asymmetry**: once a resource is provisioned from a file, the UI goes
  read-only rather than fighting the file
  (https://grafana.com/docs/grafana/latest/administration/provisioning/). Directly applicable to the
  connector control (R11) — some settings are honest as *displays*, not as *inputs*.
- **Radarr's per-task manual trigger** — a run-now icon at the right of each scheduled-task row. The
  closest published precedent for this spec's schedule/ops surface.
- Settings **search** becomes worth building past roughly 24 settings
  (https://bricxlabs.com/blogs/settings-page-ui-examples). This spec will comfortably exceed that.
- **Reset-to-default** should be visually subdued and should name the exact consequence
  (https://www.designmonks.co/blog/reset-button-ui).
- Material: name it "Settings," prioritise the frequently-used, keep the count manageable
  (https://m1.material.io/patterns/settings.html). Polaris app-settings layout pattern
  (https://polaris-react.shopify.com/patterns/app-settings-layout).

### Marked as transferred, NOT sourced in-domain

Flagged again in the scorecard. The researcher found **no** published design-system guidance for:

- **Rate-limit / pacing controls exposed to end users in a scraper.** The consequence of a bad
  setting here is an account block, not a slow page. All guidance found is engineering-side
  (backoff, jitter), not UI-side. The pacing-preset design (R9) is therefore transferred reasoning.
- **Circuit-breaker state presented to a non-SRE.** The sources are observability dashboards built
  for operators of distributed systems. Our user is one person with one lane.
- **Prosumer personal-automation tools where the user is also the operator.** No usability research
  exists for this population. Every persona-fit judgement in this spec is reasoning from our own
  persona doc, not from literature.

### Anti-patterns explicitly rejected

Preference bloat (surfacing a knob because it exists rather than because it has a job); as-you-type
validation on config fields; disabled save buttons; multi-user surface (permissions, audit); system
telemetry; a settings *wizard* for a user who is already set up; and any pattern that requires the
form and the raw editor to be two separate stores that can disagree.

---

## 4. Classification

**Change to existing.** Evidence, not assumption:

- `ui/src/features/settings/SettingsPage.tsx:12-19` renders six working tabs today; `:84` renders a
  JSON escape hatch for every doc-backed section.
- `ui/src/features/hub/hub.model.ts:41-71` renders six working Hub cards.
- The server write contract exists and is validated: `PUT /api/profiles/:name/config/:doc` →
  `validateConfigDoc`, 422 with a zod message (`src/app/features/config/routes.ts:24-29,104-121`).

**The stack question therefore does not arise** — it is settled and inherited from the
`run-experience-overhaul` epic: React 19, Vite, Tailwind v4, shadcn/Radix primitives in
`ui/src/components/ui/`, TanStack React Query v5, a custom hash router (`ui/src/lib/router.ts`, no
router library), `sonner` toasts, lucide icons; Vitest + Playwright. **No charting dependency is
pre-approved.** UX and UI stages design to these primitives.

---

## 5. Current State

### 5.1 Two surfaces that overlap completely

| Settings tab (`#/settings/:section`) | Hub card (`#/setup`) | Overlap |
|---|---|---|
| Profile — connector, lanes, notifiers, routines | Profile — connector, lanes, notifiers, routines | **Total** |
| Filters — title/locations/skills | Persona & filters — skills, seniority, location | **Total** |
| Search URLs | Search URLs | **Total** |
| Schedule — times, weekdays, grace + daemon status | Schedule & daemon | **Total** |
| — | Integrations — Notion mirror, Telegram tokens | Settings points *here* by copy |
| — | Pipeline health — Chrome, Claude CLI, local DB, doctor | Settings has no link to it |
| Resume · Danger zone | — | Settings-only |

The seam is currently explained by a single line of copy in
`ui/src/features/settings/sections/ProfileSection.tsx:149-152`: *"Notion and Telegram settings are
configured from Setup & Health → Integrations, or through Edit as JSON."*

Hub cards are populated by mapping doctor checks onto cards (`hub.model.ts:85`, `CHECK_TO_CARD`, with
an unmapped check falling back to Pipeline health). **The Hub is therefore not a separate feature —
it is a health-shaped projection of the same settings.** That is what makes the boundary question in
§7.5 the highest-stakes open item in this epic, and it is why it is being escalated to the user
rather than decided here.

### 5.2 What Settings actually writes today

Explicit **Save** button per section — not autosave (`ProfileSection.tsx:153-161`,
`ScheduleSection.tsx:294-302`). There is **no dirty-state guard**: switching section or profile
remounts the form and edits are silently lost.

- Profile → `profile.json` `connector` / `lanes` / `notifiers` / `routines`. The file's own comment
  at `ProfileSection.tsx:17` states `settings` "is deliberately not form-edited here."
- Schedule → `profile.json.schedule` only.
- Filters → `filter.json` `title` / `locations` / `skills` only.
- Resume → 7 keys of `resume.json`.
- Search URLs → `search_urls.md`.
- Danger zone → `DELETE /api/profiles/:name`, type-to-confirm, server-guarded (refuses `rajni`, 409
  on a running run or pending intent).

### 5.3 The real gap inventory — substantially larger than the brief's §3

Everything below is live, runtime-read configuration with **no form anywhere in the board**.

| Area | Where | Notable knobs (defaults) |
|---|---|---|
| **Ranking — the entire model** | `profile.json` → `settings.rank`, parsed at `src/cli/wire/compose.ts:362` | primary/secondary skill points (1.0 / 0.5), skills max 40, domain keywords, title max 15 / neutral 8, seniority targets (max 15), home cities, acceptable & borderline timezones, work-type multipliers, soft-verdict penalty 5 — `src/core/rank/rank.ts:69-171` |
| **Yield caps** | `src/cli/wire/settings.ts` | `maxNewPerLane` 40 (:59), `maxProbesPerRun` 25 (:53), `maxCardsPerUrl` 40 (:66) — `maxAgeDays` 30 (:25) is **not** a yield cap; it gates LinkedIn page-inventory freshness (a doctor-check input) [Amended 2026-08-18 at the BE-blueprint gate, F10 ratified by user — see rulings/be-gate-r1.md] |
| **Registry health** | same | `reprobeNotFoundAfterDays` 30 (:46), `maxProbeFailures` 3 (:47), `staleAfterFetchFailures` 3 (:48) |
| **LinkedIn pacing** | same | jitter 5000–12000ms (:88-89), inter-URL delay 20000–45000ms (:95-96) |
| **Filter blocks** | `filter.json` | `companies` — live, read at `src/core/filter/rules/company.ts:9,11`; `timezones` — live, read at `src/core/filter/rules/timezone.ts:13,16,20` |
| **Cleanup TTLs** | `src/routines/cleanup/cleanup.ts` | passedOlderThanDays 7 (:43), untouchedOlderThanDays 30 (:45), runsOlderThanDays 30 (:49), checkpointsOlderThanDays 2 (:53) |
| **Notion** | `src/adapters/db/notion/connector.ts` | `mirror` false (:33), `dryRun` true (:29) |

**Correction to the brief:** `filter.json`'s `companies` and `timezones` are **not** dead — both are
read at runtime; they are deliberate pass-throughs in the UI model
(`ui/src/features/settings/sections/filters.model.ts:62-64,105-108`). Surfacing them is legitimate.

**Second correction to the brief:** there is **no Telegram digest configuration to surface.** Only
`chatId` is configurable (`src/adapters/notify/telegram/telegram.ts:21`, fail-loud at wire time); the
digest's shape is code, not config. The brief's driver-1 item "Telegram digest" is therefore void as
written and is recorded in Out of Scope rather than becoming a requirement for a control that has
nothing behind it.

### 5.4 Config write semantics — a good property nobody is told about

Writes land in the `config_docs` table, validated strictly (`validateConfigDoc` rejects unknown
top-level keys); reads never re-parse. `wire()` re-reads configuration on every invocation and the
daemon re-checks per 30s tick. **A config change therefore takes effect on the next run, with no
daemon restart and no effect on a run already in flight.** This is a genuinely clean property and the
UI currently says nothing about it.

**The counter-fact, and it is the stability risk of this whole epic:** some invariants are enforced
only at **wire time**, i.e. when the next run starts. `jitterMinMs > jitterMaxMs` is fail-loud at
wire, not at save. A form that permits that combination lets the user save, at 22:00, a configuration
that kills the unattended 07:00 run — and the persona is asleep for the entire gap.

### 5.5 Ops state that exists but is unreachable or unbuilt

- **Daemon status is already good** and is stranded on a config tab. `ScheduleSection.tsx` renders
  six states — loading, API-unreachable, degraded (with `schema vN > daemon build vM` read from
  structured fields, not regex), stopped, stale ("Wedged"), running — each with last-tick seconds,
  plus "Next run (saved)". Remediation is printed as literal CLI text: `jobbunny serve start` (:194)
  and `jobbunny serve stop && jobbunny serve start` (:22).
- **Doctor** runs 13–14 checks — 8 core (`src/ops/doctor/aggregate.ts:316-327`) plus conditional
  adapter checks (`src/cli/wire/builders.ts:349-387`). Result shape `{check, status, detail}`,
  overall = worst finding. **Hub-only; Settings does not link to it.**
- **No LinkedIn-login health check exists.** `cdp-reachable` probes the CDP port — it proves Chrome
  is up, not that the session is signed in. This is the blind spot the user named in Q1.
- **The throttle breaker is persisted to disk**, at `<userDataDir>/.jobbunny-linkedin-breaker.json`
  (`src/adapters/lanes/linkedin/breaker_store.ts:6`), scoped to the shared `.chrome-debug` profile
  and therefore **cross-profile, not per-profile** (:8-10). It trips after **3** consecutive withheld
  JD shells (`throttle.ts:24`) and stays open for **4 hours** (`throttle.ts:29`).
- Past trips are inferable from three exact warn substrings in `run_events`
  (`src/app/features/runs/soft_errors.ts:46-50`).

> **Formal correction to a frozen constraint.** The dispatch brief froze "breaker state is
> session-scoped, in-process, held in lane constants… not a live-status feed the spec can assume
> exists." The evidence above contradicts it — a JSON file at a known path is readable by the board
> process. The orchestrator independently verified `breaker_store.ts` and the user answered Q5 = (a).
> **The brief's breaker constraint is superseded by that answer.** "Chrome-session-scoped" in
> CLAUDE.md means the Chrome profile, not the Node process. Recorded here so no downstream stage
> re-imports the stale constraint from the brief.

---

## 6. Gaps

Delta between the persona's jobs and §5. **P-a / P-b / P-c** mark the three frictions the user
confirmed hitting in the last month (Q1); the rest are recon-derived and honestly weaker.

| # | Gap | Job blocked | Evidence |
|---|---|---|---|
| G1 | Changing a knob that has no form means hand-editing raw JSON. | JTBD-4 | **P-a (user-confirmed)** |
| G2 | When a run is thin, no surface connects the result to the cap or rule that caused it. The yield caps are invisible; the filter rules are on another page with no link. | JTBD-4, JTBD-1 | **P-c (user-confirmed)** |
| G3 | The user cannot tell whether Chrome is still logged into LinkedIn. No check exists at any layer. | JTBD-3 | **P-b (user-confirmed)** |
| G4 | The daemon can only be started or stopped from a terminal; the board prints the command as text. | JTBD-3 | **P-b (user-confirmed)** |
| G5 | The entire ranking model — what orders the board — is editable only as raw JSON in a document the board never touches. | JTBD-4 | Recon §5.3 |
| G6 | One user intent ("where I'll work") spans two documents with different semantics and no surface joins them. | JTBD-4 | Recon §1 table |
| G7 | Sections are named after files. The IA teaches storage layout, not intent. | JTBD-4 | The ask; NN/g |
| G8 | Machine-wide settings (daemon, autostart, secrets, Chrome) sit behind a per-profile switcher, implying a scope they do not have. | JTBD-4 | Recon §5.1 |
| G9 | The live breaker state is readable on disk but surfaced nowhere; a 4-hour lane outage is invisible. | JTBD-3 | Recon §5.5 |
| G10 | A form can save a config that fails at wire time (min > max), breaking the next unattended run hours later. | All | Recon §5.4 |
| G11 | Explicit save with no dirty-state guard: switching section or profile silently discards edits. | JTBD-4 | Recon §5.2 |
| G12 | The connector dropdown flips the source of truth with no confirmation, warning, or consequence copy. | JTBD-4 | `ProfileSection.tsx:86-97` |
| G13 | Doctor results are Hub-only and not reachable from where the user is when something looks wrong. | JTBD-3 | Recon §5.5 |
| G14 | Two surfaces (Hub, Settings) own the same seven topics, reconciled by one line of copy. | JTBD-4 | Recon §5.1 |
| G15 | Nothing tells the user when a saved change takes effect. | JTBD-4 | Recon §5.4 |
| G16 | No path exists to complete or repair a partially-configured profile from the board. | — | Driver 4; **not user-evidenced** |

---

## 7. Relevance Verdict

### 7.1 The case against building this — stated first, and it is the strongest part of this document

- **Zero capability is gained.** Every knob in §5.3 is already editable today, by a user fluent in
  the schema he wrote. This epic buys convenience, not ability. Measured in job leads, its direct
  yield is zero.
- ~~**The discoverability argument is at its weakest with n=1.**~~ **WITHDRAWN 2026-08-17 — tested and
  refuted.** The argument ran: settings IA research is about helping users find things whose location
  they do not know, our user knows every location, and card sorting is unavailable at n=1 with the
  taxonomy's own author as the participant — so IA quality is unfalsifiable before build. It was
  falsifiable, it was tested, and it failed at **1/5** (§9). The author of the schema could not
  reliably say where his own settings live. This bullet is struck rather than deleted so the record
  shows the case against was made in good faith and then beaten by evidence.
- **Driver 4 is unevidenced by the user's own answers.** He has not set up a new profile, and Q3
  confirmed this is not being handed to anyone else. Building onboarding for a population of one
  who is already onboarded is close to definitionally waste.
- **Settings pages are where features accumulate and never leave.** Every knob surfaced is a form,
  a validator, and a test maintained forever by the one person who also has to keep the scraper
  working. The 400-line file cap on `ui/src/` will bind, and the two-pair module rule will force
  structure whether or not the feature warrants it.
- **This spec expands the board's write surface into machine control** (R16/R17) — the exact
  boundary CLAUDE.md separated structurally via `ports/board.ts`. A structural invariant is being
  spent on operator convenience.
- **A UI write is more dangerous than a JSON edit, not less.** A form implies validation that the
  schema may not enforce (G10). Hand-editing JSON at least carries the honest fear of having broken
  something; a Save button carries false confidence. Per the stability principle, a config write
  from the UI touches pipeline inputs.
- **The bigger fish is still swimming.** The repo's memory records an open ~67% LinkedIn
  empty-identity yield loss. That costs real leads today. This epic costs effort and returns
  legibility. The same opportunity-cost argument was conceded in the previous spec and the fish has
  not been caught since.

### 7.2 What survives the case against

Three things, and they are what convert "reorganize the settings page" from taste into necessity:

1. **G6 is structural, not aesthetic.** No amount of tidying a file-shaped IA will let it express an
   intent that spans two files with different semantics. This is the one gap that cannot be argued
   away as preference.
2. **G2 is user-evidenced and it is a lead-loss gap, not a comfort gap.** The user had a thin run and
   could not determine whether a cap truncated it. If `maxNewPerLane: 40` silently capped a good day,
   that is leads lost — the same category as the LinkedIn yield loss, not the same category as UI
   polish. This is the strongest value argument in the spec and it partially answers the
   opportunity-cost objection rather than dodging it.
3. **G3 and G9 are silent-outage gaps.** An expired login or a 4-hour open breaker produces exactly
   the symptom the previous epic taught the board to render calmly: a clean run with nothing in it.
   The prior spec's calm-empty state is only honest if the board can see these two states. Left
   unbuilt, this epic's absence actively degrades the previous epic's central guarantee.

### 7.3 Per-driver verdicts

Derived from §7.1–7.2 and the scorecard in §16, not asserted ahead of them.

| Driver | Verdict | Derivation |
|---|---|---|
| **1 — Surface missing config** | **BUILD, reshaped** | Reshape: *not* "surface everything." The brief's list is both incomplete (it misses the ranking model and the yield caps) and partly void (Telegram digest config does not exist). Build what has an evidenced job: the yield caps and filter rules that explain a thin run (G2/P-c), the retunable ranking lists, `companies`/`timezones`. Point weights stay raw (Q2b). Pacing is included but honestly ranked below these — the user did **not** select pacing-after-soft-block as a real pain. |
| **2 — Organization & usability** | **BUILD** | The only driver with a structural rather than preferential justification (G6). Also the container: every other driver has to put its controls somewhere. Highest confidence of the four. |
| **3 — Ops control center** | **BUILD, reshaped** | Reshape: *status* is largely already built and merely stranded on a config tab (§5.5) — so this is not "build an ops dashboard," it is (i) give the existing status a home, (ii) add the two states that genuinely do not exist anywhere — login health (G3) and live breaker state (G9), (iii) add live-daemon control. Both evidenced by P-b. Full lifecycle control is a stated requirement with a deferred mechanism (§7.4). |
| **4 — Onboarding / first-run** | **RESHAPE** | The weakest driver and the only one whose stated form the evidence contradicts. Per Q1 the user has not set up a new profile; per Q3 this is not for other people. Reshaped from *onboarding a new user* to **setup completeness and repair for existing profiles** — the same surface, aimed at "what is not configured yet, and where do I fix it," which is a live question given 13–14 doctor checks scattered across two pages. Within this driver, **full new-profile creation in the board is NOT NEEDED in this spec** — the CLI wizard works and the demand is absent. |

> **On the Must-level scope override.** The brief forbids demoting any *driver* to Should/Could or
> deferring one to a later spec. Every driver above therefore carries at least one **Must**
> requirement in §11 and appears in the phase decomposition in §12. That is not the same as making
> every *requirement* a Must — within-driver triage (e.g. pacing presets at Should; new-profile
> creation at Won't-this-spec) is ordinary MoSCoW and is not a demotion of the driver. This reading
> is stated explicitly so no downstream stage mistakes it for scope erosion.

### 7.4 Deferred mechanisms — stated as requirements, decided elsewhere

Two requirements deliberately name a *what* without a *how*, per the brief:

- **R17 (daemon lifecycle control from the board).** Architecturally unresolved: a stopped daemon
  cannot poll an intent, so the existing intent mechanism cannot start it. **Decided at the
  BE-blueprint gate by the user, not here.**
- **R12 (rule-change preview).** Requires re-evaluating a stored job set against edited rules
  outside the pipeline. **Feasibility is explicitly flagged for the BE stage** (Q10). If the spike
  fails, R12 is cut and nothing else depends on it.

### 7.5 The Hub-vs-Settings boundary — framed, deliberately NOT answered

Per the brief's closed decision, product-ux proposes and the user rules at the mockup gate. My job is
to make the question crisp and to state what rides on it.

**The question:** given that the Hub and Settings own the same seven topics (§5.1), and that the Hub
is mechanically a *doctor-check projection* of settings (`hub.model.ts:85`), what is the principled
division — or is there one?

**The options, and what each costs:**

| Option | Principle | What rides on it |
|---|---|---|
| **A — Merge.** One surface; the Hub disappears. | There is only one topic set, so there should be one place. | Simplest IA and kills G14 outright. But the Hub's health framing is genuinely useful and would have to survive as a section, and `#/setup` is an existing route with existing e2e coverage. |
| **B — Health vs. configuration.** Hub answers "is it working," Settings answers "what should it do." | Read vs. write. Diagnose vs. tune. | Clean sentence, but it cuts straight through several topics: the schedule is both, secrets are both, the breaker is health but pacing is config. Expect leakage at exactly the seams users care about. |
| **C — Machine vs. profile.** Hub owns machine-wide (daemon, autostart, secrets, Chrome, breaker); Settings owns per-profile (matching, ranking, schedule, search URLs). | Maps onto the Q8 scope split, which is a *real* property of the data, not a judgement call. | Most defensible line because the system already enforces it. But it puts the daemon on a different page from the schedule that drives it, which is where the user's Q1 pain (P-b) actually lives. |
| **D — Task-shaped.** Hub becomes a *completeness checklist* that only ever links into Settings; it owns no controls. | The Hub is a table of contents with a health signal, not a settings page. | Directly implements driver 4's reshape (R19). Cost: the Hub stops being a place you *do* things, which may feel like a demotion of an existing surface. |

**What rides on the answer:** the home for R13–R18 (the entire ops surface), whether R19's checklist
is a Hub page or a Settings section, and whether the route `#/setup` survives at all. **UX should not
treat these as mutually exclusive** — C and D compose (a machine-scoped Hub that is also the
checklist) and that composition is, in my reading, the strongest candidate. I am recording that as an
observation for the UX stage to test, explicitly **not** as a decision.

**Recommendation to the orchestrator:** this verdict is **BUILD** for drivers 1–3 and **RESHAPE** for
driver 4. It is a recommendation, not a decision.

---

## 8. Resolved Q&A

One interview round, eleven questions. Nine defaults accepted, one split by risk (Q6), one delegated
back to me (Q11).

| # | Question | Resolution |
|---|---|---|
| 1 | Which frictions are real in the last month? | **Three confirmed:** raw-JSON editing for a missing knob (P-a); daemon/login blindness — wanting daemon control and not knowing whether Chrome is still logged in (P-b); a thin run where a cap or filter rule was suspected (P-c). **Not selected:** changing pacing after a soft-block; new-profile setup. Treated as plausible-but-unevidenced, which visibly lowers pacing (R9) and driver 4 in the ranking. |
| 2 | Surface the ranking model? | **(b)** — surface the retunable lists (domain keywords, seniority targets, home cities, timezones); point weights stay raw JSON. |
| 3 | Who is onboarding for? | **(c)** — repair/completeness checklist for existing profiles first; full new-profile creation later. **Not (d):** this is not for other people. Claude-dependent steps (Notion adopt-or-create, PDF resume parse) are **never** reimplemented in the board. |
| 4 | Ops control depth? | **(b) plus the rider** — live-daemon control (pause/resume schedule, skip next run) buildable now; full start/stop stated as a **Must** with the mechanism deferred to the BE gate. |
| 5 | Breaker state? | **(a)** — live breaker state spec'd as board-readable (closed / open + reopen time). **No manual reset button.** The brief's contrary constraint is formally superseded. |
| 6 | Risky knobs — how much rope? | **Split by risk.** Pacing → presets (Safe/Normal/Fast) + advanced disclosure with a consequence warning. Budget caps → raw fields with validation bounds. |
| 7 | JSON escape hatch? | **(b)** — one consolidated Advanced / raw-config area; removed from the intent sections. |
| 8 | Machine vs. profile scope? | **(a)** — explicit split in the IA, **without** pre-deciding which page hosts what. The Hub boundary stays open for the mockup gate. |
| 9 | Connector dropdown? | **(b)** — read-only in the UI (switching is a migration, not a setting); expose Notion `mirror` + `dryRun` toggles instead. |
| 10 | Rule-change preview? | **(b)** — cheap static preview re-evaluating the last run's jobs against edited rules; fall back to no preview if infeasible. Feasibility explicitly flagged for the BE stage. |
| 11 | Phase order? | **(d)** — delegated to me. Derived and defended in §12. |

### Post-spec rulings (orchestrator-relayed, 2026-08-17)

| # | Ruling | Effect |
|---|---|---|
| 12 | The §7.3 reading of the brief's Must-level scope override — *each driver carries at least one Must and none is deferred to a later spec*, which is not the same as making every requirement a Must — is **ACCEPTED as stated**. | Within-driver MoSCoW triage (R12 pacing at Should, R28 new-profile creation at Won't) is confirmed as ordinary prioritisation, **not** scope erosion. No downstream stage may re-open it on that basis. |
| 13 | **New-profile creation at Won't (R28) is ACCEPTED.** | Driver 4 ships as setup completeness/repair only (R22–R24). R28 stays out of this spec; it is deferred by decision, not by oversight. |
| 14 | The §9 riskiest-assumption navigation test was **run unprimed and scored 1/5** — see §9. | Driver 2's value stands at full weight on evidence. Phase 1 becomes unconditional and its scope-reduction branch is closed (§12). Scorecard weakness 1 is resolved (§16). |

---

## 9. Tech Story

Written backwards from the completion moment.

> **The completion moment:** the user changes what reaches his board, and closes the laptop without
> having opened a config file or a terminal.

> It's Tuesday evening. Last night's run put four jobs on my board — fewer than usual, and two of
> them are wrong. I open Settings.
>
> It doesn't ask me which file the answer is in. It asks me what I want to change. Under **how jobs
> are matched**, the timezone rule I actually care about is one thing, in one place — even though I
> happen to know it's stored in two documents that mean different things. I add a country to the
> avoid list and drop a seniority target.
>
> Under the same section, it tells me something I'd been guessing at: the run fetched **40 new jobs
> per lane, because that's the cap** — and it says so next to the number, not in a doc. That's the
> answer to last week's thin run. I raise it to 60.
>
> I hit Save. It tells me two things in one line: **this takes effect from your next run**, and
> nothing is running right now. It does not let me save a jitter range where the minimum is above the
> maximum — which is the mistake that would have quietly killed tomorrow's 07:00 run while I slept.
>
> Then I glance at **Operate**. The daemon is running, last tick 12 seconds ago, next run 07:00. And
> there, in one line I've never had before: **LinkedIn session — signed in**, and **throttle breaker
> — closed**. Last week that breaker was open for four hours and I had no idea; the run just came
> back thin and calm and I believed it.
>
> I close the laptop. I never opened a terminal, and I never opened a JSON file.

Small, testable, and every clause maps to a numbered acceptance criterion in §13.

**Riskiest assumption, named:** that an intent-shaped IA measurably reduces friction *for a user who
already knows the file-shaped one perfectly.* This was the assumption the whole epic rested on, and
the hardest to validate — the standard method (card sort) is unavailable at n=1, and the user's
existing expertise is precisely what made the current IA tolerable.

### The assumption was tested. It is REFUTED. (2026-08-17, before the user had read §5)

The five-minute navigation test proposed here was run unprimed: name where you would go to change
each of five live settings. **Score: 1 correct out of 5.**

| Asked | Answer | Truth |
|---|---|---|
| Timezone used for **ranking** | `profile.json` settings | ✅ correct (`settings.rank.location.*Timezones`) |
| Timezone that **hard-drops** a job | not sure | `filter.json` → `timezones` |
| Company I never want to see | **`profile.json` settings** | ❌ **wrong** — `filter.json` → `companies` |
| Per-lane job cap | not sure | `settings.linkedin` / `maxNewPerLane` |
| Cleanup retention window | not sure | `settings.cleanup` |

**Three consequences, and they are the most load-bearing findings in this document:**

1. **Driver 2's value stands at full weight, on evidence rather than on reasoning.** The case
   against it — "n=1, and he wrote the schema, so navigation cannot be the problem" — is now
   falsified by the schema's own author. Authoring a taxonomy is not the same as retaining it.
2. **G6 is confirmed empirically, not just structurally.** The two timezone questions are the two
   halves of the same intent, and the user got **one right and one blank**. He does not hold the
   split in his head — which is precisely what R2 exists to fix, and it is now the single
   best-evidenced requirement in the spec.
3. **The wrong answer is worse than the blanks.** He did not merely fail to recall where the
   company avoid-list lives — he confidently named the wrong document, and that setting is one he
   named among his own evidenced Q1 frictions. A confident wrong answer means an edit attempted in
   the wrong place, which is a *worse* failure mode than hesitation and is invisible until a run
   behaves unexpectedly.

**Phase 1 is therefore unconditional.** The scope-reduction branch this test existed to trigger —
collapse driver 2 to grouping, ship only drivers 1 and 3 — is **closed and must not be revisited by
a later stage.**

**The riskiest assumption is now R15's feasibility** (see §16 weakness 3), which inherits the title.

**Second-riskiest:** that R12's preview is feasible. It is the difference between "the same knobs,
better arranged" and a tool that answers a question. See §16 weakness 3.

---

## 10. Content Priority

A ranking of **what matters most**, at requirement level, by the moment it is needed. Screen layout,
visual hierarchy, and component choice belong to product-ux — this ranks the content, not the pixels.

**Moment 1 — "my board isn't showing what I expected" (the dominant tuner-hat entry point):**
1. Which rules and limits currently decide what reaches the board — matching rules, and the caps.
2. What each one is currently set to, in units I can reason about.
3. What effect a change would have *before* I commit to it. *(R12, conditional)*
4. When a change takes effect, and on what.

**Moment 2 — "is the machine even working" (operator hat, P-b):**
5. Is the daemon running, and when does it next run?
6. Is the LinkedIn session still signed in? *(the state that most silently invalidates everything)*
7. Is the throttle breaker open, and until when?
8. What does doctor say — and only then, the detail.

**Moment 3 — "I want to change how it runs":**
9. Pause / resume the schedule; skip the next run.
10. Start / stop the daemon.
11. Pacing — and the consequence of getting it wrong.

**Moment 4 — "what is not set up yet":**
12. Which parts of this profile are incomplete, and where do I go to complete each.

**Always, quietly:**
13. Which scope am I editing — this machine, or this profile?
14. Is there an unsaved change I am about to lose?
15. The raw config, for anything the forms do not cover. *(deliberately last — an escape hatch that
    is easy to reach is an IA that gave up)*

---

## 11. Requirements

Every requirement carries a source. An unsourced requirement is a defect.
Source keys: **Ask** = the brief's driver or an interview answer · **P-a/b/c** = a
user-confirmed friction from Q1 · **JTBD** = persona job · **Industry** = §3 research ·
**Recon** = an observed fact in the code · **Stability** = CLAUDE.md's stability principle.

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| **Driver 2 — organization (the container)** ||||
| R1 | Settings is organized by **user intent**, not by config document. No section is named after a file. | Ask, G7, Industry (NN/g) | **Must** |
| R2 | A single user intent that spans two config documents is presented as **one thing**. Named acceptance case: timezone preference, which spans `filter.json.timezones` (pass/fail) and `settings.rank.location.*Timezones` (scoring) — both must be reachable and their different meanings made plain. | Recon §1, G6 | **Must** |
| R3 | Every setting states its **scope** — "this machine" or "this profile" — and machine-wide settings are not presented as if the profile switcher governs them. | Q8, G8 | **Must** |
| R4 | One consolidated **Advanced / raw config** area replaces the per-section JSON hatches. Form and raw edit **one source of truth** and cannot disagree. | Q7, G1, Industry (VS Code `ui\|json`) | **Must** |
| R5 | Unsaved edits are not silently discarded when switching section or profile. | Recon §5.2, G11 | **Should** |
| **Driver 1 — surfacing configuration** ||||
| R6 | The **yield-bounding caps** are surfaced with their effect stated in plain terms: `maxNewPerLane`, `maxProbesPerRun`, `maxCardsPerUrl`. `maxAgeDays` is surfaced separately, stated as LinkedIn page-inventory freshness (a doctor-check input), not a yield cap. [Amended 2026-08-18 at the BE-blueprint gate, F10 ratified by user — see rulings/be-gate-r1.md] | **P-c**, G2, Recon §5.3 | **Must** |
| R7 | `filter.json`'s `companies` (avoid list) and `timezones` are surfaced as forms. | Ask (driver 1), Recon (both live) | **Must** |
| R8 | The **retunable ranking lists** are surfaced: domain keywords, seniority targets, home cities, acceptable/borderline timezones, work-type preference. Point weights and denominators remain raw-JSON only. | Q2, G5 | **Must** |
| R9 | Notion **`mirror` on/off** and **`dryRun`** are surfaced as toggles. | Ask (driver 1), Q9, Recon §5.3 | **Must** |
| R10 | Cleanup TTLs are surfaced (`runsOlderThanDays`, `checkpointsOlderThanDays`, archive windows). | Ask (driver 1) | **Should** |
| R11 | The **connector** is displayed **read-only**, with copy explaining that switching the source of truth is a migration performed via the CLI — not a setting. | Q9, G12, Industry (Grafana provisioning asymmetry) | **Must** |
| R12 | **LinkedIn pacing** is surfaced as presets (Safe / Normal / Fast) with an advanced disclosure exposing the raw millisecond ranges behind a stated consequence ("pacing too aggressively can get your LinkedIn account soft-blocked"). | Q6, Ask (driver 1); *pain not user-selected* | **Should** |
| R13 | **No configuration saved from the board may be one that fails at wire time.** Cross-field invariants (e.g. `jitterMinMs ≤ jitterMaxMs`) are enforced at **save**, with the error shown at submit — not as-you-type, and never by disabling the save button. | **Stability**, G10, Recon §5.4, Industry (GOV.UK) | **Must** |
| R14 | A saved change states **when it takes effect** ("from your next run") and whether a run is currently in flight. | G15, Recon §5.4 | **Must** |
| R15 | Editing a matching or ranking rule shows its **effect against the last run's jobs** before saving (e.g. "would have dropped 189 of 214"). **Feasibility unconfirmed — flagged for the BE stage; cut cleanly if the spike fails.** | Q10, **P-c**, JTBD-4 | **Should** *(conditional)* |
| **Driver 3 — operate** ||||
| R16 | The existing daemon status (six states, last-tick, next-run) is presented on an **operations surface** alongside the schedule and run cadence, rather than stranded inside a configuration tab. | Ask (driver 3), Recon §5.5, Industry (Radarr System→Tasks) | **Must** |
| R17 | **LinkedIn session health** is surfaced as a distinct state (signed in / signed out / unknown). Remediation is **handed off** to the parked `setup-overhaul` epic, never implemented here. **Dependency: no such check exists at any layer today** — producing the signal is new backend work. | **P-b**, G3, Recon §5.5 | **Must** |
| R18 | **Live throttle-breaker state** is board-readable: closed / open with its reopen time. It is **cross-profile** (scoped to the shared Chrome profile) and must be labelled as such, not shown as a property of the current profile. **No manual reset control.** | Q5, G9, Recon `breaker_store.ts:6-10` | **Must** |
| R19 | **Live-daemon control**: pause and resume the schedule, and skip the next scheduled run — actions a *running* daemon can honour. **This expands the board's write surface and is named here as a deliberate design decision** requiring a BE-gate mechanism (a config field or a new intent kind). | Q4, **P-b** | **Must** |
| R20 | **Daemon lifecycle control** — start, stop, and autostart (darwin-only) — from the board. **Mechanism deliberately unspecified: a stopped daemon cannot poll an intent. Decided at the BE-blueprint gate by the user.** | Q4 rider, **P-b**, G4 | **Must** *(mechanism deferred)* |
| R21 | Doctor results are reachable from the operations surface, not only from the Hub. | G13, Recon §5.5 | **Should** |
| **Driver 4 — setup completeness** ||||
| R22 | A **setup completeness view** for existing profiles shows what is configured and what is missing — secrets, resume fields, search URLs, schedule, session health — each linking to the exact place to fix it. | Q3, Ask (driver 4), G16 | **Must** |
| R23 | Claude-dependent setup steps (Notion adopt-or-create via MCP, PDF→resume parsing) are **never reimplemented in the board**; the completeness view hands off to the CLI or slash command by name. | Q3, CLAUDE.md ("no PDF parsing in the daily path") | **Must** |
| R24 | Secrets remain **write-only with presence-only reads** over the existing allowlist; no secret value is ever returned to the client. | Recon §5.2, Industry (Apify) | **Must** *(preserves existing behaviour)* |
| **Cross-cutting** ||||
| R25 | Friction on a destructive action is **proportional to blast radius**: profile removal keeps type-to-confirm; reversible edits get no confirmation at all. | Industry (2026), G12 | **Should** |
| R26 | Settings **search** across all sections. | Industry (worth it past ~24 settings; we exceed it) | **Could** |
| R27 | **Reset-to-default** per setting, naming the exact consequence and visually subdued. | Industry | **Could** |
| R28 | Full **new-profile creation** in the board. | — | **Won't** *(this spec — Q1/Q3: no demand; the CLI wizard works)* |
| R29 | A **manual breaker reset** control. | — | **Won't** *(Q5: resetting a breaker that tripped for cause is how an account gets banned)* |
| R30 | Implementing **Chrome/LinkedIn login** in the board. | — | **Won't** *(parked `setup-overhaul` epic; R17 surfaces status only)* |
| R31 | **Telegram digest-shape configuration.** | — | **Won't** *(no such config exists — §5.3; the brief's item is void as written)* |
| R32 | **Autosave** on config forms. | — | **Won't** *(these are pipeline inputs; R13's save-time gate needs a commit point)* |

**Every driver carries at least one Must** — R1–R5 (driver 2), R6–R15 (driver 1), R16–R21
(driver 3), R22–R24 (driver 4) — as the brief's scope override requires.

### Backend dependencies — blast-radius review required

Per the stability principle, anything touching `pipeline/`, `runner/`, `adapters/`, `ports/`, or the
board's structural write boundary is designed deliberately and reviewed for blast radius, never
shipped on unit tests alone.

| Req | Touches | Blast radius | Failure mode to review |
|---|---|---|---|
| R13 | `core/config/validators.ts` or a new save-time validation layer | **Medium.** Shared with the CLI's own validation path. | Must not reject configs the pipeline would accept — a validator stricter than wire time locks the user out of valid states. Prefer *hoisting* the existing wire-time invariants, not inventing new ones. |
| R15 | read-side re-evaluation of stored jobs against edited rules, outside the pipeline | **Medium.** Risks a second implementation of filter/rank semantics that can drift from `core/`. | If it cannot reuse `src/core/filter` and `src/core/rank` **directly** (both are pure), it should not be built — a preview that disagrees with the pipeline is worse than none. Note the `ui/` seam: only dependency-free `core` modules are importable from the SPA. |
| R17 | a new login-health probe, likely in the LinkedIn adapter family | **Medium-high.** Touches `adapters/lanes/linkedin/`, and any probe drives a browser. | Must never launch Chrome or perturb the one-Chrome invariant on a page load. A probe timeout must read **unknown**, never *signed out* — a false "signed out" trains the user to ignore it. |
| R18 | read of `<userDataDir>/.jobbunny-linkedin-breaker.json` | **Low** — pure read of an existing file. | The board must resolve `userDataDir` (a Chrome-profile path, not the data home). A missing file means *never tripped*, not *error*. Stale-file semantics after cooldown must be defined. |
| R19/R20 | the board's write surface; `ops/daemon/`; possibly a supervisor | **Highest in this spec.** R20 has no agreed mechanism. | Expanding the write surface is a structural decision (`ports/board.ts`). R19 must not let the board spawn a run by any path. R20 must not violate the one-Chrome invariant or create a second scheduler. |

**The 10-stage pipeline and its order stay frozen.** Nothing here adds, removes, reorders, or changes
the semantics of a stage. product-ui confirms feasibility; these ratings are **provisional**.

---

## 12. Phase Decomposition

Ordered by value and risk (Q11 was delegated to me; this is the derivation and the defence).

**The ordering principle:** value first, but *containers before contents*, and *read-only before
write*. Two of the three user-confirmed pains (P-a, P-c) sit in Phase 1; the third (P-b) splits
across Phases 2 and 3 along exactly the read/write line, because its read half is nearly free and its
write half is the riskiest work in the spec.

### Phase 1 — Intent IA, carrying the knobs that explain a thin run

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R11, R13, R14.
**Value:** highest. Closes P-a and P-c, the two evidenced tuner-hat pains, and G6 — the one
structural gap.
**Risk:** low-to-medium. Config forms over an existing, already-validated PUT path. R13 is the only
part touching shared validation.

**Why first, and why it is not separable from driver 1:** the restructure is the *container*. Every
knob surfaced has to live somewhere, so shipping knobs into the current file-shaped tabs would mean
placing them once and moving them again. Driver 1 and driver 2 are not two phases that could be
ordered — they are one phase, and pretending otherwise would guarantee rework.

**The counter-argument, stated honestly:** P-b (ops blindness) is equally evidenced and Phase 2 is
cheaper and lower-risk than Phase 1. A reasonable person would ship the cheap read-only wins first.
**The condition under which to swap:** R17 and R18 are purely additive read-side signals that depend
on no container at all — they could be dropped into the *existing* Schedule tab tomorrow. **If Phase
1 looks like more than one slice, pull R17 and R18 forward as a standalone increment rather than
letting the two silent-outage gaps wait behind an IA project.** They will move house later at trivial
cost; that is a good trade.

**Phase 1 is unconditional.** It was originally gated on the §9 navigation test, with a branch that
would have collapsed driver 2 to grouping. **That test has run and refuted the assumption (1/5).**
The branch is closed; the gate is discharged; the phase ships as scoped.

**Cheap spike still to run inside this phase:**
- The **R15 preview feasibility spike**: can `src/core/filter` and `src/core/rank` be invoked
  directly against a stored job set from the board process, given the `ui/` dependency-free-import
  seam? Answering this early is what keeps R15 cuttable rather than half-built.

### Phase 2 — Operate: the truth about the machine (read-only)

**Requirements:** R16, R17, R18, R21.
**Value:** high. Closes the read half of P-b, and closes G3/G9 — the two silent-outage gaps whose
absence actively undermines the previous epic's calm-empty state.
**Risk:** low on the pipeline (every item is a read), medium on delivery: R17's signal **does not
exist yet** and R18 needs the board to resolve a Chrome-profile path.

**Why second:** it is read-only, so it can slot into whatever container Phase 1 establishes without
rework, and it carries none of Phase 3's structural cost. Doing it before Phase 1 would mean building
an operations surface with no home; doing it after Phase 3 would mean shipping controls for states
the user still cannot see.

### Phase 3 — Operate: control (write surface expansion)

**Requirements:** R19, then R20.
**Value:** high — the write half of P-b, and the end of CLI-commands-as-hint-text.
**Risk:** **highest in the spec.** R19 expands the board's structural write surface; R20 has no
agreed mechanism at all and is gated on a user decision at the BE-blueprint gate.

**Why third:** strict value/risk ordering. It is the only phase that spends a structural invariant,
the only one with an unresolved mechanism, and the only one that could plausibly destabilise the
pipeline. Everything cheaper and safer goes ahead of it. **R19 before R20** because a running daemon
honouring a pause is a bounded, reversible change, whereas starting a stopped daemon requires new
machinery whose shape is not yet decided.

**Gate:** Phase 3 does not begin until the BE-blueprint gate has ruled on R20's mechanism. If that
ruling is "not worth it," R19 still ships and R20 becomes Won't — a clean outcome, not a stall.

### Phase 4 — Setup completeness

**Requirements:** R22, R23, R25.
**Value:** lowest on evidence — this is the driver the user's own answers do not support (Q1: no
new-profile setup; Q3: not for other people). Its genuine value is as a **table of contents with a
health signal** over 13–14 doctor checks now spread across two pages, which is a real if modest
navigational win.
**Risk:** low. Read-only aggregation over the existing doctor endpoint plus links.

**Why last:** honesty. It is in scope by dispatch, not by demand, and it should not consume effort
ahead of three drivers that are. It also benefits most from going last — it is a checklist *of* the
other three phases' surfaces, so building it first would mean pointing at pages that do not exist.

### Tail — ship only if cheap

R10 (cleanup TTLs), R12 (pacing presets), R15 (preview, if the spike passed), R26 (search), R27
(reset-to-default). None is load-bearing; each is cuttable with no dependents. R15 is the only one
whose loss changes the spec's character — see §16 weakness 3.

---

## 13. Acceptance Criteria

Objectively checkable. Each maps to a requirement.

1. No navigational element in the settings surface is named after a config file. Checkable by
   inspection of the section labels. *(R1)*
2. Starting from the intent "change which timezones I'll accept," the user reaches **both** the
   pass/fail rule and the ranking preference without visiting two differently-named sections, and
   the difference between the two is stated in the UI. *(R2)*
3. Every setting displays its scope; changing the active profile visibly does **not** change any
   machine-scoped value. *(R3)*
4. Editing a value in the raw config area and reopening the corresponding form shows the new value,
   and vice versa, with no reload and no divergence. *(R4)*
5. Navigating away from a form with unsaved edits either preserves them or warns; it never discards
   them silently. *(R5)*
6. `maxNewPerLane`, `maxProbesPerRun`, `maxCardsPerUrl`, and `maxAgeDays` are each editable from a
   form; `maxNewPerLane`, `maxProbesPerRun`, and `maxCardsPerUrl` each display a one-line statement of
   what they cap, and `maxAgeDays` displays a one-line statement of what it gates (LinkedIn
   page-inventory freshness — a doctor-check input, not a yield cap). [Amended 2026-08-18 at the
   BE-blueprint gate, F10 ratified by user — see rulings/be-gate-r1.md] *(R6)*
7. `filter.json`'s `companies` avoid-list and `timezones` are editable from a form, and a value saved
   through that form is present in the doc read back by `GET /api/profiles/:name/config/filter.json`.
   *(R7)*
8. Domain keywords, seniority targets, home cities, acceptable/borderline timezones, and work-type
   preference are editable from a form; skill point weights are **not** present in any form. *(R8)*
9. Notion `mirror` and `dryRun` are toggles; toggling either and re-reading `profile.json` shows the
   change. *(R9)*
10. The connector is displayed and cannot be changed from the board; the UI states why. *(R11)*
11. Attempting to save `jitterMinMs > jitterMaxMs` is rejected **at save time** with an error naming
    the two fields. The save button is never disabled as the means of preventing it. *(R13, Industry)*
12. Every successful save states when the change takes effect and whether a run is in flight. *(R14)*
13. *(Conditional on the spike)* Editing a filter rule displays the count of the last run's jobs that
    the edited rule would have dropped, before saving. If the spike failed, this criterion is struck
    and no partial preview ships. *(R15)*
14. Daemon state, last tick, and next run are visible from the operations surface without opening a
    configuration form. *(R16)*
15. LinkedIn session health renders as exactly one of signed-in / signed-out / unknown, and a probe
    timeout renders **unknown**, never signed-out. Remediation copy names the CLI path and does not
    attempt a login. *(R17)*
16. Breaker state renders as closed, or as open with a reopen time; it is labelled as applying to all
    profiles; no control exists to reset it. A missing breaker file renders as *closed*, not as an
    error. *(R18)*
17. Pausing the schedule prevents the next scheduled run from starting, and resuming restores it,
    both verified against a running daemon. *(R19)*
18. With the daemon stopped, the board offers a control that starts it — or, if the BE gate ruled the
    mechanism out, states plainly that the daemon must be started from the CLI and gives the command.
    *(R20)*
19. Doctor results are reachable in one action from the operations surface. *(R21)*
20. For a profile missing a secret, a resume field, and a search URL, the completeness view lists all
    three as missing and each links to the place to resolve it. *(R22)*
21. No board route performs Notion adopt-or-create or PDF resume parsing; the completeness view names
    the CLI/slash command instead. *(R23)*
22. No API response contains a secret value; presence is reported as configured / not configured.
    *(R24)*
23. Profile removal still requires type-to-confirm; no reversible settings edit requires a
    confirmation dialog. *(R25)*
24. **Regression, non-negotiable:** the board still binds `127.0.0.1` only, and no board route spawns
    a run by any path — including every control added by R19 and R20. *(Hard constraint)*

---

## 14. Success Metrics

Observable outcomes, deliberately not counts of settings surfaced.

1. **Text-editor exit.** The user changes a matching, ranking, or cap setting without opening a
   config file. Directly observable. *Honest caveat: using the consolidated raw-config area counts as
   a text editor for this metric — if edits merely relocate into the raw pane, the forms failed.*
2. **Thin-run attribution time.** From "this run was thin" to "here is the cap or rule responsible."
   Today: a code read. Target: answerable from the board. Observable on the next real thin run — the
   same event that generated P-c.
3. **Silent-outage detection.** The next expired LinkedIn session or open breaker is noticed **from
   the board on the day it happens**, rather than inferred later from a run that came back calm and
   empty. This is the metric that connects this epic to the previous one.
4. **Terminal-free daemon operation.** The user stops or restarts the daemon without a terminal — or,
   if R20's mechanism is ruled out, the board at least tells him precisely what to run instead of
   printing a command as decoration.
5. **Counter-metric (guards against preference bloat):** the number of settings *surfaced* is not a
   success measure. If the raw-config area's usage does not fall after Phase 1, the forms are not
   covering the knobs that matter and more forms will not fix it.
6. **Counter-metric (guards against over-building):** time spent in Settings should stay low and
   ideally fall. This is a surface the user should visit deliberately, change one thing, and leave.
   A settings page that becomes engaging has failed this persona.

---

## 15. Out of Scope

| Excluded | Reason |
|---|---|
| **Implementing Chrome/LinkedIn login** | Parked `setup-overhaul` epic, scoped as `jobbunny login`. R17 surfaces status and hands off; it never authenticates. |
| **Full new-profile creation in the board** | Q1/Q3: no demand, not for other people, CLI wizard works. Reshaped out of driver 4 explicitly, not dropped silently. |
| **Notion adopt-or-create; PDF→resume parsing** | Require Claude/MCP. CLAUDE.md forbids PDF parsing in the daily path. Handed off by name (R23). |
| **Telegram digest-shape configuration** | **Does not exist.** Only `chatId` is configurable; the digest is code. The brief's driver-1 item is void as written. |
| **Ranking point weights, denominators, multipliers** | Q2(b): a model tuned once, not a setting changed often. Raw JSON remains the honest home. |
| **Manual throttle-breaker reset** | Q5. The breaker trips on real soft-blocking; a reset button is an account-ban affordance. |
| **Changing the connector from the board** | Q9. Switching the source of truth is a migration with data consequences, not a setting. Displayed read-only. |
| **The CLI's own configuration UX** | Scope is the board. Backend work serving the board remains in scope. |
| **Changing the 10 stages, their order, or their semantics** | Frozen by architectural contract. |
| **Any multi-user concern** — auth, permissions, "who changed this," audit trail | Single-user tool on `127.0.0.1`. Assuming a second human is waste. |
| **System telemetry** (CPU, memory, network charts) | Research anti-pattern; the persona wants pipeline semantics, not infrastructure metrics. |
| **The board spawning runs directly** | Hard architectural invariant. The daemon is the sole spawner; the board inserts intents. Applies to every control in Phase 3. |
| **A charting dependency** | Not pre-approved by this spec, per the inherited constraint from `run-experience-overhaul`. |
| **Autosave** | These are pipeline inputs; R13's save-time validation gate requires a commit point. |

---

## 16. Four-Risks Scorecard

Cagan's four risks. Feasibility is **PROVISIONAL** — product-pm has no engineering tools; product-ui
confirms.

| Risk | Score | Rationale |
|---|---|---|
| **Value** — will they use it? | **Medium-Strong** | Three frictions were user-confirmed within the last month (P-a, P-b, P-c), and G6 is a structural incapability rather than a preference. But the honest ceiling is low: **zero capability is gained** — every knob is already editable by a user fluent in the schema he wrote. This is friction removal, not enablement, and one of the four drivers (4) is contradicted by the user's own answers. Not Strong, and the gap between Medium-Strong and Strong is exactly R15: with a working preview this becomes a tool that answers questions; without it, it is a better-arranged form. |
| **Usability** — can they figure it out? | **Medium — OPEN, handed to UX** | Deliberately unresolved here. Open concerns for product-ux, not answered by product-pm: **(a)** the Hub-vs-Settings boundary (§7.5) — four options framed, none chosen, and it determines the home of every Phase-2/3 control; **(b)** how R2 presents one intent whose two halves have genuinely different semantics (drop vs. de-rank) without either collapsing them into a lie or exposing the file split the epic exists to hide; **(c)** how R4's consolidated raw editor stays *reachable but not attractive* — an escape hatch that is pleasant to use is an IA that gave up, yet one that is hidden strands the settings it is the only home for; **(d)** how R12's pacing consequence is communicated with weight proportional to an account ban without becoming a warning users learn to click past; **(e)** whether the machine/profile scope split (R3) is expressed as separate places, as labels, or as both — noting it interacts directly with (a). |
| **Feasibility** — can we build it? | **Medium — PROVISIONAL** | Most requirements are forms over an existing validated PUT. Four are genuinely uncertain and they are not evenly distributed across the phases: **R20** has no agreed mechanism at all (a stopped daemon cannot poll an intent) and is gated on a user decision; **R17's login signal does not exist at any layer** and any probe risks the one-Chrome invariant; **R15** must reuse `core/filter` and `core/rank` directly or not ship, and the `ui/` dependency-free-import seam may block that; **R18** needs the board to resolve a Chrome-profile path it does not currently know. R13 carries a subtler risk than it looks: a validator stricter than wire time would lock the user out of configurations the pipeline accepts. |
| **Viability** — does it work long-term? | **Medium** | *Non-top score, and the lowest of the four.* No revenue or compliance surface, so viability here is maintenance cost against a strict architecture — and this epic is unusually expensive on that axis. Every knob surfaced is a form, a validator, and a test maintained forever by the one person who must also keep the scraper working; the 400-line file cap on `ui/src/` and the two-pair module rule will both bind before this is done. **More seriously, Phase 3 spends a structural invariant**: `ports/board.ts` deliberately separates the board's write surface from pipeline control, and R19/R20 push against exactly that boundary for operator convenience. That is a real architectural cost, named as a design decision per the brief rather than absorbed quietly. |

### Named weaknesses — this scorecard is not a clean sweep

1. ~~**The central assumption is close to unfalsifiable before build.**~~ **RESOLVED 2026-08-17 — the
   assumption was tested and refuted.** The listed weakness was that the epic rested on an
   intent-shaped IA helping a user who already knows the file-shaped one perfectly, and that card
   sorting is unavailable at n=1 with the schema's author as the only participant. The five-minute
   substitute test in §9 was run unprimed and scored **1/5**, including one *confidently wrong*
   answer on a setting the user had named among his own frictions. **This strengthens the spec:**
   driver 2's value now rests on evidence rather than reasoning, R2 becomes the best-evidenced
   requirement in the document, and the scope-reduction branch is closed. Retained here rather than
   deleted, because a scorecard that quietly drops its weaknesses once they resolve is not a record.
2. **Driver 4 is in scope by dispatch, not by demand.** The user's Q1 answer did not select
   new-profile setup and his Q3 answer ruled out other users. It is reshaped into the most defensible
   form available (a completeness view over doctor checks) and placed last, but it should be the
   first thing cut if the epic runs long, and the spec says so rather than pretending otherwise.
3. **The highest-value requirement is the least certain.** R15 (preview) is the difference between a
   tool and a form — it is what would let the user answer "why was my run thin" rather than merely
   read the number that caused it. It is a **Should**, conditional on a spike, and it may not be
   feasible. If it is cut, this spec's honest description becomes "the same knobs, better arranged,
   plus ops visibility," and the Value score should be re-read as Medium.
4. **Two of the research areas that matter most have no in-domain sources.** There is no published
   design guidance on exposing scraper pacing controls to end users, and none on presenting circuit-
   breaker state to a non-SRE. R12 and R18 are therefore transferred reasoning from observability and
   backoff literature, not validated practice. Since the pipeline runs no second research pass,
   product-ux inherits this and should treat both as hypotheses.
5. **The opportunity-cost argument survives the verdict.** The ~67% LinkedIn empty-identity yield loss
   still costs real leads and is still open. "Build" is not a claim that this outranks it. The
   partial defence — that G2 is itself a lead-loss gap, since an invisible `maxNewPerLane: 40` may be
   silently truncating good days — is genuine but unquantified, and it is not the same as fixing the
   known loss.
6. **The brief contained three factual defects** (a void Telegram item, a "dead config" claim that was
   false, and a breaker constraint contradicted by the code). All three are corrected in this spec.
   The relevant weakness is not the errors themselves but what they imply: **the ops and config
   territory this epic covers is less well-mapped than the settings surface**, and downstream stages
   should verify rather than inherit.
