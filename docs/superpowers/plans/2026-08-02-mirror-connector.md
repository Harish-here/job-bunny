# Mirror Connector (PR 3 of local-DB adoption) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Rev 2 — reworked after opus design review (4 blocking changes applied).

**Goal:** Opt-in one-way Notion mirror for sqlite profiles: `settings.notion.mirror: true` makes wire wrap the sqlite connector in a composite whose `syncJobs` writes local authoritatively, then best-effort pushes the same jobs to Notion — where **neither a Notion failure NOR Notion slowness can ever fail a run** (the push has its own deadline inside the sync stage's budget).

**Architecture:** New adapter family `src/adapters/db/mirror/` — a composite holding two `Connector` port instances, importing ONLY `ports/` + `core/` (never names Notion or sqlite). `cli/wire/builders.ts` owns the wrap decision (`mirrorDbId` + `buildMirroredConnector`); `compose.ts` gains three lines. Reads and `archiveStale` go to primary only. Because `dedup` drops already-known ids before `sync`, every job reaching the mirror is NEW — the push is create-only through `NotionConnector.syncJobs`, reused verbatim.
**Deliberate spec deviation (approved in design review):** spec §4 says a Notion failure "is a SoftError, never a run failure"; this plan catches EVERYTHING the mirror throws (auth outages and non-Soft errors included) — a strengthening, since any Notion problem on a local-first profile is a mirror problem, not a run problem. The KB records this wording.
**Token-less mirror is intentional:** the wrap condition does not check `NOTION_TOKEN` presence — a token-less mirror profile wraps and logs exactly one warn per run (the stub's plain Error propagates un-softened out of the first Notion call and lands in the mirror catch). The warn IS the reminder; doctor says the same thing.

**Tech Stack:** unchanged.

**Spec:** `docs/superpowers/specs/2026-08-01-local-db-jobboard-design.md` §4 — rollout item 3. Branch starts from `main-db` (PRs 1–2 merged, HEAD 2139db5).

## Global Constraints

- Runtime deps stay exactly: `@notionhq/client`, `dotenv`, `playwright`, `zod`.
- `adapters/db/mirror/` imports ONLY `ports/` + `core/` + node builtins — NEVER `adapters/db/notion` or `adapters/db/sqlite`. Only `compose.ts` + `builders.ts` instantiate adapters; no adapter import under `src/cli/` outside the carve-out, tests included.
- **Mirror failures never fail a run** (catch everything; log warn; return primary's results untouched) and **mirror slowness never fails a run** (own deadline via `MIRROR_BUDGET_MS = 300_000`, one third of the sync stage's 900 s).
- The primary's return value is authoritative — mirror results never merged; the primary's throw propagates untouched.
- Zero changes to `src/pipeline/**`, the `Connector` port, or Notion/sqlite adapter behavior. `schema.test.ts` untouched.
- File-size caps ≤400 impl / ≤800 test. compose.ts is 366 and gains only ~3 lines; the wrap logic lives in builders.ts (302 → ~350).
- Two-pair rule: `mirror/` = `index.ts` + `connector.ts` (+ test). Colocated tests. TS erasable-only. Conventional commits, no trailers. Node ≥ 24.
- NEVER enable the mirror on `profiles/rajni` in committed state; never use a real token or `--apply` during verification. Throwaway profiles only.

## Workspace Setup (fold into Task 1's first step)

```bash
cd /Users/harishamutha/Job-bunny-local-db
git switch feat/mirror-connector   # created by the controller with this plan committed
npm run check                      # green baseline (1179 tests expected)
```

---

### Task 1: `MirrorConnector` adapter family

**Files:**
- Create: `src/adapters/db/mirror/connector.ts`, `src/adapters/db/mirror/connector.test.ts`, `src/adapters/db/mirror/index.ts`

**Interfaces:**
- Consumes: `Connector`, `ArchivePolicy`, `CacheEntry` from `ports/connector.ts`; `RunContext` from `ports/context.ts`; `JD`, `SyncedJD`, `DroppedRecord` from `core/jd`.
- Produces (used by Task 2): `class MirrorConnector implements Connector { constructor(primary: Connector, mirror: Connector, budgetMs: number = MIRROR_BUDGET_MS) }`, `name` = `` `${primary.name}+${mirror.name}` ``; exported `MIRROR_BUDGET_MS = 300_000`.

**Behavior contract (decisions made — do not redesign):**
- `rebuildCache(ctx)`: `primary.rebuildCache(ctx)` — mirror never consulted.
- `archiveStale(policy, ctx)`: `primary.archiveStale(policy, ctx)` — mirror never consulted. (Note in the file header: the mirrored NotionConnector's `dryRun` setting is inert here — archive is never called on the mirror.)
- `syncJobs(jobs, ctx)`:

```typescript
const results = await primary.syncJobs(jobs, ctx);
// Mirror budget: the push is bounded by its OWN deadline, not the sync
// stage's. Without this, a slow (not failing) Notion consumes the stage
// budget and fails a run whose local write already succeeded — the exact
// outcome this composite exists to prevent. The race guards even a mirror
// that ignores its signal.
const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.budgetMs)]);
try {
  const push = this.mirror.syncJobs(jobs, { ...ctx, signal });
  push.catch(() => {}); // losing the race must never surface as unhandledRejection
  const mirrored = await Promise.race([push, rejectOnAbort(signal)]);
  const detail = { mirror: this.mirror.name, pushed: mirrored.length, of: jobs.length };
  if (mirrored.length < jobs.length) {
    ctx.logger.warn('mirror: partial push — some jobs did not reach the secondary', detail);
  } else {
    ctx.logger.info('mirror: pushed jobs to secondary', detail);
  }
} catch (err) {
  ctx.logger.warn('mirror: push failed — run continues, local store is authoritative', {
    mirror: this.mirror.name,
    error: err instanceof Error ? err.message : String(err),
  });
}
return results;
```

with the module-private helper:

```typescript
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
```

- The mirror receives the ORIGINAL `jobs` (the primary returns stamped copies, never mutates its input — so no `sync.pageId` leaks in and `NotionConnector.syncJobs` takes its create path).

- [ ] **Step 1: Failing tests** — `connector.test.ts` with fake `Connector` object literals and a capturing logger (record `{level, msg, data}` tuples):

```typescript
// 1. name is 'sqlite+notion' when primary/mirror are so named.
// 2. rebuildCache delegates to primary only; mirror.rebuildCache never called.
// 3. archiveStale delegates to primary only.
// 4. syncJobs returns exactly primary's results; mirror.syncJobs was called with the
//    ORIGINAL jobs array reference.
// 5. mirror.syncJobs rejecting (new Error('notion down')) → resolves with primary's
//    results; one warn logged containing 'mirror' and 'notion down'.
// 6. primary.syncJobs rejecting → syncJobs rejects; mirror never called.
// 7. DEADLINE: new MirrorConnector(primary, hangingMirror, 50) where hangingMirror's
//    syncJobs returns new Promise(() => {}) (ignores its signal) → syncJobs still
//    resolves with primary's results (await it; the race + 50ms budget fires); a warn
//    was logged.
// 8. PARTIAL: mirror resolves with fewer entries than jobs → a WARN (not info) logged
//    with { pushed, of }.
```

- [ ] **Step 2: Run** `node --test src/adapters/db/mirror/connector.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement** `connector.ts` per the contract (file header: composite pattern, never-fail-never-stall invariant, primary-only reads/archive, dryRun-inert note) and `index.ts` (`export { MIRROR_BUDGET_MS, MirrorConnector } from './connector.ts';`).
- [ ] **Step 4: Run** — PASS. **Step 5:** `npm run check`; commit `feat(adapters): MirrorConnector — budgeted best-effort mirror, failures and stalls never fail a run`.

---

### Task 2: wire assembly (`builders.ts` owns the decision)

**Files:**
- Modify: `src/cli/wire/builders.ts` — add (next to `buildConnector`), plus imports: `MirrorConnector` from the mirror barrel, `Connector` type from `ports/connector.ts`:

```typescript
/** The Notion dbId a sqlite profile's mirror should push to — '' when the
 * mirror doesn't apply: connector isn't sqlite, no notion slice, mirror
 * flag absent/false, or dbId missing/empty. Tolerant structural read
 * (same posture as wireMigrate's dbId read above): malformed slices mean
 * 'no mirror', never a throw. */
export function mirrorDbId(config: PipelineConfig): string { /* … */ }

/** Wraps `connector` in a MirrorConnector pushing to Notion when the
 * profile opts in (mirrorDbId !== ''); returns it unchanged otherwise.
 * Deliberately does NOT check NOTION_TOKEN presence — a token-less mirror
 * wraps and warns once per run; the warn is the operator's reminder. */
export function buildMirroredConnector(
  connector: Connector,
  config: PipelineConfig,
  api: NotionApi,
): Connector {
  const dbId = mirrorDbId(config);
  if (!dbId) return connector;
  return new MirrorConnector(connector, new NotionConnector(config.settings.notion, api));
}
```

`mirrorDbId` body: `config.connector === 'sqlite'` AND `config.settings.notion` is an object AND its `mirror === true` AND its `dbId` is a non-empty string → return the dbId; else `''`. (Reuse the structural-read style of `wireMigrate`'s dbId extraction — do not zod-parse; the NotionConnector constructor does its own parse at wrap time, and zod strips the unknown `mirror` key before it, which is fine.)
- Modify: `src/cli/wire/compose.ts` — exactly three touches: import the two helpers; wrap the construction `const connector = buildMirroredConnector(buildConnector(config.connector, config.settings[config.connector], notionApiForConnector, sqliteDefaultPath), config, notionApiForConnector);`; after the `checks` assembly, append `if (mirrorDbId(config) && deps.notionApi) checks.push(dbReachableCheck({ api: deps.notionApi, dbId: mirrorDbId(config) }));` (call it once into a local const). compose.ts stays ≤ 400.
- Test: `src/cli/wire/compose.test.ts`

- [ ] **Step 1: Failing tests** (compose.test.ts, existing fake-root idiom):

```typescript
// 1. sqlite profile + settings.notion { dbId: 'db-x', mirror: true } → connector.name
//    === 'sqlite+notion'; checks include 'notion-db-reachable' (fake deps provide a
//    notionApi) AND 'sqlite-db-openable'.
// 2. sqlite + mirror true but NO dbId → name === 'sqlite' (no wrap), no
//    notion-db-reachable check.
// 3. sqlite + { dbId: 'db-x' } (mirror absent) → name === 'sqlite'.
// 4. notion profile with mirror: true in its slice → name === 'notion' (gate is
//    sqlite-only; zod strips the unknown key before NotionConnector parses).
// 5. If the existing fake-root idiom tolerates writes: call the wrapped connector's
//    syncJobs with one minimal JD and assert it resolves and a 'mirror' warn was
//    captured (stub api throws). If the idiom is read-only, skip 5 — Task 1 covers
//    delegation behaviorally — and say so in NOTES.
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** compose tests — PASS.
- [ ] **Step 5:** `npm run check`; commit `feat(wire): assemble sqlite+notion MirrorConnector on settings.notion.mirror opt-in`.

---

### Task 3: settings flag + doctor messaging

**Files:**
- Modify: `src/adapters/db/notion/connector.ts` — `NotionConnectorSettingsSchema` gains `mirror: z.boolean().default(false)` with doc comment: "read by wire (`mirrorDbId`), not by this class; only meaningful on a sqlite profile's notion slice — on a pure-notion profile the flag is inert."
- Modify: `src/adapters/db/notion/connector.test.ts` — one case: `{ dbId: 'x', mirror: true }` parses with `mirror: true`; `{ dbId: 'x' }` defaults `mirror: false`.
- Modify: `src/ops/doctor/config_checks.ts` — `CoreCheckOpts` gains `notionMirror?: boolean`.
- Modify: `src/ops/doctor/aggregate.ts` — in `envTokensCheck`'s missing-NOTION_TOKEN branch, when `!notionRequired && opts.notionMirror === true`, the warn detail becomes `'NOTION_TOKEN is not set — the Notion mirror is enabled but cannot push until it is'`; all other cases byte-unchanged (red stays exclusive to `connector === 'notion'`).
- Modify: `src/ops/doctor/aggregate.test.ts` — two new cases: sqlite + `notionMirror: true` + missing token → warn matching `/mirror is enabled/`; sqlite + flag absent → existing `/only needed for the notion connector/` message unchanged.
- Modify: `src/cli/wire/compose.ts` — the `coreChecks({...})` callsite adds `notionMirror: mirrorDbId(config) !== ''` (helper from Task 2).

- [ ] **Step 1:** Failing tests first (schema case + the two doctor cases). **Step 2: Run** — new cases FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5:** `npm run check`; commit `feat(doctor): mirror-aware NOTION_TOKEN messaging; notion settings gain mirror flag`.

---

### Task 4: runtime verification (throwaway profile only)

**Files:** none committed.

- [ ] **Step 1:** `npm run check` green.
- [ ] **Step 2:** `node src/cli/main.ts profile build --profile zzmirrorcheck`; edit `profiles/zzmirrorcheck/profile.json`: `"connector": "sqlite"`, `"settings": { "sqlite": {}, "notion": { "dbId": "deadbeef", "mirror": true } }`.
- [ ] **Step 3:** `env -u NOTION_TOKEN node src/cli/main.ts doctor --profile zzmirrorcheck` — Expected: exit 0; `env-tokens` warn matching `mirror is enabled`; `sqlite-db-openable` ok; NO `notion-db-reachable` line (no token ⇒ no api handle ⇒ mirror check skipped — same posture as pure-notion).
- [ ] **Step 4:** `env -u NOTION_TOKEN node src/cli/main.ts stage reconcile --profile zzmirrorcheck` — Expected: exit 0 (reads primary only even with a dead token).
- [ ] **Step 4b — the invariant proving itself live (sync with Notion fully dead):** seed a checkpoint by hand (`stage` reads the latest checkpoint payload unvalidated): create `profiles/zzmirrorcheck/data/runs/<today YYYY-MM-DD>/09-00/09-rank.json` containing

```json
{"jobs":[{"identity":{"id":"li-mirror-1","lane":"linkedin","url":"https://example.com/j/1","company":"Acme","title":"Staff Engineer","scrapedAt":"2026-08-02T09:00:00.000Z"},"content":{"rawText":"synthetic"}}],"dropped":[]}
```

then `env -u NOTION_TOKEN node src/cli/main.ts stage sync --profile zzmirrorcheck` — Expected: exit 0; `sync: 1 -> 1`; run.log contains a `mirror: push failed` warn naming `NOTION_TOKEN missing` (ONE warn — the stub's plain Error is non-retryable and propagates out of the first Notion call, not once per job); and the row exists in `profiles/zzmirrorcheck/data/jobbunny.db` (verify via `node --input-type=module -e` with a readOnly `DatabaseSync`: `SELECT id FROM jobs` returns `li-mirror-1`). Any deviation → BLOCKED. Notion fully dead, local write committed, run passes — that is the PR.
- [ ] **Step 5:** `node src/cli/main.ts profile remove --profile zzmirrorcheck --force`; `git status --porcelain` clean. Any failure → BLOCKED.

---

## Closure (controller/advisor — NOT the lead's package)

1. Final whole-branch review (opus) + one fix wave + scoped re-review.
2. kb-curator: document the mirror family (the composite as the sanctioned cross-family composition idiom; budgeted push; catch-everything strengthening of spec §4's SoftError wording) and PIN TWO INVARIANTS: (a) **the mirror's create-only correctness rests on `dedup` dropping known ids before `sync`** — if that changes, mirrored pages duplicate and imported rows' Notion anchors get overwritten; (b) **a job archived locally and later re-scraped passes dedup (archived rows are excluded from the cache) and will create a second Notion page while the original stays live** — accepted hazard, mirror never archives Notion.
3. Merge → `main-db` (gates: check green; Task 4 incl. 4b is the run test).
4. Batch of pending USER decisions (accumulated PRs 2–3, present together): CLAUDE.md rewording proposals; rajni's real Notion dbId (scrub?); harish `migrate` dry-run go-ahead; scaffold-default flip timing.

## Deferred

- Mirror anchored-updates / archive mirroring (needs a local `notion_page_id` home via forward migration; only if pushed-page lifecycle management ever becomes a real need).
- Existing follow-ups list (Review Flags column, city truthiness, pragma order, close() lifecycle, stage.ts UTC bug).
