# v2 P5 — Company Registry + API Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.
> **Depends on:** P1 + P3 merged. Independent of P4 (may run in parallel — do not touch `ports/browser.ts`). Consumes the `FarmingLane.source → companiesSeen` contract, not its implementation.

**Goal:** `core/company` registry with probe/health loops, the generic probe/fetch source stage, and Greenhouse + Keka `ApiLane` adapters.

**Pin at phase start:** exact Greenhouse/Keka endpoint shapes and probe heuristics from `scripts/pipeline/{greenhouse,keka,ats_common}.js` (read, then encode as zod ingress schemas + fixtures).

## Global Constraints

- Branch `feat/v2-p5-registry-api` off `main-v2`. All P1 constraints apply.
- Registry lives at `profiles/<p>/data/registry/companies.json` via `Storage` — `core/company` itself is pure (state in, state out).
- All probe/fetch responses zod-parsed at ingress; one company/board failure = `SoftError`, lane-wide outage = loud stage failure is **wrong** here — the whole API lane stays fail-soft (v0 invariant: lanes are optional breadth), so a whole-lane outage logs `warn` + zero jobs.
- Politeness: sequential probes per lane, config cap `maxProbesPerRun` (default 25, from lane settings).

## File Structure

```
src/core/company/
  schema.ts + schema.test.ts        CompanyRecordSchema, RegistrySchema
  registry.ts + registry.test.ts    pure transitions
  index.ts
src/pipeline/stages/
  source.ts + source.test.ts        makeSourceStage — the generic loop
src/adapters/lanes/greenhouse/
  api.ts + api.test.ts              probe/fetch + zod ingress schemas
  lane.ts + lane.test.ts            GreenhouseLane implements ApiLane
  index.ts
src/adapters/lanes/keka/            same shape as greenhouse
```

---

### Task 1: Registry schema + pure transitions

**Interfaces — Produces (frozen):**

```ts
export const ProbeStateSchema = z.object({
  status: z.enum(['unprobed', 'found', 'not-found', 'error', 'stale']),
  boardRef: z.string().optional(),
  probedAt: z.iso.datetime().optional(),
  failCount: z.number().int().min(0).default(0),
});

export const CompanyRecordSchema = z.object({
  name: z.string().min(1),
  normalizedKey: z.string().min(1),          // via P1 companyKey
  firstSeen: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  seenBy: z.array(z.string()),
  probes: z.record(z.string(), ProbeStateSchema).default({}),   // key = api lane name
  curated: z.boolean().default(false),
});
export const RegistrySchema = z.array(CompanyRecordSchema);
export type CompanyRecord = z.infer<typeof CompanyRecordSchema>;

export interface RegistryPolicy {
  reprobeNotFoundAfterDays: number;   // default 30
  maxProbeFailures: number;           // default 3
  staleAfterFetchFailures: number;    // default 3
}

// registry.ts — all pure:
export function upsertSeen(reg: CompanyRecord[], names: string[], lane: string, now: string): CompanyRecord[];
export function probeCandidates(reg: CompanyRecord[], apiLane: string, policy: RegistryPolicy, now: string): CompanyRecord[];
export function recordProbe(reg: CompanyRecord[], key: string, apiLane: string, result: ProbeResult, now: string): CompanyRecord[];
export function boardsToFetch(reg: CompanyRecord[], apiLane: string): Array<{ key: string; boardRef: string; curated: boolean }>;
export function recordFetchFailure(reg: CompanyRecord[], key: string, apiLane: string, policy: RegistryPolicy): CompanyRecord[];  // found → stale at threshold; curated: flag only, never stale
```

- [ ] Steps: TDD every transition (new company unprobed for each lane; TTL re-probe of not-found; error failCount cap stops probing; fetch-failure threshold → stale for auto, flag-only for curated; upsert bumps lastSeen not firstSeen) → implement → commit `feat(v2): company registry model + transitions`.

### Task 2: Generic source stage

**Interfaces — Produces:** `makeSourceStage(apiLanes: ApiLane[], policy: RegistryPolicy, opts: { maxProbesPerRun: number }): StageDef<StagePayload, StagePayload>` — reads registry via `ctx.storage`, takes `companiesSeen` handed off in the payload's lane report (extend `StagePayload` **no** — companiesSeen travels via a `farm` stage side-write: `registry/companies_seen.json`; source stage reads it — keeps StagePayload frozen), runs upsert → capped probes → fetch loop, appends fetched JDs to `payload.jobs`, persists updated registry. Each probe/fetch wrapped: `SoftError` recorded + `logger.warn`, loop continues.

- [ ] Steps: TDD with two fake ApiLanes (probe found/not-found/error paths; cap respected; stale boards skipped; jobs appended; registry persisted once at end) → implement → commit `feat(v2): generic probe/fetch source stage`.

### Task 3: Greenhouse adapter

**Interfaces:** Produces `GreenhouseLane implements ApiLane` (name `'greenhouse'`). Read v0 `scripts/pipeline/greenhouse.js` + `ats_common.js`, then: `probe` = board-existence request against the boards API for slug candidates derived from `companyKey`; `fetchBoard` = jobs listing → map to `JD{identity, content}` with ids `gh-<jobId>`, `identity.lane: 'greenhouse'`. Zod ingress schema for the jobs payload; fixtures recorded from two real public boards.

- [ ] Steps: TDD probe (found/404/network-error → ProbeResult variants) and fetch (fixture → JDs validate against `JDSchema`) with a fetch stub → implement over global `fetch` with signal deadlines → live smoke against one real public board → commit `feat(v2): greenhouse api lane`.

### Task 4: Keka adapter

Same task shape as Task 3 with Keka's tenant-probe specifics from `scripts/pipeline/keka.js`; ids `kk-…`. Commit `feat(v2): keka api lane`.

### Task 5: Verify + docs

- [ ] Rajni verify: scratch composition — seeded `companies_seen.json` → source stage with both lanes (fetch stubbed offline + one live smoke) → registry transitions visible in `registry/companies.json`.
- [ ] Update `main-v2.md` (P5 ✅). PR into `main-v2`.
