# File-size caps — design (2026-07-28)

## Problem

Several files have grown past the point where they can be sampled — you must read them end to end to check one piece of logic. Worst offenders: `src/adapters/lanes/linkedin/lane.ts` (1173 lines), `src/adapters/lanes/linkedin/lane.test.ts` (2956), `src/cli/wire.ts` (772), `src/cli/commands/release.ts` (705). Nothing in the toolchain enforces file size: Biome only sets line width, dependency-cruiser only checks import direction. Meanwhile 114 of 127 implementation files are already under 300 lines — the codebase's natural grain is small files; the rule codifies that grain and stops outliers.

## The rule

- Implementation `.ts` files: **≤ 400 lines**.
- `.test.ts` files: **≤ 800 lines**.

Rationale: a file you cannot skim is a file that is doing too much. The cap is a modularity forcing function, not a style preference — hitting it means the module has grown a second responsibility and needs a seam, per the existing two-pair rule.

**Where the prose lives:** `.claude/agents/executor.md` only — the executor agent writes all code in this repo, so it carries the rule and its rationale. `CLAUDE.md` is not edited; the mechanical gate is part of `npm run check`, which CLAUDE.md already documents.

## The gate

The gate is an invariant test, `test/invariants/filesize.test.ts` — the repo's established home for cross-cutting invariants (`scripts/` is a dead v0 path and is never used). It walks `src/**/*.ts`, counts lines with `wc -l` semantics, and fails listing every over-cap file. It runs inside `npm test` — and therefore `npm run check` — automatically; `npm run filesize` runs it alone. End state: **empty pin list** — the check passes because nothing is over cap.

During the refactor sequence only, the test carries a *temporary pin list*: each current offender pinned at its exact current line count, so growth fails immediately while splits proceed. The pin list is deleted entirely in the final PR — it is scaffolding, not a permanent exemption mechanism.

## Sequencing (multi-PR; `main` is protected)

1. **PR 1** — the invariant gate test + `npm run filesize` + the rule prose added to `.claude/agents/executor.md`. Pin list holds current offenders at current sizes. Lands green; stops the bleeding.
2. **PRs 2–N** — split the offenders, biggest first, removing pins as they go. Pure code motion, no behavior change; existing tests are the safety net. Order: `lane.ts` + `lane.test.ts` together, then `wire.ts` (with `wire.test.ts`), `release.ts`, `provider.ts` (with `provider.test.ts`), then the five remaining files (`serve.ts` 513, `launcher.ts` 447, `aggregate.ts` 439, `source.ts` 427, `rank.ts` 407).
3. **Final PR** — delete the pin-list machinery; the check becomes cap-only with no exemptions.

## wire.ts split (decided)

`cli/wire.ts` becomes a `cli/wire/` module folder. The dependency-cruiser rule `only-wire-imports-adapters` is updated to match the folder path. The config-resolver helpers (`resolveJitterRange`, `resolveInterUrlDelayRange`, `resolveMaxCardsPerUrl`, `resolveMaxNewPerLane`, `resolveInventoryMaxAgeDays`, config loaders) move to sibling files inside the folder; `wire()` itself remains the only place that imports adapter constructors. CLAUDE.md's description of wire as "the only adapter-instantiation point" stays true at folder granularity.

## Acceptance criteria for every split PR

- All resulting files under their caps.
- `npm run check` green (typecheck + lint + boundaries + tests; CI runs it on 3 OSes).
- Tests stay colocated with the code they test.
- Module `index.ts` public surfaces unchanged for consumers.
- Two-pair rule respected: a folder exceeding two implementation files splits into subfolders.
- No behavior change — code motion only.
- Per-file placement is proposed by the executor agent at implementation time; this spec sets constraints, not filenames.

## Out of scope

- Markdown/docs file sizes (specs and plans are historical records).
- Cyclomatic-complexity or per-function limits.
- Any behavior or feature change in the files being split.
