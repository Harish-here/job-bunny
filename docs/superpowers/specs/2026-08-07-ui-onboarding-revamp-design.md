# UI Revamp + In-Board Onboarding — Design Spec

**Date:** 2026-08-07
**Status:** Approved design, pending implementation plan
**Guiding principle:** fast to set up — fresh install → browser → working profile → first run, in minutes. Power users can customize everything; nobody is forced to.

## 1. Summary

The board UI becomes the single stop for Job Bunny: onboarding (everything `jobbunny setup` / `/setup` does, minus LLM-only extras), profile configuration, and actually running the pipeline — all from the browser after install. The whole UI gets a new visual identity ("Lapin"); the job-board pages keep their current layouts, restyled.

Four decisions anchor the design (made interactively 2026-08-07):

1. **Forms-first onboarding, no LLM.** Persona presets (Frontend, Backend, CSM, Sales, …) pre-fill skills/title rules/seniority; plain code derives `filter.json` from user answers. Resume PDF parsing and Notion DB *creation* stay `/setup` extras.
2. **Run-intent queue.** The board never spawns runs. It writes an intent row; the daemon (sole spawner, one-Chrome invariant) picks it up on its ≤30s tick.
3. **Full visual revamp, layouts preserved on board pages.** New identity everywhere; Triage/Tracker/Job/Runs keep their structure.
4. **Secrets in UI via a write-only endpoint.** Masked inputs; server reports only present/absent, never the value.

