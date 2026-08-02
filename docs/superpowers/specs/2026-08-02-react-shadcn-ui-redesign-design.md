# React + shadcn/ui Board Redesign — Design Spec

**Date:** 2026-08-02
**Status:** Approved pending user review
**Supersedes:** the Svelte 5 implementation of the `ui/` workspace

## Summary

Rewrite the job-board SPA (`ui/`) from Svelte 5 to React + shadcn/ui, redesign it
around a triage-first daily flow, brand the sidebar (logo + title + version), and
add a critical-path Playwright e2e smoke suite. The board server API is unchanged
except one tiny addition (`GET /api/app`). The pipeline (`src/`) is untouched
beyond that endpoint.

## Goals

- Owner-maintainable UI: the operator knows React; Svelte never built a mental model.
- Real shadcn/ui (React-native), not a port — accessible primitives we copy in and own.
- Triage-first UX: scan → read JD → decide (apply/skip/save) → next, keyboard-driven.
- Tracker second (kanban + due strip), full-page job detail third.
- E2E confidence on the daily-flow critical paths, running in CI.

## Non-goals

- No pipeline/stage changes; board write surface stays tracking-only.
- No side-by-side compare view (revisit later).
- No dark/light toggle (system-follow only, as today).
- No analytics/onboarding rethink — straight ports, restyled.
- No new root runtime deps — everything lands in `ui/package.json` (private).

## Migration strategy (decided)

Clean-slate replacement: the React app is built in `ui/` on a feature branch;
Svelte files are deleted in the same effort. Framework-agnostic modules
(`lib/router.ts`, `lib/api/client.ts`, `features/board/tracking.ts`) and their
tests are ported, not rewritten. No side-by-side workspaces, no islands — at
~760 lines, the git branch is the safety net.

## Stack

