# main-v2 — Locked Architecture Decisions

Living document for the v2 clean-room rewrite. Each entry is a decision we have
locked; agents read this (not the code) to understand the architecture on
demand. Update it whenever a new decision locks — never let it drift from what
is being implemented.

Status: brainstorming in progress. Sections marked ⏳ are not yet designed.

## Locked decisions

1. **Language: TypeScript.** The universal JD schema is a compile-time
   contract. Runtime validation at ingress boundaries with zod; TS types are
   inferred from the zod schemas (single source of truth).
2. **Strategy: clean-room rewrite** on branch `main-v2`, fresh `src/` tree.
   Port implementation know-how (selectors, CDP handling, Notion schema
   quirks) by reading v0 code, never by copying its structure. v0 on `main`
   keeps running daily until v2 reaches parity, then cut over.
3. **Pipeline model: in-process + checkpoints.** Stages are typed functions
   composed by one runner in one process. After each stage the runner persists
   a checkpoint file, preserving resumability and post-mortem debugging.
   Every stage also runnable standalone via the CLI.
4. **LLM stage: provider module.** `ports/llm.ts` interface; first adapter
   wraps `claude -p` (zero API key). An Anthropic API provider can be added
   later behind the same interface.
5. **Platform: macOS now, Linux-ready.** All platform-specific code lives in
   adapter folders (`scheduler/launchd`, `browser/cdp-chrome`). No speculative
   Linux code — just clean seams so cron/systemd is a drop-in sibling later.
6. **Command surface: one `jobbunny` CLI** (`run`, `doctor`, `setup`,
   `stage <name>`, `routine <name>`, …). Slash commands become thin wrappers;
   they exist only where LLM interactivity genuinely matters
   (/setup wizard, /page-analyse, /structure fallback).
7. **Architecture: hexagonal-lite.** Pure `core/` (no I/O) + `ports/`
   (TS interfaces) + `adapters/` (implementations grouped by port family:
   `db/notion`, `db/sheets`, `notify/telegram`, `lanes/*`, `llm/*`,
   `browser/*`, `scheduler/*`) + `pipeline/` (stages + runner) + `routines/`
   + `ops/` (doctor, observability) + `cli/`.
8. **Routines are first-class.** A routine is
   `{ name, when: 'pre-run' | 'post-sync' | 'standalone', run(ctx) }` —
   recurring maintenance executed at declared pipeline points. First routine:
   `cleanup` (archive Passed jobs older than N days, stale untouched leads).
9. **Doctor includes page-inventory freshness.** Preflight verifies every
   enabled farming lane's page inventory exists and is not expired (older
   than a configured max age ⇒ warn/red before the run burns a browser
   session on stale selectors). Each adapter contributes its own doctor
   checks.

## Coding principles (agents: read before any implementation)

- **Dependency direction is one-way.**
  `cli → pipeline / routines / ops → ports + core`, and
  `adapters → ports + core`. `core/` imports nothing from other layers.
  Adapters never import each other. Pipeline code never names a concrete
  adapter ("Notion", "LinkedIn") — it only sees `Connector`, `Lane[]`, etc.
- **Config is the wiring.** `core/config` defines the schema of what is
  enabled (lanes, connector, notifiers, routines) per profile. Exactly one
  composition file (`cli/wire.ts`) maps config strings → adapter
  constructors. Nothing else instantiates adapters.
- **Every module is unit-testable in isolation**; core needs no mocks at all.
  Colocated tests (`foo.ts` + `foo.test.ts`).
- **No flat file lists — the two-pair rule.** Every module is a folder with an
  `index.ts` public surface; internals are not imported across module
  boundaries. When a folder grows beyond **two implementation files**
  (main + test pairs, `index.ts` excluded), split it into subfolders by
  responsibility before adding the third.
- **Architecture docs are code.** This file and the per-module contracts must
  be updated in the same change that alters behavior.

10. **One universal JD schema** (`core/jd`, zod-defined, TS type inferred),
    filled progressively: `identity` (lane) → `content` (fetch) →
    `structured` (LLM) → `evaluation` (filter/dedup/rank) → `sync`
    (connector). Stage signatures require their input sections at compile
    time. Zod re-validates only at ingress boundaries: lane output, LLM
    output (assemble), connector reads.