Onboarding shape: **linear wizard for first run + a permanent Setup & Health hub afterward** (wizard ships first; the hub reuses the wizard's step panels as cards).

## 2. Architecture

### 2.1 Process model (unchanged)

Board server and daemon remain separate processes. The daemon remains the **sole run-spawner**. The per-profile SQLite DB is the only shared state. The board stays `127.0.0.1`-only.

### 2.2 Hard-rule amendment

The pinned board write-surface rule (`ports/board.ts`, CLAUDE.md, explainer KB) is amended from "tracking + config + createProfile, nothing else" to additionally allow:

- run intents (insert `pending`, delete own `pending`),
- secrets (write-only, allowlisted keys),
- doctor execution (read-only diagnostics),
- profile removal (guarded, mirrors CLI semantics).

`jobs` and the runs tables stay pipeline/runner-only; the split remains structural. The amendment text for CLAUDE.md / agent docs is shown verbatim for approval at implementation time (per standing instruction-file rule), in the same PR that widens the port.

### 2.3 New server surface (existing `node:http` router)

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/profiles/:name/run-intents` | Insert `pending` intent. Dedup + guards in §2.4. Returns intent (201) or existing (200, `deduped: true`). |
| DELETE | `/api/profiles/:name/run-intents/:id` | Cancel — only while `pending` (unclaimed). |
| GET | `/api/profiles/:name/doctor` | Runs the composed `DoctorCheck[]`; returns findings. Degrades like CLI doctor: config-only checks when full wire fails. |
| GET | `/api/secrets` | `{NOTION_TOKEN: "present"\|"absent", TELEGRAM_BOT_TOKEN: …}` — never values. |
| PUT | `/api/secrets/:key` | Write-only append/replace in `.env`. Allowlist: `NOTION_TOKEN`, `TELEGRAM_BOT_TOKEN`. |
| GET | `/api/personas` | Static persona catalog shipped in-repo (JSON). |
| GET | `/api/daemon` | `running \| stopped \| stale` from pidfile/heartbeat + next scheduled slots per profile. Read-only. |
| DELETE | `/api/profiles/:name` | Remove profile (guards in §3.5). |

Starting the daemon stays a CLI action; the wizard surfaces `jobbunny serve start` as a copy-paste command — the only terminal touch after install.

### 2.4 Run intents: storage, pickup, guardrails

- New `run_intents` table in the per-profile DB: `id, requested_at, status (pending|claimed|cancelled), claimed_run_id`. `expired` is derived on read from `requested_at` age (same pattern as the run store's derived `crashed`), never stored.
- **Daemon pickup:** the existing 30s tick scans `run_intents` alongside the schedule; claiming flips status to `claimed` and back-writes the spawned run's ID so the UI can jump to live progress. Spawning stays sequential (one Chrome).
- **Dedup (server-enforced):** partial unique index on `status = 'pending'` per profile — N clicks queue exactly one run.
- **Already running → 409** with the running run's ID (fresh heartbeat check); UI shows "Run in progress — view it". No follow-up queue in v1.
- **Expiry:** a `pending` intent older than 10 minutes (20 ticks) reads as `expired` — skipped by the daemon, shown by the UI as the honest "daemon isn't running" signal with a start hint. An expired intent no longer blocks the dedup index's practical intent (the UI offers "queue again", which cancels the stale row and inserts fresh).
- **Cancel** works only pre-claim. Killing an in-flight run is out of scope (daemon/Chrome territory).

### 2.5 Live progress

No SSE/WebSocket. TanStack Query `refetchInterval` (2–3s) while an intent is `pending` or a run is `running`; the run store's `runs`/`run_events`/heartbeat are already fully readable. Push channels are a later option if polling ever feels laggy.

### 2.6 Personas

- Catalog: Frontend, Backend, Fullstack, Data, DevOps/SRE, Product, Design, CSM, Sales, Marketing, plus *Start from scratch*.
- Each persona = default core/secondary skills, title `domain`/`function`/`seniority` match+reject rules, seniority options.
- Applying a persona only **pre-fills the wizard's forms** — the server never merges personas into config; all writes go through the user-visible forms and the existing `PUT config` path, so "seeding never clobbers" holds.
- Filter derivation is plain code: persona rules ∪ user answers from wizard step 3 → `filter.json` `title` + `locations[]` blocks; the derived rules are inspectable in the step's advanced disclosure before saving.

### 2.7 Config persistence (already solved — no new work)

`POST /api/profiles` already seeds template docs into the per-profile DB's `config_docs` (schema v5, `seedProfileDocs` via `ConfigStore` — `src/cli/wire/board.ts`). The wizard fills those rows through the same `PUT /api/profiles/:name/config/:doc` endpoint. One write path; no drift between setup and UI.

## 3. UX

### 3.1 Onboarding wizard (replaces the current name-only Onboarding page)

Full-screen, shown automatically when the board opens with no configured profile; launchable from the hub for new profiles. Six steps:

1. **Name it** — profile name + one-line orientation. Local-first is the silent default.
2. **Pick a persona** — grid incl. *Start from scratch*. Stages defaults; writes nothing yet.
3. **About you** — seniority, YOE, core/secondary skill chips (pre-filled), domain experience, work type, home + acceptable locations. Writes `resume.json` and derives `filter.json` (title + geo). Advanced disclosure shows derived rules pre-save.
4. **Where to hunt** — structured add of LinkedIn saved-search URL(s) + label → `search_urls.md`; flags page-inventory coverage; notes Greenhouse/Keka auto-discovery (nothing to configure).
5. **Extras (skippable in one click)** — Notion mirror: masked token + existing DB/page ID, reachability validated through the existing Notion adapter (DB *creation* stays `/setup`). Telegram: masked token + chat ID + "send test message".
6. **Launch** — schedule preset (§3.4), daemon status with copy-paste `serve start` if stopped, **Run now**. Ends on the Runs page watching the first run.

Behavior: server 422 zod errors render inline on the exact field; Back never loses input; closing mid-wizard resumes (wizard state in `localStorage`; written docs are already durable).

### 3.2 Setup & Health hub (new page; replaces "Onboarding" nav item)

- Status cards: Profile, Persona & filters, Search URLs, Integrations, Schedule & daemon, Pipeline health. Each opens the matching wizard step panel (components reused, not rebuilt).
- Doctor findings render grouped under their card. Top billing: schedule-enabled-but-daemon-stopped (⚠️ "Scheduled for 09:00 but the daemon isn't running").
- The hub is the destination whenever any page detects a red state.

### 3.3 Settings rebuild (four textareas → forms)

- Sections: **Profile** (identity, connector, Notion settings, notifiers), **Schedule** (§3.4 editor), **Filters** (title rule list editor with match/reject/severity, locations editor, skills), **Resume** (same structured form as wizard step 3), **Search URLs** (list editor + coverage status).
- Every section keeps an **"Edit as JSON"** escape hatch writing through the same `PUT config` endpoint.
- **Danger zone:** remove profile (§3.5).

### 3.4 Scheduling UI

- **Wizard step 6 preset:** *Morning (09:00)* / *Morning + afternoon (09:00, 14:00)* / *Custom times* / *Manual only*; weekdays default Mon–Fri, editable.
- **Settings Schedule section:** time chips (add/remove `HH:MM`), weekday toggles, grace-minutes, enabled switch, and a computed "Next run: …" preview using the same `isRunOwed` logic the daemon uses.
- Writes are just `profile.json`'s `schedule` block via `PUT config` — no new write surface.

### 3.5 Remove profile

- Settings → Danger zone → "Remove this profile". Mirrors CLI semantics: refuses `rajni`, never touches Notion, deletes `profiles/<name>/` (server reuses the CLI removal logic).
- Guards: type-the-profile-name-to-confirm dialog; lists exactly what is deleted (DB, docs, run history); blocked while the profile has a running run or pending intent.

### 3.6 Run experience

- **Run now lives in the sidebar**, scoped to the selected profile, always visible; label is honest state: *Run now → Queued (waiting for daemon) → Running — filter 7/10 → Done: 14 new*.
- Runs page gets a live in-flight header: stage progress from `run_events`, elapsed time, heartbeat freshness.
- Every intent/run state is visible and named (queued / waiting-for-daemon / expired / running / failed) — no infinite spinners; failures link to run detail and the hub.

### 3.7 Shell: workspace maximization + branding

- **Sidebar collapses to an icon rail** (~56px: logo mark + icons + mascot); expanded ~224px; state persisted; keyboard shortcut + edge toggle.
- **Content area loses width caps** — pages stretch to the viewport (comfortable max only on reading-heavy job detail); vertical chrome trimmed.
- **Sidebar header = the README lockup:** `assets/job-bunny-logo.svg` with `assets/job-bunny-wordmark.svg` beneath, same style and similar proportions as the README (scaled to sidebar width; logo alone when collapsed). Version tag beneath.

## 4. Visual system — "Lapin"

Friendly, rounded, quick. Applied via the existing shadcn/Tailwind token set (`ui/src/index.css`).

- **Palette:** deep plum ink `#3D2C55` (text); violet `#7B5EA7` primary (hover `#5E4590`); carrot `#FF8A3D` strictly for "needs you" (triage counts, warnings, due items); clover `#4CAF6E` success/alive; ground `#FAF8FD`; dark mode `#1A1523` with lavender text. Chart placeholder tokens get real Lapin values.
- **Type:** Geist stays for body/UI; a rounded display face (Nunito or Baloo 2, self-hosted) for page titles, wizard headlines, big numbers only. Mono for IDs/timestamps.
- **Shape & motion:** radius up (cards 16px, chips full-round); one springy micro-transition (~150ms translate+settle "hop"), used consistently; `prefers-reduced-motion` respected.
- **Signature:** a small SVG bunny mascot in the sidebar next to Run now, wired to the run state machine — asleep (idle), ears up (queued), hopping (running), celebrating (new matches). Used nowhere else.
- Board pages (Triage, Tracker, Job, Runs): token + component-skin restyle only; layouts unchanged.
- New shadcn primitives needed: dialog, tabs, form, progress, switch (added in the restyle phase).

## 5. Error handling

- Field-level: 422 zod messages map to the exact input; never toast-only failures.
- Run path: named states everywhere (§3.6); expired intents explain themselves and link to the daemon start hint.
- Doctor endpoint degrades to config-only checks when wire fails (same as CLI).
- Secrets endpoint failures never echo the submitted value.

## 6. Phasing (one PR each; pipeline untouched until reviewed)

> **Dependency:** Phase 1 depends on the consumer-CLI data-home spec (same date, `2026-08-07-consumer-cli-data-home-design.md`) landing first — all path-touching endpoints (secrets → `.env`, daemon status → pidfile, profile removal → `profiles/<name>/`) resolve through `resolveHome()`, never `process.cwd()`. Phase 2 has no such dependency and may run in parallel with the data-home work.

1. **Server surface** — `run_intents` table + endpoints + daemon pickup, doctor endpoint, secrets endpoint, personas catalog, daemon status, profile removal. Includes the hard-rule amendment + doc sync (CLAUDE.md text shown for approval).
2. **Lapin restyle** — tokens, new primitives, reskin existing pages, sidebar rework (collapse + README lockup), mascot.
3. **Wizard** — six steps + first-boot redirect.
4. **Hub + Settings rebuild + live runs** — hub cards reusing wizard panels; Run now + polling; scheduling UI; danger zone.

## 7. Testing

### Unit (colocated, per new module)

Intent store (dedup, expiry, claim), persona → filter derivation, schedule preview (`isRunOwed` seam), doctor route, secrets allowlist/redaction, removal guards. Daemon intent pickup tested at the `scan`/`isRunOwed` seam like schedule logic already is.

### Playwright e2e (full suite, not happy-path-only)

- **Wizard:** happy path per persona type; start-from-scratch; back-navigation keeps input; close-and-resume mid-wizard; skip extras; field validation (bad URL, bad time, bad token shape → inline 422s); derived-rules advanced view matches saved `filter.json`.
- **Settings:** every section round-trips form → DB → reload; JSON escape hatch round-trip; invalid JSON rejected inline.
- **Runs:** run-now dedup (double-click = one intent); waiting-for-daemon state; expired intent; live progress header updates from seeded `run_events`.
- **Profile:** create → appears in switcher; remove guarded (wrong name = no delete; `rajni` refused).
- **Shell:** sidebar collapse persists; all pages render at rail width.

### Acceptance verification (end of phase 4)

1. Create a **sample profile** through the real UI and walk the entire wizard.
2. Verify data landed **visually** (Settings forms show it) **and in the DB** (`config_docs` rows inspected).
3. **Live run of `harish` triggered from the UI** (owner-directed; a normal production run, UI-initiated): queued → picked up → stage progress → done, all updating correctly on the Runs page.

## 8. Out of scope

- Resume PDF parsing in the UI (stays a `/setup` extra; wizard step 3 collects the same fields as forms).
- Notion DB creation from the UI (adopt-by-ID only; creation stays `/setup`).
- Cancelling an in-flight run; follow-up run queuing (`?follow=true`).
- SSE/WebSocket push (polling suffices for v1).
- Board server spawning any process (runs or daemon).
- Layout changes to Triage/Tracker/Job/Runs.
