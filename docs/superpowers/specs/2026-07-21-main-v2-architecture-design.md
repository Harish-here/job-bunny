# Job Bunny v2 — Architecture Design

Date: 2026-07-21 · Branch: `main-v2` · Status: approved (brainstorm complete)
Decision log: [`main-v2.md`](../../../main-v2.md) — the living, numbered record;
this spec is the consolidated narrative. If they ever disagree, fix both in the
same change.

## 1. Context & goals

Job Bunny v0 (on `main`) works but grew organically: five subtly different job
shapes between stages, filter logic split across three files, per-lane state in
ad-hoc files, platform code hardcoded, and operational contracts living in
slash-command markdown. v2 is a **clean-room rewrite**: re-derive the
architecture from scratch, port implementation know-how (selectors, CDP
handling, Notion schema quirks) by *reading* v0, never copying its structure.

Goals:

- One universal JD schema every module consumes, enforced at compile time.
- Strict separation of concerns: pure core, interface ports, swappable
  adapters — adding Google Sheets or Instahyre is one new folder.
- Every module unit-testable in isolation; no flat file lists.
- v0 keeps running daily on `main` until v2 reaches parity; then cut over.

Non-goals: multi-user SaaS, Linux/Docker implementations (seams only),
plugin loading, any speculative abstraction without a second concrete caller.

## 2. Tech stack

- **Node ≥ 24 LTS** — native TS type-stripping; zero build step, run `.ts`
  directly. Bun rejected: Playwright unofficial there, and its wins don't
  land on a network/browser-bound pipeline.
- **TypeScript 7** (native compiler), `--noEmit` typecheck, strict, ESM,
  erasable-syntax-only (plain types/unions; no enums, namespaces, parameter
  properties).
- **zod v4** — every schema defined once; TS types inferred from it.
- **Runtime deps: exactly three** — `playwright`, `@notionhq/client`, `zod`.
  Telegram via `fetch`; `.env` via `process.loadEnvFile()`; CLI via
  `node:util` parseArgs; tests via `node:test` + `node:assert`, colocated
  `*.test.ts`.
- **Biome** for lint/format. **dependency-cruiser** (dev-only) enforces the
  one-way dependency rule in CI.
- **CI**: GitHub Actions `test` check = typecheck + tests + biome +
  depcruise. `main-v2` is the integration branch; work lands via PRs.
- **`AbortSignal.timeout()` / `AbortSignal.any()`** is the standard deadline
  mechanism; every CDP/network call is deadline-bound.

## 3. Architecture: hexagonal-lite

```
src/
  core/                      # pure logic — no I/O, no env, no mocks needed
    jd/                      #   universal JD schema + text normalizer
    filter/                  #   filter engine (rules/, config schema)
    rank/  dedup/            #   scorer; id+repost dedup
    company/                 #   company registry model + transitions
    profile/                 #   profile & resume/skills schemas, seeding
    config/                  #   pipeline config schema (what's enabled)
    errors/                  #   error taxonomy (SoftError et al.)
  ports/                     # TS interfaces only
    connector.ts  lane.ts  notifier.ts  llm.ts
    browser.ts  scheduler.ts  storage.ts
  adapters/                  # implementations, grouped by port family
    db/notion/               #   (db/sheets/ is a future sibling)
    notify/telegram/
    lanes/linkedin/  lanes/greenhouse/  lanes/keka/
    browser/cdp-chrome/
    llm/claude-cli/
    scheduler/launchd/
  pipeline/
    stages/                  # farm, source, compress, structure, assemble,
                             # filter, dedup, rank, sync
    runner/                  # orchestrator, checkpoints, watchdog
  routines/
    cleanup/                 # first routine; archive stale DB records
  ops/
    doctor/  observability/
  cli/                       # `jobbunny` entry + wire.ts (the only
                             # config-string → adapter-constructor mapping)
```

