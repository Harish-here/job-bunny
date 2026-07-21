# v2 P7 — Notion Connector + Tail Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.
> **Depends on:** P1 + P2 + P3 + P6 merged (needs `StructuredJD` flowing and severity verdicts for rank). After this phase the pipeline is complete end-to-end.

**Goal:** `db/notion` connector (cache rebuild, sync, archive), pure `core/dedup` + `core/rank`, the `cleanup` routine, and the filter stage wiring — the tail of the pipeline.

**Pin at phase start:** byte-exact select option strings and property mapping from `scripts/notion/schema.js` (port by copying the *strings*, restructuring the code); sync field rules from `scripts/notion/notion_sync.js`; rank weights from `scripts/pipeline/rank.js`; dedup/repost rules from `scripts/pipeline/dedup.js`.

## Global Constraints

- Branch `feat/v2-p7-notion-tail` off `main-v2`. All P1 constraints apply.
- **Notion is the source of truth**; cache always rebuildable; reconcile read-only on Notion.
- **Byte-exact option strings** — every option string in the adapter carries a test asserting equality with the value pinned from v0 `schema.js`.
- Sync writes automated fields only; inserts + anchored updates; never whole-page overwrite or delete (archive = status change, not deletion).
- `core/dedup` and `core/rank` are pure (no I/O); replay parity vs v0 outputs gates this phase like P2.

## File Structure

```
src/adapters/db/notion/
  schema.ts + schema.test.ts       property map + byte-exact option strings
  client.ts + client.test.ts       thin @notionhq/client wrapper, retry/backoff, signal
  cache.ts + cache.test.ts         rebuildCache — live DB → CacheEntry[]
  sync.ts + sync.test.ts           syncJobs — automated fields only
  archive.ts + archive.test.ts     archiveStale(policy)
  connector.ts + connector.test.ts NotionConnector implements Connector
  index.ts
src/core/dedup/
  dedup.ts + dedup.test.ts         + fixtures/replay.json + replay.test.ts
  index.ts
src/core/rank/
  rank.ts + rank.test.ts           + fixtures/replay.json + replay.test.ts
  index.ts
src/routines/cleanup/
  cleanup.ts + cleanup.test.ts     Routine impl over Connector.archiveStale
  index.ts
src/pipeline/stages/
  filter.ts + filter.test.ts       thin StageDef over P2 evaluate/decide
  dedup.ts + dedup.test.ts         thin StageDef over core/dedup
  rank.ts + rank.test.ts           thin StageDef over core/rank
  sync.ts + sync.test.ts           thin StageDef over Connector.syncJobs
```

---

### Task 1: `core/dedup`

**Interfaces — Produces:** `dedupe(jobs: JD[], cache: CacheEntry[]): StagePayload` — drop on id match; fallback `normalizeToken(title)+companyKey(company)` match; fresh-id reposts of tracked jobs dropped with verdict `dedup.repost`; intra-run duplicates keep first, later get `evaluation.duplicateOf`. Verdict rules: `dedup.id`, `dedup.role-company`, `dedup.repost` (all hard, pass:false on drop).

- [ ] Steps: TDD each rule + replay fixture vs v0 `dedup.js` decisions (same harness pattern as P2 Task 6) → implement → commit `feat(v2): core/dedup + replay parity`.

### Task 2: `core/rank`

**Interfaces — Produces:** `RankConfigSchema` (weights: primary/secondary skill points, location bonus, workType preference, soft-verdict penalty per rule — seeded by `profile build` in P8) and `rank(jobs: StructuredJD[], cfg: RankConfig): EvaluatedJD[]` — deterministic 100-pt score, `excitement` banding, `matchReasons` including each soft-fail verdict's detail (severity payoff, spec §6). Port point values by reading v0 `rank.js`; replay fixture gates parity.

- [ ] Steps: TDD scoring bands + soft-verdict penalty + reasons → replay test → implement → commit `feat(v2): core/rank + replay parity`.

### Task 3: Notion schema + client

**Interfaces:** `schema.ts` exports `PROPERTIES` (name→Notion property descriptor) and `OPTIONS` (select option strings, byte-exact, one test per group diffing against values read from v0 `scripts/notion/schema.js` **at test time** — while both trees coexist, drift is impossible). `client.ts`: `NotionApi` wrapper — auth from env `NOTION_TOKEN`, 3-attempt backoff on 409/429/5xx, every call raced against ctx signal.

- [ ] Steps: TDD option-string parity test + client retry with stubbed SDK → implement → commit `feat(v2): notion schema (byte-exact) + client`.

### Task 4: cache / sync / archive / connector

**Interfaces:** `NotionConnector implements Connector` (name `'notion'`; settings zod: `{ dbId: string }` validated at construction — the wire-time pattern from P1 config).
- `rebuildCache`: paginate DB → `CacheEntry[]` (id from the job-id property, company, title, pageId).
- `syncJobs`: new job ⇒ insert with automated properties; known pageId ⇒ update **only** automated properties (pinned list from v0 `notion_sync.js`); returns `SyncedJD[]`; per-page failure = `SoftError` recorded, batch continues.
- `archiveStale(policy)`: query Passed older than `passedOlderThanDays` + no-Status older than `untouchedOlderThanDays`, set archived status; returns count; **dry-run flag in settings** honored (cleanup defaults dry-run, v0 invariant).

- [ ] Steps: TDD each against a stubbed NotionApi (paginated cache; automated-fields-only update payloads asserted key-by-key; archive query filters; soft per-page failure) → implement → live smoke against a scratch Notion DB (create 2 pages, rebuild, sync update, archive) — never a real profile DB → commit `feat(v2): notion connector`.

### Task 5: cleanup routine + tail StageDefs

**Interfaces:** `cleanupRoutine: Routine` where `Routine = { name: 'cleanup', when: 'post-sync', run(ctx: PipelineCtx): Promise<void> }` — define `Routine` in `src/routines/types.ts` (frozen: `{ name: string; when: 'pre-run' | 'post-sync' | 'standalone'; run(ctx: PipelineCtx): Promise<void> }`). Tail stages are thin `StageDef` wrappers: `filterStage` (P2 evaluate/decide over payload, hard-fails → dropped), `dedupStage` (cache from `ctx.ports.connector.rebuildCache` result carried in a run-scoped storage file written by a `reconcile` pre-stage), `rankStage`, `syncStage`.

- [ ] Steps: TDD each wrapper (payload in/out, drops recorded) + routine (calls archiveStale with profile policy; dry-run default) → implement → commit `feat(v2): tail stages + cleanup routine`.

### Task 6: End-to-end rajni verify + docs

- [ ] Scratch composition: fixture `StructuredJD`s → filter → dedup (seeded cache) → rank → sync against the scratch Notion DB; assert funnel in `result.json` and byte-exact options accepted by live Notion.
- [ ] Update `main-v2.md` (P7 ✅ — pipeline complete; P8 wires the surface). PR into `main-v2`.
