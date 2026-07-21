# v2 P9 — v0 Retirement + Docs Ground-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (mostly mechanical; review gates are the deletion inventory and the two rewritten docs).
> **Depends on:** P8 cutover complete **and** ≥7 days of green scheduled v2 runs (check `main-v2.md` soak start date + `last_run_result`/`result.json` history). Do not start early.

**Goal:** Delete v0 completely, rewrite CLAUDE.md and README.md from scratch for v2, prune branches, make `main-v2` the new `main`.

## Global Constraints

- Branch `chore/v2-retire-v0` off `main-v2`.
- **Deletion is by explicit inventory** (below) — nothing outside it; anything unexpected found during deletion gets surfaced, not silently removed.
- CLAUDE.md and README.md are **rewrites from scratch** (open a blank file), not edits — decision 24.
- Every step keeps `npm run check` green.

---

### Task 1: Soak gate check
- [ ] Verify ≥7 daily v2 runs since cutover, all `outcome: passed` (or failures explained + fixed). If not — stop, this phase waits.

### Task 2: Delete v0 code (the inventory)
- [ ] Delete: `scripts/` (entire tree — includes `scripts/ops/release.js`: port it to `src/cli/commands/release.ts` FIRST if `/wrap ship` is still wanted, decide with user), `scripts-v2-migrate/`, v0 launchd plists (`jobbunny schedule install` already replaced them — verify with `launchctl list | grep jobbunny` before deleting anything).
- [ ] Delete the 16 replaced commands from `.claude/commands/` (and skill mirrors): run, doctor, reconcile, cleanup, schedule, notify-setup, add-url, update-resume, remove-profile, extract, greenhouse, keka, filter, dedup, rank, sync. **Keep:** setup, page-analyse, structure, wrap, verify — rewrite each against v2 (wrap `jobbunny` commands / v2 paths).
- [ ] Delete per-profile v0 files after confirming migrator output is live: `filter_config.json`, `avoid.md`, `greenhouse_boards.md`, `keka_boards.md`, `resume_meta.json` (and `npm run meta` path). `search_urls.md` **stays** (still the lane's URL source). `page_inventory/*.md` deleted only where superseded by `<page>.json`.
- [ ] package.json: remove v0 scripts (`init|meta|reconcile|filter|dedup|rank|sync|release` as ported), remove `dotenv` dependency, verify `npm run check` green with `test: node --test src/`.

### Task 3: Rewrite CLAUDE.md from scratch
- [ ] Blank-file rewrite for v2 only: what Job Bunny is; commands (`jobbunny …`, `npm run check`); pointer to `main-v2.md` decision log + module contracts as the architecture source; the surviving hard rules restated for v2 (byte-exact Notion options, token-economy structure path, deadline-bound CDP, fail-soft taxonomy, seed-never-clobber, core purity + two-pair rule); profile layout; verify-on-rajni rule; PR gate. Keep it as tight as the v0 one — markdown is code.

### Task 4: Rewrite README.md from scratch
- [ ] Blank-file rewrite: what it is, install (Node 24, `npm ci`, `npx playwright install chromium`? — no: real Chrome via CDP, say so), `/setup` onboarding, `jobbunny` usage, scheduling, architecture one-pager linking the spec.

### Task 5: Branch + repo hygiene
- [ ] Delete merged/stale branches (list at execution time via `git branch --merged`; confirm each unmerged one with user before deletion).
- [ ] Make v2 the default: PR `main-v2` → `main` (or repoint default branch to `main-v2` then rename — pick with user based on protection rules), tag `v2.0.0` on merged HEAD via the release flow.
- [ ] Update `main-v2.md`: P9 ✅ — project complete; the file itself stays as the architecture decision record.