**Coding principles** (mechanically enforced where possible; also recorded in
`main-v2.md` for agents):

1. **One-way dependencies** (depcruise-enforced):
   `cli → pipeline/routines/ops → ports + core`; `adapters → ports + core`.
   `core` imports nothing from other layers; adapters never import each
   other; pipeline never names a concrete adapter.
2. **Config is the wiring.** `core/config` defines what can be enabled;
   `cli/wire.ts` is the only file that instantiates adapters from config.
3. **Two-pair rule.** A module folder holding more than two implementation
   files (main + test pairs, `index.ts` excluded) splits into subfolders.
4. **Core owns shapes and logic; profiles own values.** Nothing
   profile-specific in `src/`; per-profile data under `profiles/<p>/`.
5. **Docs are code.** `main-v2.md` and module contracts update in the same
   change that alters behavior.

**Routines** are first-class recurring maintenance:
`{ name, when: 'pre-run' | 'post-sync' | 'standalone', run(ctx) }`, enabled
per profile, executed by the runner at declared points or via
`jobbunny routine <name>`. First routine: `cleanup` (archive Passed jobs
older than N days and stale untouched leads on the connector DB).

## 4. The universal JD model

One zod schema in `core/jd`, filled progressively; the only definition of a
job in the codebase:

```ts
JD = {
  identity:    { id, lane, url, company, title, postedAt?, scrapedAt }  // lane
  content?:    { rawText }                                              // fetch
  structured?: { titleParts: { domain, seniority, func },               // LLM
                 locations[], workType, timezone?, skills[], salary? }
  evaluation?: { verdicts[], duplicateOf?, score, excitement,           // filter/
                 matchReasons[] }                                       // dedup/rank
  sync?:       { pageId, syncedAt }                                     // connector
}
```

- Stage signatures require their inputs at compile time:
  `structure: (jd: JD & {content}) => JD & {structured}` — mis-ordered
  wiring fails typecheck.
- zod re-validates only at ingress boundaries: lane output (scraped/API
  data), LLM output (assemble), connector reads. Internal stage handoffs
  trust TS.
- **Verdicts, not silent drops**: filter writes
  `verdicts[] { rule, severity: 'hard' | 'soft', pass, detail }`. Hard fail
  ⇒ dropped but recorded with reasons; soft fail ⇒ kept, costs rank points,
  reason surfaces in matchReasons.

**Pipeline flow:**

```
farm (linkedin) ──┐  card gate: evaluateCard (avoid + title rules)
                  │  BEFORE JD open — token/browser economy
register ─────────┤  companiesSeen[] → company registry upsert
probe/fetch (api lanes: greenhouse, keka) ──→ more JDs
compress   JD[] → compact markdown table        (token invariant kept)
structure  llm port normalises → decisions md
assemble   decisions + passthrough → JD{+structured}   (zod ingress)
filter     evaluate() → verdicts; hard-fails recorded then dropped
dedup      vs connector-rebuilt cache + intra-run; repost detection
rank       100-pt score, excitement, matchReasons
sync       connector writes automated fields only       → JD{+sync}
```

**Checkpoints:** after every stage the runner writes
`profiles/<p>/data/runs/<date>/NN-<stage>.json` (kept JDs + dropped records
with verdicts). Any stage re-runnable from the previous checkpoint
(`jobbunny stage <name>`); same-day reruns resume after the last completed
checkpoint.

## 5. Company registry (farming → API lanes)

`core/company` model, persisted via the storage port at
`profiles/<p>/data/registry/companies.json`:

```ts
CompanyRecord = {
  name, normalizedKey, firstSeen, lastSeen, seenBy: lane[],
  probes: { [apiLane]: { status: 'unprobed' | 'found' | 'not-found' | 'error',
                         boardRef?, probedAt, failCount } },
  curated?: boolean          // user-added; flagged when stale, never expires
}
```