| Concern | Choice |
|---|---|
| Framework | React 19 + TypeScript, Vite |
| Components | shadcn/ui copy-ins under `ui/src/components/ui/` (we own the code) |
| Styling | Tailwind 4; shadcn CSS-variable theming; accent palette seeded from logo lavenders (#7B5EA7 / #E9B8DD) |
| Data | @tanstack/react-query (devtools as devDep) |
| Drag & drop | @dnd-kit/core (tracker kanban) |
| Icons | lucide-react |
| Toasts | sonner (shadcn toast) |
| Routing | ported in-house hash router as a React hook — no react-router. Routes: `#/triage`, `#/tracker`, `#/job/:id`, `#/analytics`, `#/onboarding` |
| Unit tests | vitest + React Testing Library (jsdom), colocated |
| E2E | @playwright/test in `ui/e2e/` |
| Lint/format | Biome scoped to the ui workspace (shadcn copy-ins are ours, so they're linted too) |

`ui:check` = `tsc --noEmit` + Biome (ui-scoped) + `vitest run`.

## Data layering convention (decided, uniform per feature)

```
*.tsx  →  use*.ts  →  *.queries.ts  →  *.api.ts  →  lib/api (fetch wrapper)
```

- `*.api.ts` — raw typed fetch functions per endpoint, built on the shared wrapper.
- `*.queries.ts` — TanStack queryOptions/mutations + the feature's query-key
  factory; cache-invalidation rules live here.
- `use*.ts` — data hooks (useQuery/useMutation wrappers) exposing feature-shaped
  data and actions.
- `*.tsx` — components consume hooks only; never import `*.queries.ts` or
  `*.api.ts` directly.

Enforced by convention and review for v1 (root dependency-cruiser stays scoped
to `src/**`).

## Workspace structure

```
ui/src/
  components/ui/        # shadcn copy-ins (button, card, dialog, select, …)
  lib/                  # router hook, api fetch wrapper, utils (ported + tests)
  features/
    shell/              # Sidebar (logo+title+version), ProfileSwitcher, layout
    triage/             # split-pane: JobList, JobDetailPane, decide bar, keyboard
    tracker/            # kanban: Board, Column, Card, DueStrip
    job/                # full-page detail (shares detail components with triage)
    analytics/          # ported
    onboarding/         # ported
ui/e2e/                 # Playwright smoke suite + global setup
```

## Views

### Shell

- Sidebar: `assets/job-bunny-logo.svg` at 24px + "Job Bunny" title + running
  server version underneath (from `GET /api/app`); nav Triage / Tracker /
  Analytics / Onboarding; profile switcher (shadcn Select) pinned at the bottom.
  Selected profile persists to localStorage (ported behavior).
- Hash routes are deep-linkable and survive reload.

### Triage (`#/triage`) — primary, split-pane

- Left pane: ranked job list, information-dense rows (title, company, rank badge,
  location/salary line, status dot). Top bar: undecided count, sort control,
  filter popover (ports current FilterBar semantics). Plain scroll, no
  virtualization at current volumes.
- Right pane: persistent detail — header (title/company/rank/links), structured
  fields, JD text, decide bar (Apply / Skip / Save), tracking form (status,
  excitement, notes, dates) in a collapsible section.
- Keyboard: `j/k` or `↑/↓` move selection; `a/x/s` decide and auto-advance to the
  next undecided job; `Enter` opens full-page detail; `/` focuses search.
- Decisions are optimistic mutations — instant UI, rollback + toast on failure.

### Tracker (`#/tracker`) — kanban + due strip

- Columns derive from the status vocabulary (`GET /api/profiles/:name/meta`),
  excluding the initial "new/undecided" status (that is Triage's domain).
  Terminal statuses (rejected/withdrawn/closed-type) collapse into a single
  "Closed" column, collapsed by default.
- Cards: company, role, key date, next action. Drag between columns (dnd-kit)
  issues the same tracking PATCH mutation; click-change remains available.
- Due strip pinned on top: items whose `nextActionDate` is due today or overdue;
  clicking one focuses/opens its card.

### Full-page job detail (`#/job/:id`)

- Same detail components as the triage right pane with room to breathe:
  two-column layout (JD prose | structured facts + tracking panel). Back returns
  to the originating view with selection preserved.

### Analytics & Onboarding

- Straight ports restyled with shadcn primitives. No new functionality.

## Server-side addition (the only `src/` change)

- `GET /api/app` → `{ version }`, read from the root `package.json` at server
  start. Rationale: the sidebar shows the *running* server's version — truthful
  even if `ui/dist` is stale. (The release flow bumps only the root version;
  `ui/package.json`'s version is meaningless and stays unbumped.)
- Board server keeps binding 127.0.0.1 and writing only the `tracking` table.

## Data flow

- One `QueryClient`; profile-scoped query keys: `['app']`, `['profiles']`,
  `[profile, 'meta']`, `[profile, 'jobs', filters]`, `[profile, 'job', id]`.
  Profile switch = key switch; each profile keeps its own warm cache.
- Tracking PATCH is the only mutation: optimistic write into job-detail and
  job-list caches; invalidate tracker/due-strip queries on settle; rollback on
  failure.

## Error handling

- `lib/api` normalizes failures into a typed `ApiError` (HTTP status + server
  error code). Three distinct UI states:
  - **Server unreachable** — full-screen state with retry, never a white page.
  - **`no_local_db` (404)** — friendly empty state (pure-Notion or DB-less
    profiles), not an error.
  - **Mutation failure** — sonner toast + optimistic rollback.

## Testing

### Unit/component (vitest + RTL, colocated)

- Ported logic keeps its tests (router, api client, tracking helpers).
- New coverage on judgment-bearing pieces: keyboard triage reducer
  (move/decide/advance), due-strip date logic, query-key + invalidation map,
  kanban status-move handler.

### E2E (critical-path smoke, `ui/e2e/`)

- Global setup: seed a fresh rajni sqlite DB (`profiles/rajni/data/`, already
  gitignored) with ~10 deterministic fixture jobs via the sqlite connector —
  no Notion calls ever (rajni's `profile.json` holds a real Notion dbId; e2e
  must never touch Notion) — then boot `jobbunny board` on an ephemeral port
  serving the built `ui/dist`. Each run reseeds; tests are deterministic.
- Smoke tests (~8): board loads with seeded jobs; sidebar shows logo + version;
  filter narrows the list; j/k moves selection; `a` applies → persists after
  reload; tracker shows the card in the correct column; moving a card updates
  status; full-page detail opens and back preserves selection.

### CI

- The ubuntu-only `ui` job extends: `ui:check` → `ui:build` →
  `npx playwright install chromium` (cached) → e2e run.
- The 3-OS `check` matrix and the protected `test` wrapper job name are
  untouched.

## Rollout sketch (detail belongs to the implementation plan)

1. Scaffold: Vite+React+Tailwind+shadcn, shell + sidebar branding, `/api/app`.
2. Views: triage split-pane, tracker kanban, full-page detail, analytics +
   onboarding ports; delete Svelte files.
3. E2E suite + CI wiring.

Land via PR(s) on a feature branch; `main` is protected and requires the `test`
check.

## Housekeeping

- Add `.superpowers/` to `.gitignore` (visual-companion session artifacts).
