# Recon: current Settings-page surface (2026-08-17)

Input artifact for the `settings-overhaul` epic. Produced by repo-KB recon (explainer agent) reading live code; file:line refs verified at recon time.

## 1. What the Settings page renders today

- **Tab shell** — six tabs (Profile, Schedule, Filters, Resume, Search URLs, Danger zone), hash-routed `#/settings/:section`; every tab except Danger zone gets a shared "Edit as JSON" hatch — `ui/src/features/settings/SettingsPage.tsx:12-50`.
- **Profile tab** — connector select (`sqlite`/`notion`), lanes checkboxes (linkedin/greenhouse/keka), Telegram-notifier toggle, routines chips; writes `profile.json` `connector`/`lanes`/`notifiers`/`routines` via `PUT /api/profiles/:name/config/profile.json` — `ui/src/features/settings/sections/ProfileSection.tsx:18-74`.
- **Schedule tab** — run-times chips, enabled switch, weekday toggles, grace-minutes; read-only daemon-status readout (healthy/stopped/stale/degraded + next run) from `GET /api/daemon`; writes `profile.json.schedule` — `ui/src/features/settings/sections/ScheduleSection.tsx:57-116`.
- **Filters tab** — title rules (domain/function/seniority match/reject chips + hard/soft severity), locations (city/country/workTypes), skills (core skills, minMatch, severity); writes ONLY `filter.json` `title`/`locations`/`skills` — `companies` and `timezones` blocks pass through untouched, never rendered — `ui/src/features/settings/sections/FiltersSection.tsx:183-226`, `filters.model.ts:20-24`.
- **Resume tab** — 7 `resume.json` keys (current YoE, target seniority, core/secondary skills, preferred work type, location, domain experience); other keys pass through — `ResumeSection.tsx:54-63`.
- **Search URLs tab** — editable row list (URL, label, derived page-inventory slug badge, coverage warning) over `search_urls.md` (markdown, bypasses the JSON doc-form path) — `SearchUrlsSection.tsx:55-86`.
- **Danger zone** — type-to-confirm profile removal; client-side courtesy block if run `running`/intent `pending`; `DELETE /api/profiles/:name` — `DangerZone.tsx:34-59`.
- **JSON escape hatch** — per-tab raw textarea over the same doc/PUT as the tab's form — `JsonEscapeHatch.tsx:24-49`.

## 2. Write-surface contract & guardrails (server side)

- Config docs: `GET/PUT /api/profiles/:name/config/:doc` for the four docs; PUT validated by `core/config/validators.ts` `validateConfigDoc`, 422 with zod message on failure — `src/app/features/config/routes.ts:24-29,104-121`.
- Profile creation: `POST /api/profiles`, name regex checked server + port side — `src/app/features/config/routes.ts:36-42,123-142` (surfaced in Hub/wizard flow, NOT in Settings).
- Profile removal: server-side guards refuse protected fixture (rajni), running run (409 `run_in_progress`), pending intent (409 `intent_pending`) — `src/app/features/profiles/routes.ts:23-65`.
- Secrets: `GET /api/secrets` presence-only over allowlisted `SECRET_KEYS` (`ports/board.ts`); `PUT /api/secrets/:key` write-only `.env` upsert, rejects newlines/quotes/backticks/backslashes — `src/app/features/secrets/routes.ts:11,31-70`. Reachable only from Hub (`#/setup`), Settings copy points users there (`ProfileSection.tsx:149-152`).
- Doctor: `GET /api/profiles/:name/doctor`, read-only, same checks as CLI doctor — `src/app/features/doctor/routes.ts:17-31`. Hub-only.
- Overall board write surface (CLAUDE.md hard rule): tracking + config tables + run_intents (insert pending / cancel own) + secrets (write-only, allowlisted) + doctor (read-only) + guarded profile create/remove. `jobs` and runs tables (`runs`/`run_events`/`checkpoints`) stay pipeline/runner-only — split is structural (`ports/board.ts`).

## 3. Gap list — exists in config, NOT surfaced (JSON-hatch or CLI only)

- `filter.json.companies` (avoid list) — never rendered (`filters.model.ts:20-24`).
- `filter.json.timezones` — same.
- `profile.json.settings.linkedin.*` pacing (jitter, inter-URL delay ranges) — no form.
- `profile.json.settings.cleanup.*` (runsOlderThanDays, checkpointsOlderThanDays, archive windows) — no form.
- `profile.json.settings.notion.mirror` / `.dryRun` — no toggle; deferred to Hub or JSON edit.
- Telegram digest config — token via Hub secrets; digest-shape settings JSON-hatch only.
- Daemon control — Schedule tab is status-display only; start/stop/autostart is CLI-only, surfaced as literal command text in a degraded-state hint (`ScheduleSection.tsx:22,182`).
- Doctor detail (incl. mirror-downgrade nuance) — Hub-only, not cross-linked from Settings.
- `avoid.md` — correctly absent (dead: read by no runtime code).

## 4. Known friction / limitations

- Scroll containment fixed in PR #106 (`SettingsPage.tsx:61` overflow-y-auto; hatch dialog solved independently `JsonEscapeHatch.tsx:63-68`).
- Hub/Settings split is a deliberate seam explained by one line of copy — a UX seam the overhaul must resolve or make principled.
- No cross-doc raw-JSON view; each hatch scoped to its own doc.
- Danger-zone client checks are advisory-only; races surface as raw 409 text.

## Recon NOTES (uncertainty boundary)

- Explainer KB (snapshot 2026-08-08) does not cover Settings section structure; inventory came from live code reads. No KB contradiction found.
- Not read in full: `useConfigMutation.ts`, `config.queries.ts`, `DocFormGate.tsx`, `searchUrls.model.ts`, Hub page files — behavior inferred from call sites. Hub secrets/doctor UI copy and search-URL slug-coverage logic need a follow-up read if a stage depends on them.
- Server-side `BoardSource` implementations (`cli/wire/board.ts`) not read; route layer only.