11. **Verdicts, not silent drops.** Filter writes
    `evaluation.verdicts[] { rule, severity: hard|soft, pass, detail }`.
    Hard fails drop but are recorded in the checkpoint with reasons; soft
    fails survive and cost rank points.
12. **Uniform checkpoints.** After every stage the runner writes
    `profiles/<p>/data/runs/<date>/NN-<stage>.json` (kept JDs + dropped
    records with verdicts). Any stage re-runnable from the previous
    checkpoint; crashed runs resume from the last one.
13. **Avoid-list lives in the filter module** — it is filter config
    (`companies.avoid`), not a standalone stage. The filter engine exposes a
    company-level predicate applied at card level in farming lanes (before a
    JD is opened) and before API-lane probes.

14. **Company registry** (`core/company/` model, persisted via storage port at
    `profiles/<p>/data/registry/companies.json`): one record per company with
    per-API-lane probe state
    (`unprobed | found(boardRef) | not-found | error`, `probedAt`,
    `failCount`, `curated`). Farming lanes emit `companiesSeen[]`; the runner
    upserts the registry; a generic probe/fetch loop
    (`pipeline/stages/source.ts`) drives any `ApiLane`. Loops: re-probe
    `not-found` after TTL; `error` retries with capped failCount; `found`
    boards failing N consecutive fetches → `stale` (doctor surfaces them;
    curated boards flag but never auto-expire). All probe/fetch responses
    zod-parsed; fail-soft per company/board.
15. **Lane port has two flavors.**
    `FarmingLane.source(ctx) → { jobs, companiesSeen }` and
    `ApiLane.probe(company) / fetchBoard(ref)`. A third ATS = one new ApiLane
    adapter; the shared loop does the rest. Curated watchlists fold into the
    registry (`curated: true`) — no parallel board files.

16. **Filter engine: one pure engine in `core/filter`, config data per
    profile** (`profiles/<p>/filter.json`, zod-validated against the schema
    core defines). Rules are one-file-each
    (`title` domain/function/seniority, `company` avoid, `location`,
    `timezone`, `skills`) behind one interface; match/reject lists are data,
    `reject` beats `match`, absent config section ⇒ rule doesn't run.
    Matching is case-insensitive and token-normalized; synonyms live in
    config, never code. Two entry points over the same rules:
    `evaluateCard` (card-level subset — kills work before JD-open and before
    company probes) and `evaluate` (full, post-structure, deterministic).
    Replaces v0's title_filter/jd_filter/avoid split; `filter.json`
    `locations[]` is the only geo authority (resume location is dead).
17. **Severity is per-rule config.** `hard` fail ⇒ drop (recorded);
    `soft` fail ⇒ keep, costs rank points, reason surfaces in
    match_reasons. Same rule can be hard for one profile, soft for another.
18. **Profile module produces config; filter only consumes it.**
    Setup (one-time): resume.pdf → LLM → resume.json (hand-maintained
    after). `jobbunny profile build`: resume.json → skills classified
    primary/secondary → seeds `filter.json` skills.core and rank weights.
    Seeding fills gaps, never clobbers user-tuned values — re-runs propose a
    diff.

19. **One generic stage descriptor.**
    `StageDef = { name, run(input, ctx), timeout, retries, heartbeat? }`;
    `ctx = { profile, config, ports, logger, beat(), notify(), signal }`.
    The runner is generic over StageDef; watchdog is three layers inside it:
    per-stage timeout → heartbeat stall detection (heartbeat stages killed
    when `beat()` goes silent) → global run cap. `signal` (AbortSignal)
    threads into every adapter; every CDP/network call stays deadline-bound.
20. **Error taxonomy makes fail-soft a type.** `core/errors`: `SoftError`
    (one URL / company / board — recorded, run continues; breadth survives)
    vs everything else ⇒ stage fails loudly. Failed stages write
    `runs/<date>/failure.json` (stage, error, elapsed, last checkpoint).
