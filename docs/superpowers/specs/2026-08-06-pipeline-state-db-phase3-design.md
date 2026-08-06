# Phase 3 design — pipeline state → per-profile sqlite DB

Part of the persist-to-db program (umbrella design; Phase 3 boundary). Builds on schema v3. Author: advisor (overnight authorization, ledger L3/L7).

## Goal

Move every per-profile JSON **state** file into `jobbunny.db`, behind a new port, with an automatic one-time import of existing files (ledger L9: harish's registry seen-state MUST survive, or previously-seen ATS jobs resurface as new). After this phase a steady-state run reads and writes **no** per-profile JSON state files.

## Inventory (verified against source, wt-phase3)

All state I/O already flows through the generic `ports/storage.ts` port (`readJson`/`writeJson` with profile-relative paths + zod at read). The keys and their owners:

| Key (today's relPath) | Writers | Readers | Lifecycle |
|---|---|---|---|
| `cache/entries.json` | reconcile stage | dedup, source, lane.ts, cli/commands/reconcile.ts | derived (rebuilt every reconcile) |
| `registry/companies.json` | source | source | **DURABLE** |
| `registry/api_seen.json` | source | source | **DURABLE — dedup-critical (L9)** |
| `registry/companies_seen.json` | farm | source | **DURABLE** accumulator |
| `structure/table.json` | compress | structure stage + /structure skill | per-run hand-off |
| `structure/passthrough.json` | compress | assemble | per-run hand-off |
| `structure/decisions.json` | structure stage (also /structure skill output) | assemble | per-run hand-off |
| `structure/decisions.partial.json` | structure stage | structure stage | per-run hand-off |
| `lanes/linkedin/captures.json` | capture_store (farm lane) | capture_store | run/day-scoped |
| `lanes/linkedin/extract_resume.json` | resume_state | resume_state | same-day |

**Stays on the fs `Storage` port (NOT state):** page-inventory reads (`src/adapters/lanes/linkedin/page_inventory/<page>.json` — repo-tracked machine-shared assets, umbrella out-of-scope) and `routine cleanup`'s legacy `runs/` folder pruning (`listSubdirs`/`removeTree`). `jobs_raw.json` has no production readers (fixture/test-only) — untouched. The `Storage` port survives Phase 3 for exactly these consumers; its doc comment is updated to say so.

## Design

### Port: `ports/state_store.ts`

Generic document surface, same read semantics as today's `Storage.readJson` so call sites migrate mechanically (`ctx.storage.readJson(KEY, Schema)` → `ctx.stateStore.readDoc(KEY, Schema)`):

```ts
export interface StateStore {
  /** undefined when absent; throws on schema mismatch (posture unchanged from Storage.readJson). */
  readDoc<T>(key: string, schema: ZodType<T>): Promise<T | undefined>;
  writeDoc(key: string, value: unknown): Promise<void>;   // LOUD: throws on failure (state is pipeline data)
  close(): void;
}
```

Keys are the EXISTING relPath strings verbatim (`'registry/api_seen.json'`, …) — they are already exported constants; they become the stable document keys, giving a 1:1 file→row import mapping and zero constant churn. Promise signatures kept for drop-in compatibility even though sqlite is sync.

### Schema v4

```sql
CREATE TABLE state_docs (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Adapter: `adapters/db/sqlite/state/` — `SqliteStateStore(dbPath, dataDir, deps?)`

- Shares `jobbunny.db` (same open path/pragmas as runs/checkpoints stores). LOUD posture (like checkpoints, unlike the run store): any sqlite error propagates.
- **Lazy one-time import (the L9 mechanism):** `readDoc` on a DB miss checks the legacy file at `<dataDir>/<key>`; if present: parse as JSON, INSERT into `state_docs`, return through the caller's schema. Idempotent, per-key, zero orchestration — harish's registry lifts automatically on the first post-upgrade run. Legacy files are LEFT IN PLACE (never delete user data; nothing writes them again, so they go inert). `writeDoc` always writes the DB only.
- The done-when criterion is therefore precise: steady-state runs (after first lift) read and write no state files; the only file reads ever performed are the one-time per-key lifts.

### Call-site migration

- `PipelineCtx` gains `stateStore: StateStore`; stages swap port calls mechanically: reconcile, source, compress, structure, assemble, dedup, farm, plus `cli/commands/reconcile.ts`.
- LinkedIn lane modules (`capture_store.ts`, `resume_state.ts`, `lane.ts`'s cache read) receive the `StateStore` port instance via their existing construction path in `cli/wire/compose.ts` (port injection, no cross-family import). Inventory reads keep the `Storage` port.
- `ctx.storage` remains on `PipelineCtx` for cleanup's legacy folder pruning (and the lane keeps `Storage` for inventories).

### /structure hand-off (token rule preserved)

The skill can't read DB rows, so two narrow CLI helpers replace the file hand-off:

```
jobbunny state read  <table|decisions|decisions-partial> --profile <p>   # prints the raw doc string to stdout
jobbunny state write <decisions|decisions-partial>       --profile <p>   # reads stdin, writes the doc
```

- Restricted to the structure hand-off keys — NOT a general DB poke tool.
- The docs are the SAME markdown-table strings as today (`z.string()` docs); the 2500-char JD cap and markdown-table shape are untouched — only the transport changes. `.claude/commands/structure.md` is updated to use the helpers (advisor-supervised dispatch, protected path).

## No new backfill decisions

Umbrella D7 ("no backfill") is superseded for these keys by L9's import obligation — implemented as the lazy lift above, uniformly for all ten keys (durable ones matter; lifting derived ones is harmless and keeps one rule).

## CLAUDE.md

No CLAUDE.md invariant names state files today (checked: its bullets cover checkpoints/runs/registry only via "Greenhouse/Keka company state is auto-managed in `data/registry/companies.json`" — THAT line becomes false). Proposed replacement recorded in the ledger for user approval (not edited in-phase, same as Phase 2): "Greenhouse/Keka company state is auto-managed in the per-profile DB (`state_docs` key `registry/companies.json`); there are no hand-maintained board watchlists." Explainer KB / triager / verify skill / `.claude/commands/structure.md` sync in-phase (advisor-supervised for protected paths).

## Testing and rollout

- Unit: migration v4; adapter CRUD + LOUD posture + lazy-lift (hit, miss-with-file, miss-without-file, malformed legacy file → loud throw with the file named); per-stage fakes swapped; CLI helpers read/write round-trip.
- **Live verification (rajni, L10 precheck):** (a) seed legacy registry/cache files → first run lifts them into `state_docs` (rows match files) and the pipeline behaves identically; (b) move the legacy files aside → second run identical from DB alone; (c) full staged chain writes ZERO files under `data/` outside `jobbunny.db*` (registry/, cache/, structure/, lanes/ stay untouched); (d) `state read table` / `state write decisions` round-trip preserves a markdown table byte-for-byte; (e) fresh v0→v4 migration.
- Kill-and-resume unaffected (checkpoints unchanged) — spot-check one resume.