Flow per run: farming lanes emit `companiesSeen[]` (avoid-listed companies
excluded by the card gate) → runner upserts registry → the **generic
probe/fetch loop** (`pipeline/stages/source.ts`, v0's `ats_common` promoted)
drives every `ApiLane`. Validation loops, all living in the registry:

- Re-probe `not-found` after a TTL (companies adopt ATSes); `error` retries
  with capped `failCount`.
- A `found` board failing N consecutive fetches → `stale`: skipped, surfaced
  by doctor.
- Every probe/fetch response zod-parsed; fail-soft per company/board.

Lane port flavors — a third ATS is one new adapter, nothing else:

```ts
FarmingLane: { kind: 'farming', source(ctx): { jobs: JD[], companiesSeen: string[] } }
ApiLane:     { kind: 'api',     probe(company): ProbeResult, fetchBoard(ref): JD[] }
```

Curated watchlists (v0's board md files) fold into the registry as
`curated: true` records.

## 6. Filter engine

One pure engine in `core/filter`; config values are per-profile data
(`profiles/<p>/filter.json`, zod-validated). Rules are one file each behind
one interface (`{ name, appliesTo, eval(jd, config) → Verdict }`):

- `title` — domain / function `match` lists; seniority `match` + `reject`
  (reject beats match)
- `company` — avoid list (always hard); applied at card level and before
  probes
- `location` — `locations[]` is the **only** geo authority (per-city
  `workTypes`; `city: "*"` = anywhere-remote). v0's resume-location fallback
  is dead.
- `timezone` — accepted zones for remote roles
- `skills` — core-skill minMatch, seeded from the profile

Semantics: case-insensitive, token-normalized matching (normalizer in
`core/jd`); synonyms live in config, never code; an absent config section
means that rule doesn't run; **severity is per-rule config** (`hard` drop vs
`soft` rank-down), so profiles can differ with zero code change.

Two entry points over the same rules: `evaluateCard` (card-level subset —
kills work before JD-open/probe) and `evaluate` (full, post-structure,
deterministic). `decide(verdicts) → keep | drop` (drop ⇔ any hard fail).

**Profile seeding** (upstream producer, `core/profile`): setup one-time
resume.pdf → LLM → `resume.json` (hand-maintained after);
`jobbunny profile build` classifies skills primary/secondary → seeds
`filter.json` `skills.core` and rank weights. **Seeding fills, never
clobbers** — re-runs propose a diff against user-tuned values.

## 7. Runner, observability, errors

Runner (`pipeline/runner`) is the only process; headless and interactive
share it. Stage contract:

```ts
StageDef<In, Out> = { name, run(input, ctx): Promise<Out>,
                      timeout, retries, heartbeat? }
ctx = { profile, config, ports, logger, beat(), notify(), signal }
```

- **Watchdog, three layers inside the runner**: per-stage timeout →
  heartbeat stall detection (heartbeat-declaring stages killed when `beat()`
  goes silent past the stall window) → global run cap. `signal` threads into
  every adapter.
- **Errors**: `core/errors` — `SoftError` (one URL/company/board: recorded,
  run continues; breadth survives) vs everything else ⇒ stage fails loudly
  and writes `runs/<date>/failure.json` (stage, error, elapsed, last
  checkpoint).
- **Run folder** `profiles/<p>/data/runs/<date>/`: `run.log` (JSON-lines,
  human mirror on stdout when interactive), `heartbeat.json` (rewritten
  every beat), `NN-<stage>.json` checkpoints, `result.json` (outcome,
  per-stage timings, funnel: jobs in/out per stage, drops by verdict rule).
- **Runner is the single digest sender** — success and failure, built from
  `result.json` at run end; `ctx.notify()` for rare urgent mid-run events.
  No double-notify, no headless guard.
- **Scheduling**: launchd adapter installs jobs calling
  `jobbunny run --profile <p> --headless`; profiles strictly sequential
  (shared Chrome); shell wrapper keeps only a coarse backstop timeout.
- **Doctor**: each adapter contributes its own preflight checks; includes
  page-inventory freshness (inventory older than configured max age ⇒
  warn/red before burning a browser session).

## 8. Command surface

One `jobbunny` CLI: `run`, `doctor`, `reconcile`, `setup` (+ `setup
notify`), `stage <name>`, `routine <name>`, `schedule install`,
`lane add-url`, `profile build|remove`. Slash commands survive only where an
LLM agent is genuinely in the loop — **keep**: `/setup`, `/page-analyse`,
`/structure` (interactive fallback), `/wrap`, `/verify` (all rewritten for
v2). **Delete** the other 16 (run/doctor/reconcile/cleanup/schedule/
notify-setup/add-url/update-resume/remove-profile + 7 per-stage) — replaced
by the CLI.

## 9. Build order

Nine phases, each its own spec → plan → implement cycle on `main-v2`; every
phase ends green (tests, docs updated, rajni-fixture verify once the runner
exists). v0 runs daily on `main` throughout.

| # | Phase | Delivers |
|---|-------|----------|
| P1 | Skeleton + contracts | toolchain, tree, `core/jd|config|profile` schemas, all ports, errors, CI |
| P2 | Filter engine | `core/filter` complete, validated against v0 run-data snapshots |
| P3 | Runner + observability | StageDef, checkpoints, watchdog, run folder, funnel — tested with fake stages |
| P4 | Browser + LinkedIn lane | cdp-chrome adapter, farming lane, inventories, card gate, per-URL resume, inventory-freshness check. **Highest risk — done early** |
| P5 | Registry + API lanes | `core/company`, generic probe/fetch loop, greenhouse + keka, board-health loops |
| P6 | LLM + structure path | llm port + claude-cli adapter, compress/structure/assemble |
| P7 | Notion connector + tail | `db/notion` (byte-exact schema, sync, cache rebuild), dedup, rank, cleanup routine |
| P8 | Surface + cutover | CLI + wire.ts, doctor aggregation, telegram, launchd, setup/profile-build; **parity + migration** |
| P9 | v0 retirement | delete `scripts/` + 16 commands + dead config/plists; rewrite CLAUDE.md and README from scratch; prune branches; `main-v2` becomes `main` |

P5 and P6 are independent after P4 and may run in parallel.

**Parity & cutover (P8):** config migrator (v0 `filter_config.json` /
`avoid.md` / board md files → `filter.json` + registry); v2 side-by-side
with v0 for a few days, sync in dry-run, diffing v2's would-write set
against v0's actual Notion writes; cutover = flip launchd; v0 kept one week
as rollback before P9 deletes it.

## 10. Testing strategy

- Core: plain-fixture unit tests, no mocks (pure functions).
- Adapters: unit tests with recorded/synthetic payloads behind the port
  interface; zod ingress schemas double as living documentation of external
  APIs. Tests never launch a browser.
- Runner: fake in-memory stages exercising timeout/stall/retry/checkpoint
  paths.
- Runtime verification: `profiles/rajni/` fixture (synthetic data, schedule
  disabled, no Notion IDs) — never real profiles.
- Filter engine additionally replay-tested against snapshots of real v0 run
  outputs during P2 to catch semantic regressions before cutover.

## 11. Risks

- **LinkedIn DOM/anti-bot drift during the rewrite window** — inventories
  stay config-driven and regenerable via `/page-analyse`; P4 early keeps
  this risk in the cheap half of the project.
- **TS 7 / Node 24 type-stripping edges** — erasable-syntax-only rule avoids
  the known holes; fallback is dropping to `tsc` 5.x checking without any
  code change.
- **Parity gaps found late** — mitigated by the P8 dry-run diff and by
  replay-testing filter (P2) against real v0 outputs.
- **Scope creep per phase** — each phase has its own spec with explicit
  non-goals; YAGNI rules in §1 apply to every phase spec.