21. **Run folder is the observability surface.**
    `profiles/<p>/data/runs/<date>/`: `run.log` (JSON-lines), 
    `heartbeat.json` (rewritten every beat), `NN-<stage>.json` checkpoints
    (double as same-day resume points), `result.json` (outcome, per-stage
    timings, funnel: jobs in/out per stage + drops grouped by verdict rule).
22. **Runner is the single notifier.** Success and failure digests both
    built from `result.json` at run end — no double-notify, no headless
    guard. `ctx.notify()` for rare urgent mid-run events (login expired),
    same notifier port. Scheduler adapters stay thin: launchd job calls
    `jobbunny run --profile <p> --headless`, profiles strictly sequential
    (shared Chrome); shell keeps only a coarse backstop timeout.

23. **Build order: nine phases**, each its own spec → plan → implement cycle
    on `main-v2`; every phase ends green (tests + docs updated + rajni
    fixture verify once the runner exists). v0 keeps running on `main`
    throughout.
    P1 skeleton+contracts (tree, core schemas, ports, errors) →
    P2 filter engine → P3 runner+observability → P4 browser+LinkedIn lane
    (highest risk, done early) → P5 company registry + API lanes →
    P6 LLM + compress/structure/assemble → P7 Notion connector +
    dedup/rank/cleanup routine → P8 CLI + wiring + doctor + telegram +
    launchd + setup, then **parity run** (config migrator; v2 side-by-side
    vs v0 with sync dry-run, diffing would-write sets; cutover = flip
    launchd; v0 kept one week as rollback) → P9 v0 retirement (below).
    P5 and P6 are independent after P4 and may run in parallel.
24. **P9 — v0 retirement + docs ground-up.** Delete `scripts/`, replaced
    `.claude/commands/*`, dead config files and old plists; prune stale
    branches; `main-v2` becomes `main`. Rewrite CLAUDE.md **from scratch**
    for v2 (pointing agents at main-v2.md + module contracts) and README.md
    ground-up. Slash-command fate: **keep** `/setup`, `/page-analyse`,
    `/structure` (interactive fallback), `/wrap`, `/verify` — all rewritten
    for v2; **delete** `/run`, `/doctor`, `/reconcile`, `/cleanup`,
    `/schedule`, `/notify-setup`, `/add-url`, `/update-resume`,
    `/remove-profile`, and every per-stage command — replaced by
    `jobbunny run | doctor | reconcile | routine cleanup | schedule |
    setup notify | lane add-url | profile build | profile remove |
    stage <name>`.
25. **Tech stack.** Node ≥ 24 LTS (native type-stripping — zero build step);
    TypeScript 7 (native compiler) `--noEmit` typecheck, strict, ESM,
    erasable-syntax-only (no enums/namespaces); zod for schemas; playwright
    + @notionhq/client + zod as the **only** runtime deps (Telegram via
    fetch, `.env` via `process.loadEnvFile()`, CLI via `node:util`
    parseArgs, tests via `node:test`); Biome lint/format;
    dependency-cruiser (dev) enforces the one-way dependency rule in CI;
    GitHub Actions `test` check = typecheck + tests + biome + depcruise.
    `AbortSignal.timeout()` / `AbortSignal.any()` is the standard deadline
    mechanism everywhere. **Bun evaluated and rejected**: Playwright is
    unofficial on Bun (unacceptable under the highest-risk module) and Bun's
    wins (startup, bundling, TS exec) don't land on a network/browser-bound
    pipeline — revisit only if Playwright gains official Bun support.

## Design sections

- ✅ Section 1: source tree & module boundaries (decisions 7–9 above)
- ✅ Section 2: JD data model & stage data flow (decisions 10–13)
- ✅ Section 2b: company registry — farming → API-lane flow (decisions 14–15)
- ✅ Section 3: filter engine + profile seeding (decisions 16–18)
- ✅ Section 4: runner, observability, error handling (decisions 19–22)
- ✅ Section 5: build order, stack, retirement (decisions 23–25)

Brainstorm complete — full consolidated spec:
`docs/superpowers/specs/2026-07-21-main-v2-architecture-design.md`
