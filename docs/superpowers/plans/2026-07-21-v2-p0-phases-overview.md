# v2 Phases Overview — Dependency Contracts

> Master map for the nine phase plans. Read this before executing any phase
> plan; it is the authority on what each phase may assume from its
> predecessors and what it must leave behind. Spec:
> `docs/superpowers/specs/2026-07-21-main-v2-architecture-design.md`.

## Dependency graph

```
P1 skeleton+contracts
 ├─→ P2 filter engine          (needs: JD types, Verdict, normalizeToken)
 ├─→ P3 runner+observability   (needs: ports/context, errors, Storage port)
 │    ├─→ P4 browser+linkedin  (needs: StageDef, RunContext.beat, DoctorCheck,
 │    │                         P2 evaluateCard)
 │    ├─→ P5 registry+api      (needs: companyKey, ApiLane, Storage impl,
 │    │                         StagePayload; INDEPENDENT of P4 — parallel OK)
 │    └─→ P6 llm+structure     (needs: LlmProvider, StageDef, SourcedJD;
 │                              INDEPENDENT of P4/P5 — parallel OK)
 │         └─→ P7 notion+tail  (needs: Connector port, StructuredJD, P2
 │                              severity verdicts for rank, P3 runner)
 │              └─→ P8 cli+cutover (needs: everything; wires it)
 │                   └─→ P9 retirement (needs: P8 cutover + 1-week soak)
```

Rules:

- A phase may import **only** what a predecessor's "Produces" contract lists
  (below and in each plan's Interfaces blocks). Anything else it needs from a
  neighbor is a gap — stop and update the contract in a reviewed commit, never
  improvise.
- Extending a `ports/*` file is allowed only via the explicit port-extension
  task inside a phase plan (P3 adds `ports/doctor.ts`; P4 extends
  `ports/browser.ts`). No silent port drift.
- P4∥P5∥P6 may run as parallel sessions after P3 merges; P5 and P6 must not
  touch `ports/browser.ts` (P4 owns it in that window).
- Every phase ends: `npm run check` green on `main-v2` via PR, `main-v2.md`
  Phase status updated, and (P3 onward) a rajni-fixture verify.

## Handoff contracts (exact names — the inter-phase API)

| Phase | Produces (frozen once merged) |
|---|---|
| P1 | `core/jd`: `JDSchema`, `JD`, `Verdict`, `WorkType`, staged types `SourcedJD/StructuredJD/EvaluatedJD/SyncedJD`, `normalizeToken`, `companyKey` · `core/config`: `PipelineConfigSchema` · `core/profile`: `ResumeSchema`, `SkillClassificationSchema` · `core/errors`: `SoftError`, `isSoftError` · `ports/*`: `RunContext`, `Logger`, `Connector`, `CacheEntry`, `ArchivePolicy`, `FarmingLane`, `ApiLane`, `Lane`, `ProbeResult`, `Notifier`, `NotifyEvent`, `LlmProvider`, `BrowserProvider`, `BrowserHandle`, `Scheduler`, `ScheduledJob`, `Storage` |
| P2 | `core/filter`: `FilterConfigSchema`, `FilterConfig`, `evaluate(jd: StructuredJD, cfg): Verdict[]`, `evaluateCard(card: CardInput, cfg): Verdict[]`, `decide(verdicts: Verdict[]): 'keep' \| 'drop'`, `CardInput` |
| P3 | `pipeline/runner`: `StageDef<In,Out>`, `StageContext`, `PipelineCtx`, `WiredPorts`, `StagePayload`, `DroppedRecord`, `runPipeline`, `FsStorage` · `ops/observability`: `RunFolder`, `JsonlLogger`, `RunResultSchema` · new port `ports/doctor.ts`: `DoctorCheck` |
| P4 | `adapters/browser/cdp-chrome`: `CdpChromeProvider` · extended `ports/browser.ts` (adds `BrowserHandle.newPage(): Promise<PageHandle>` + `PageHandle` ops) · `adapters/lanes/linkedin`: `LinkedInLane implements FarmingLane` · v2 page-inventory schema `InventorySchema` + freshness `DoctorCheck` |
| P5 | `core/company`: `CompanyRecordSchema`, `CompanyRegistry` (pure fns: `upsertSeen`, `probeCandidates`, `recordProbe`, `recordFetchFailure`, `boardsToFetch`) · `pipeline/stages/source.ts`: `makeSourceStage(apiLanes)` · `adapters/lanes/greenhouse`, `adapters/lanes/keka` |
| P6 | `adapters/llm/claude-cli`: `ClaudeCliProvider` · `pipeline/stages`: `compressStage` (JD[]→md table), `makeStructureStage(llm)` (md→decisions md via `LlmProvider`), `assembleStage` (decisions→`StructuredJD[]`, zod ingress) |
| P7 | `adapters/db/notion`: `NotionConnector implements Connector` (byte-exact option strings) · `core/dedup`: `dedupe(jobs, cache): StagePayload` · `core/rank`: `rank(jobs: StructuredJD[], cfg): EvaluatedJD[]` · `routines/cleanup`: `cleanupRoutine` |
| P8 | `cli/main.ts` (`jobbunny run\|doctor\|reconcile\|setup\|stage\|routine\|schedule\|lane\|profile`) · `cli/wire.ts` (sole adapter composition) · `ops/doctor` aggregation · `adapters/notify/telegram`, `adapters/scheduler/launchd` · config migrator · parity harness (`sync --dry-run` diff) · cutover executed |
| P9 | v0 deleted (scripts/, 16 commands, dead files), CLAUDE.md + README rewritten from scratch, branches pruned, `main-v2` → `main` |

## Phase gates

| Gate | Applies from | Meaning |
|---|---|---|
| `npm run check` | P1 | typecheck + biome + depcruise + all tests green |
| rajni verify | P3 | the phase's runtime behavior exercised on `profiles/rajni/` only |
| replay parity | P2, P7 | filter (P2) and rank/dedup (P7) reproduce recorded v0 decisions on fixture snapshots, diffs documented |
| dry-run parity | P8 | v2 would-write set diffed against v0's actual writes for ≥3 consecutive daily runs before cutover |
| soak | P9 | ≥7 days of v2 scheduled runs post-cutover before any deletion |
