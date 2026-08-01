# Board App Layer (PR 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local-only `jobbunny board` HTTP server (127.0.0.1) exposing the per-profile job board API — browse `jobs`, edit `tracking` — via a new `src/app/` layer and a `BoardStore` port implemented in the sqlite adapter; plus the vocabulary single-authority relocation and the scaffold connector flip to sqlite.

**Architecture:** `src/app/` is a new top-level layer of vertical feature slices (`server/`, `shared/`, `features/profiles/`, `features/board/`) that imports ONLY `ports/` + `core/` (+ node builtins + zod). It never touches an adapter: `cli/wire/board.ts` (new, depcruise-carved-out) builds a `BoardSource` — profile discovery + lazy per-profile `SqliteBoardStore` — and `cli/commands/board.ts` injects it into `createBoardServer()`. Routes are pure functions (`BoardRequest → BoardResponse`) so every slice tests without sockets; one `listen(0)` socket test covers the server bootstrap. The pipeline is untouched except two single-authority refactors pinned by existing tests (`core/rank` excitement strings, notion `sync.ts` review-flags formula).

**Tech Stack:** node:http, node:sqlite (existing), zod v4, node:test. Zero new dependencies (runtime deps stay `@notionhq/client`, `dotenv`, `playwright`, `zod`).

## Global Constraints

- Node ≥ 24; ESM; TS7 erasable-only (no enums, no parameter properties); Biome formats on commit.
- Runtime deps stay exactly the current four — `node:http` and `node:sqlite` are builtins.
- File caps: impl ≤ 400 lines, test ≤ 800 (enforced by `test/invariants/filesize.test.ts`). Near-cap files you may NOT grow: `cli/main.ts` 388/400, `cli/wire/builders.ts` 390/400, `cli/wire/compose.ts` 390/400, `cli/wire/compose.test.ts` 800/800 (any new wire test goes in a NEW file).
- Two-pair rule: every module folder has an `index.ts` public surface; > 2 implementation files (tests + index excluded) ⇒ split into subfolders first. Internals are never imported across module boundaries.
- Boundaries (dependency-cruiser, `npm run boundaries`): `app/` imports only `ports/` + `core/` (+ own `app/` internals); nothing imports `app/` except `cli/`; the ONLY files importing `src/adapters/**` are `cli/wire/{compose,builders,registry,board}.ts` (registry type-only). NO test-file exemption anywhere — CLI/app tests use plain-object fakes, assert adapter identity via `.name`, never `instanceof`.
- Notion select option strings are byte-exact; `adapters/db/notion/schema.test.ts`'s frozen literals must stay green UNCHANGED — the vocab relocation moves the authority, not the bytes.
- The board server binds `127.0.0.1` only. The app never writes `jobs`; the pipeline never writes `tracking`. No hard deletes.
- Zero changes under `src/pipeline/**` and `src/routines/**`. `src/core/` changes limited to Tasks 1's exact files. Server crash/absence can never affect a pipeline run (separate process; WAL + busy_timeout already set by `openJobsDb`).
- Gate: `npm run check` green at every commit. Baseline at branch start: 1197 tests, 0 fail.
- API errors are structured JSON envelopes (`{ "error": { "code", "message" } }`) — never HTML, never a stack trace in the body.

---

### Task 1: vocabulary + derivation single-authority (core)

**Files:**
- Rename: `src/core/tracking/status.ts` → `src/core/tracking/vocab.ts`; `src/core/tracking/status.test.ts` → `src/core/tracking/vocab.test.ts` (`git mv`, then edit — keeps `core/tracking` at two impl files: `vocab.ts`, `fields.ts`)
- Modify: `src/core/tracking/index.ts`, `src/core/rank/rank.ts:181-185`, `src/adapters/db/notion/schema.ts:88`, `src/core/jd/schema.ts` (append helper), `src/adapters/db/notion/sync.ts:125-129`
- Test: `src/core/tracking/vocab.test.ts` (extended), `src/core/jd/schema.test.ts` (extended)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks import these exact names from `core/tracking` / `core/jd`):
  - `EXCITEMENT_OPTIONS: readonly ['Vera level', 'Kandipa podu', 'Try panalam']`
  - `type ExcitementLevel = (typeof EXCITEMENT_OPTIONS)[number]`
  - `reviewFlags(evaluation: JD['evaluation']): string[]` (from `core/jd`)

- [ ] **Step 1: Failing tests.** In `vocab.test.ts` (after the rename) add:

```typescript
test('EXCITEMENT_OPTIONS is the frozen 3-level vocabulary, high to low', () => {
  assert.deepEqual([...EXCITEMENT_OPTIONS], ['Vera level', 'Kandipa podu', 'Try panalam']);
});
```

In `src/core/jd/schema.test.ts` add:

```typescript
test('reviewFlags: detail wins, rule fallback, soft-fails only', () => {
  const flags = reviewFlags({
    verdicts: [
      { rule: 'geo', severity: 'soft', pass: false, detail: 'timezone overlap thin' },
      { rule: 'skills', severity: 'soft', pass: false },
      { rule: 'title', severity: 'hard', pass: false, detail: 'ignored — hard' },
      { rule: 'yoe', severity: 'soft', pass: true, detail: 'ignored — passed' },
    ],
    matchReasons: [],
  });
  assert.deepEqual(flags, ['timezone overlap thin', 'skills: soft-fail']);
});
test('reviewFlags: undefined evaluation and empty verdicts give []', () => {
  assert.deepEqual(reviewFlags(undefined), []);
  assert.deepEqual(reviewFlags({ verdicts: [], matchReasons: [] }), []);
});
```

(Adjust the verdict literal fields to the real `Verdict` shape in `core/jd/schema.ts` — keep the four cases: soft-fail-with-detail, soft-fail-without, hard-fail, soft-pass.)

- [ ] **Step 2: Run** `node --test src/core/tracking/vocab.test.ts src/core/jd/schema.test.ts` — FAIL (missing exports).
- [ ] **Step 3: Implement.**
  - `vocab.ts`: keep `STATUS_OPTIONS`/`TrackingStatus`/`PASSED_STATUS` verbatim; add

```typescript
/** Excitement vocabulary — single authority (local-DB spec §5). Producers
 * (core/rank) and projections (notion select, board meta) all import from
 * here; the strings are byte-exact Notion select options. */
export const EXCITEMENT_OPTIONS = ['Vera level', 'Kandipa podu', 'Try panalam'] as const;
export type ExcitementLevel = (typeof EXCITEMENT_OPTIONS)[number];
```

  - `core/tracking/index.ts`: re-export the two new names alongside the existing ones (path `./vocab.ts`).
  - `core/rank/rank.ts` `excitementFor` — thresholds stay local, strings come from the authority:

```typescript
function excitementFor(score: number): string {
  const [top, mid, low] = EXCITEMENT_OPTIONS;
  if (score >= 85) return top;
  if (score >= 65) return mid;
  return low;
}
```

  (import `EXCITEMENT_OPTIONS` from `../tracking/index.ts`; core→core is legal.)
  - `adapters/db/notion/schema.ts:88`: replace the local const with the STATUS pattern already at lines 19+89: `import { EXCITEMENT_OPTIONS, STATUS_OPTIONS } from '../../../core/tracking/index.ts';` and `export { EXCITEMENT_OPTIONS, STATUS_OPTIONS };` — `OPTIONS` block unchanged.
  - `core/jd/schema.ts` (append; NO new file — core/jd is at its two-impl-file limit):

```typescript
/** Soft-fail verdicts projected to operator-facing strings — the one
 * formula behind Notion's "Review Flags" and the board's reviewFlags. */
export function reviewFlags(evaluation: JD['evaluation']): string[] {
  return (evaluation?.verdicts ?? [])
    .filter((v) => v.severity === 'soft' && !v.pass)
    .map((v) => v.detail ?? `${v.rule}: soft-fail`);
}
```

  - `adapters/db/notion/sync.ts:125-129`: replace the inline filter/map with `const flags = reviewFlags(job.evaluation);` (import from `core/jd`), keeping the `if (flags.length > 0) props[...] = richTextProp(flags.join('; '));` lines byte-identical in behavior.
- [ ] **Step 4: Adapter-boundary pin + run.** First ADD one test to `adapters/db/notion/sync.test.ts` (additive only — existing pins untouched): a job with TWO soft-fails, one with `detail: 'timezone thin'`, one without (rule `skills`) → the built page property is exactly `'timezone thin; skills: soft-fail'` — this pins the `?? \`${rule}: soft-fail\`` fallback AND the `'; '` join at the adapter boundary, not only in the new core test. Then run the five suites: `node --test src/core/tracking/vocab.test.ts src/core/jd/schema.test.ts src/core/rank/rank.test.ts src/adapters/db/notion/sync.test.ts src/adapters/db/notion/schema.test.ts` — ALL PASS with zero edits to `rank.test.ts` and `schema.test.ts` (the single-authority proof). Self-check the `sync.ts` diff: exactly the inline filter/map replaced by the `reviewFlags()` call — `flags.join('; ')` and the `if (flags.length > 0)` guard byte-unchanged. This unit-level pinning is the deliberate whole gate for the notion refactor: Task 10 runs token-less, and a 5-line behavior-preserving extract does not warrant a live Notion push.
- [ ] **Step 5: Gate + commit** — `npm run check`; commit `refactor(core): excitement + review-flags single authority in core (notion/rank adopt)`.

---

### Task 2: `ports/board.ts` — the BoardStore/BoardSource port

**Files:**
- Create: `src/ports/board.ts`
- Modify: `src/ports/index.ts` (one star-export line, alphabetical: `export * from './board.ts';`)
- Test: extend `src/ports/contracts.test.ts` (145 lines — room)

**Interfaces:**
- Consumes: `JD` from `core/jd`, `TrackingFields` from `core/tracking` (ports→core is legal).
- Produces (verbatim — Tasks 3, 5, 6, 7 compile against these):

```typescript
import type { JD } from '../core/jd/index.ts';
import type { TrackingFields } from '../core/tracking/index.ts';

/** One discovered profile, as the board sees it. Pure-Notion profiles are
 * listed with hasDb=false and are never an error (spec §5). */
export interface BoardProfile {
  name: string;
  connector: string; // '' when profile.json is missing/malformed
  hasDb: boolean;    // a jobbunny.db file exists for this profile
}

export interface BoardQuery {
  status?: string;
  excitement?: string;
  company?: string;   // case-insensitive substring
  dateFrom?: string;  // inclusive calendar date (YYYY-MM-DD); date_found holds a full
  dateTo?: string;    // ISO DATETIME (identity.scrapedAt) — filters compare substr(date_found,1,10)
  archived?: boolean; // default false
  sort?: 'date_found' | 'score';
  order?: 'asc' | 'desc';
  limit?: number;     // caller pre-validated: 1..200
  offset?: number;    // >= 0
}

export interface TrackingRow extends TrackingFields {
  jobId: string;
  updatedAt: string;
}

/** null clears a field; absent keys are untouched. */
export type TrackingPatch = { [K in keyof TrackingFields]?: TrackingFields[K] | null };

export interface BoardJobRow {
  id: string;
  lane: string;
  title: string;
  company: string;
  url: string;
  seniority: string | null;
  locationCity: string | null;
  workType: string | null;
  timezone: string | null;
  skills: string[];
  excitement: string | null;
  score: number | null;
  matchReasons: string[];
  reviewFlags: string[];
  dateFound: string;
  archived: boolean;
  tracking: TrackingRow | null;
}

export interface BoardJobDetail extends BoardJobRow {
  jd: JD; // parsed jd_json — the detail pane payload
}

/** Read `jobs`, write `tracking` — never the reverse (ownership zones,
 * spec §3). Synchronous by design: node:sqlite is sync. */
export interface BoardStore {
  listJobs(query: BoardQuery): { rows: BoardJobRow[]; total: number };
  getJob(id: string): BoardJobDetail | null;
  /** Returns the merged row, or null when no such job id exists. */
  updateTracking(id: string, patch: TrackingPatch, now: string): TrackingRow | null;
  close(): void;
}

/** Cross-profile hub the CLI wires and the app consumes. openStore returns
 * null for unknown profiles and for profiles without a local DB. */
export interface BoardSource {
  listProfiles(): BoardProfile[];
  /** null for unknown names and profiles without a local DB. MAY throw for a
   * discovered profile whose DB file is corrupt or schema-newer — callers
   * surface that as a 500, never a crash. */
  openStore(name: string): BoardStore | null;
  close(): void;
}
```

- [ ] **Step 1: Failing test.** In `contracts.test.ts`, following its existing pattern for other ports, add a structural-conformance test: a plain-object `BoardStore` literal and `BoardSource` literal typed against the interfaces (e.g. `const s: BoardStore = { listJobs: () => ({ rows: [], total: 0 }), getJob: () => null, updateTracking: () => null, close() {} };` plus an assert that calling each returns the literal values). It fails to compile until `board.ts` exists.
- [ ] **Step 2: Run** `node --test src/ports/contracts.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement** `board.ts` exactly as above; add the barrel line.
- [ ] **Step 4: Run** — PASS. **Step 5: Gate + commit** — `npm run check`; commit `feat(ports): BoardStore/BoardSource — the board's read-jobs/write-tracking port`.

---

### Task 3: `SqliteBoardStore` (adapters/db/sqlite/board/)

**Files:**
- Create: `src/adapters/db/sqlite/board/board.ts`, `src/adapters/db/sqlite/board/board.test.ts`, `src/adapters/db/sqlite/board/index.ts` (new subfolder — the sqlite family root already has its two impl files `check.ts`/`connector.ts`)
- Modify: `src/adapters/db/sqlite/index.ts` (add `export { SqliteBoardStore } from './board/index.ts';`)

**Interfaces:**
- Consumes: `openJobsDb` (`../store/index.ts`), `BoardStore, BoardQuery, BoardJobRow, BoardJobDetail, TrackingRow, TrackingPatch` (ports), `reviewFlags` (core/jd — NOT `JDSchema`; the store never re-validates `jd_json`, an unused import would fail Biome), `DatabaseSync` (node:sqlite).
- Produces: `class SqliteBoardStore implements BoardStore { constructor(db: DatabaseSync) }` — Task 7 constructs it as `new SqliteBoardStore(openJobsDb(dbPath))`.

**Behavior contract:**
- `listJobs`: single SQL over `jobs LEFT JOIN tracking ON tracking.job_id = jobs.id`; WHERE built from provided filters only — `archived = ?` (0 unless `query.archived`), `tracking.status = ?`, `jobs.excitement = ?`, `jobs.company LIKE ? ESCAPE '\'` (pattern `%...%`, input's `%_\` escaped, `COLLATE NOCASE`), and date bounds as `substr(jobs.date_found, 1, 10) >= ?` / `<= ?` — `date_found` holds the full ISO DATETIME (`identity.scrapedAt`), so a bare `date_found <= '2026-08-02'` would silently drop the entire boundary day. Sort whitelist map `{ date_found: 'jobs.date_found', score: 'jobs.score' }` — NEVER interpolate caller strings into SQL; order `DESC` default; secondary `jobs.id ASC` for stable pages. `LIMIT ? OFFSET ?` (defaults 50/0). `total` = `SELECT COUNT(*)` sharing the same FROM **including the LEFT JOIN** and WHERE (a `tracking.status` filter needs the join in the count too) — private `whereFor(query)` returns `{ from, where, params }` used by both. Row mapping: `skills`/`match_reasons` are `JSON.parse(col ?? '[]')`; `reviewFlags` = `reviewFlags(JSON.parse(jd_json).evaluation)` — deliberate spec §3 divergence: v1 has no `review_flags` column, so it's derived from `jd_json` per listed row at read time (≤ 200 full-JD parses per request, fine at this scale; a v2 migration adding the column is the remedy if it ever shows in latency — see Deferred); `tracking` object null when no tracking row (`updated_at IS NULL` sentinel — that column is NOT NULL in the tracking table); spread every `.get()`/`.all()` result (`{ ...row }` — node:sqlite returns null-prototype objects).
- `getJob`: same join for one id; null when absent; `jd` = `JSON.parse(jd_json)` (parse only — no zod re-validation; the pipeline wrote it).
- `updateTracking`: `SELECT 1 FROM jobs WHERE id = ?` → null when absent. Read existing tracking row; merge in JS (patch key present: `null`→SQL NULL, string→value; absent: keep existing); full-row UPSERT `INSERT ... ON CONFLICT(job_id) DO UPDATE SET` all 7 fields + `updated_at = ?`; wrap in `SAVEPOINT jb_board_track` / `RELEASE` / `ROLLBACK TO`+`RELEASE` (house convention, `store.ts:8-10`); return the merged `TrackingRow`.
- `close()`: `this.db.close()`.

- [ ] **Step 1: Failing tests** (`board.test.ts`, `:memory:` pattern from `store/store.test.ts` — reuse its `makeJd`-style factory locally; seed via `new SqliteStore(db).upsertJobs([...])` — importing the sibling `store/` module inside the same adapter family is legal). Cases:

```
1. listJobs on empty DB → { rows: [], total: 0 }.
2. seed 3 jobs (two lanes, distinct companies/dates/excitement; one archived via markArchived) →
   default query returns the 2 non-archived, sorted date_found DESC, archived one absent;
   total === 2; row shape: skills/matchReasons arrays, tracking null, archived false.
3. archived: true returns only the archived job.
4. company: 'acm' matches 'Acme GmbH' case-insensitively; company: '100%' matches a literal
   '100%' company and NOT others (escape proof).
5. status filter: after updateTracking(id, { status: 'Applied' }, t1) → status: 'Applied'
   returns exactly that row, and its tracking.updatedAt === t1; total reflects the same
   filter (count query carries the LEFT JOIN).
6. dateFrom/dateTo bound inclusively — seed a job whose scrapedAt has a NON-MIDNIGHT time
   (e.g. 2026-08-02T09:00:00.000Z) and assert dateTo: '2026-08-02' still returns it (the
   substr projection proof); sort: 'score', order: 'asc' orders by score ascending.
7. limit/offset paginate (limit 1 offset 1 on 2 rows → the second row, total still 2).
8. getJob: returns full detail with jd.identity.id === id and reviewFlags from a seeded
   soft-fail verdict (seed one JD whose evaluation.verdicts has a soft fail with detail 'X'
   → reviewFlags deepEqual ['X']); unknown id → null.
9. updateTracking: creates row (all patch fields land, updatedAt = now); second patch with
   { notes: null } clears notes but keeps status; absent keys untouched; unknown job id → null.
10. updateTracking rolls back cleanly on constraint error (e.g. force by closing db mid-way is
    overkill — instead assert savepoint released: two sequential updates succeed).
```

- [ ] **Step 2: Run** `node --test src/adapters/db/sqlite/board/board.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement** `board.ts` per the contract (private `whereFor(query)` returning `{ from, where, params }` shared by list+count — the count MUST reuse the same FROM incl. the LEFT JOIN — keeps it well under 400). `index.ts` barrel: `export { SqliteBoardStore } from './board.ts';`
- [ ] **Step 4: Run** — PASS, 3× for stability. **Step 5: Gate + commit** — `npm run check`; commit `feat(adapters): SqliteBoardStore — board reads jobs, writes tracking (sqlite)`.

---

### Task 4: app skeleton — dependency rules + `app/shared` http plumbing

**Files:**
- Modify: `.dependency-cruiser.cjs`
- Create: `src/app/shared/http.ts`, `src/app/shared/router.ts`, `src/app/shared/index.ts`, tests `http.test.ts`, `router.test.ts`

**Interfaces:**
- Produces (Tasks 5/6 import from `../shared/index.ts`):

```typescript
// http.ts — NOTE: explicit field assignment; parameter properties are
// forbidden (tsconfig erasableSyntaxOnly — TS1294 otherwise).
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export interface BoardResponse { status: number; body: unknown }
export function jsonError(status: number, code: string, message: string): BoardResponse; // { status, body: { error: { code, message } } }
export function readJsonBody(req: import('node:http').IncomingMessage, limitBytes?: number): Promise<unknown>;
// rejects with HttpError(413,'too_large') past limit (default 1_048_576),
// HttpError(400,'bad_json') on parse failure; resolves undefined on empty body.

// router.ts
export interface BoardRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown; // undefined for GET
}
/** Required accessor — tsconfig noUncheckedIndexedAccess makes
 * req.params.name type 'string | undefined'; routes MUST use this. */
export function param(req: BoardRequest, key: string): string;
// throws HttpError(400, 'bad_request', `missing path param: ${key}`) when absent
export type RouteHandler = (req: BoardRequest) => BoardResponse | Promise<BoardResponse>;
export interface RouteDef { method: 'GET' | 'PATCH'; path: string; handler: RouteHandler }
// path segments: literal or ':param'; matchRoute returns null on no match.
export function matchRoute(routes: RouteDef[], method: string, pathname: string):
  { route: RouteDef; params: Record<string, string> } | null;
```

- [ ] **Step 1: dependency-cruiser first** (so every later app file is cruised from birth). In `.dependency-cruiser.cjs`:
  - Add two rules (mirror the `ports-only-core` block shape):

```js
{
  name: 'app-only-ports-core',
  comment: 'src/app is product logic over port types: adapters arrive only by injection from cli/wire (local-DB spec §5).',
  severity: 'error',
  from: { path: '^src/app' },
  to: { path: '^src/(adapters|pipeline|routines|ops|cli)' },
},
{
  name: 'only-cli-imports-app',
  severity: 'error',
  from: { path: '^src/(core|ports|adapters|pipeline|routines|ops)' },
  to: { path: '^src/app' },
},
```

  - Extend existing alternations — load-bearing: `core-is-pure` `to`, `ports-only-core` `to`, `adapters-only-ports-core` `to` each gain `|app` (without these, core/ports/adapters could import app); and the `pathNot` carve-out of `only-wire-imports-adapters` becomes `'^src/cli/wire/(compose|builders|registry|board)\\.ts$'` (board.ts arrives in Task 7 — adding it now is inert). Belt-and-braces (redundant with `app-only-ports-core` but kept as defense-in-depth — say so in the rule comment): `nothing-imports-cli` `from` gains `|app`; `only-wire-imports-adapters` `from` gains `|app`.
  - Run `npx depcruise src` — must report the same module count as before (~300, NOT 0 — the vacuous-pass trap) and no violations.
- [ ] **Step 2: Failing tests.** `router.test.ts`: literal match; `:name`/`:id` params extracted (assert `matchRoute(routes,'GET','/api/profiles/rajni/jobs/li-1')` yields `{ name: 'rajni', id: 'li-1' }`); method mismatch → null; trailing-slash and extra-segment → null; no decode crash on `%` (decodeURIComponent each param, invalid escapes → segment kept raw or 400 — pick: wrap in try, keep raw). `http.test.ts`: `jsonError` envelope shape; `readJsonBody` over a fake `IncomingMessage` (a `Readable.from([...chunks])` cast) — valid JSON resolves, garbage rejects HttpError 400, > limit rejects 413, empty resolves undefined.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** (`matchRoute` splits on '/', compares segment-wise; ~40 lines). `index.ts` barrel exports all names above.
- [ ] **Step 5: Run** — PASS. **Step 6: Gate + commit** — `npm run check`; commit `feat(app): app layer skeleton — dependency rules + shared http/router plumbing`.

---

### Task 5: feature slices — profiles + board routes/services

**Files:**
- Create: `src/app/features/profiles/routes.ts`, `routes.test.ts`, `index.ts`
- Create: `src/app/features/board/routes.ts`, `service.ts`, `index.ts`, tests `routes.test.ts`, `service.test.ts` — exactly TWO impl files (two-pair rule): the zod schemas live INSIDE `routes.ts` (transport owns validation); there is deliberately no separate `schemas.ts`

**Interfaces:**
- Consumes: `BoardSource, BoardStore, BoardQuery, TrackingPatch` (ports), `STATUS_OPTIONS, EXCITEMENT_OPTIONS` (core/tracking), `RouteDef, BoardRequest, BoardResponse, HttpError, jsonError, param` (shared), zod. EVERY path param read goes through `param(req, 'name')` / `param(req, 'id')` — a bare `req.params.x` fails to compile under `noUncheckedIndexedAccess`.
- Produces:
  - `makeProfilesRoutes(source: BoardSource): RouteDef[]` — one route: `GET /api/profiles` → `{ status: 200, body: { profiles: source.listProfiles() } }`.
  - `makeBoardRoutes(source: BoardSource): RouteDef[]` — four routes (list/get/patch/meta below).
  - `boardService(store: BoardStore)` internal service object `{ list(query), get(id), patchTracking(id, patch, now) }` — service throws `HttpError(404, 'not_found', ...)` for missing job; routes translate zod failures to `HttpError(400, 'validation', <first issue message>)`.

**Route contract (exact):**
- `GET /api/profiles/:name/jobs` — query zod (in `routes.ts`):

```typescript
const ListQuerySchema = z.object({
  status: z.enum(STATUS_OPTIONS).optional(),
  excitement: z.enum(EXCITEMENT_OPTIONS).optional(),
  company: z.string().min(1).max(200).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  archived: z.enum(['true', 'false']).optional(),
  sort: z.enum(['date_found', 'score']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
```

  parsed from `Object.fromEntries(req.query)`; response `{ status: 200, body: { rows, total, limit: q.limit ?? 50, offset: q.offset ?? 0 } }` (defaults applied when building `BoardQuery`, `archived: v === 'true'`).
- `GET /api/profiles/:name/jobs/:id` — `{ status: 200, body: service.get(id) }` (404 via HttpError).
- `PATCH /api/profiles/:name/jobs/:id/tracking` — body zod:

```typescript
const TrackingPatchSchema = z.strictObject({
  status: z.enum(STATUS_OPTIONS).nullable().optional(),
  compRange: z.string().min(1).max(500).nullable().optional(),
  notes: z.string().min(1).max(5000).nullable().optional(),
  contact: z.string().min(1).max(500).nullable().optional(),
  dateApplied: z.iso.date().nullable().optional(),
  nextAction: z.string().min(1).max(500).nullable().optional(),
  nextActionDate: z.iso.date().nullable().optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'empty patch' });
```

  Every string carries `.min(1)` because `core/tracking`'s `TrackingFieldsSchema` forbids empty strings (`fields.ts:12-18`) and `TrackingRow extends TrackingFields` must stay truthful — clearing a field is `null`, never `''` (the UI sends `null`; a bare `""` is a 400). `now` = `new Date().toISOString()` taken in the route; response `{ status: 200, body: { tracking: row } }`.
- `GET /api/profiles/:name/meta` — `{ status: 200, body: { statusOptions: [...STATUS_OPTIONS], excitementOptions: [...EXCITEMENT_OPTIONS] } }` — no store needed; MUST work for hasDb=false profiles, and (deliberately) returns 200 even for unknown `:name` — the vocab is profile-independent; document this in the route's comment so a UI switcher bug isn't mistaken for a live profile.
- Store resolution shared by the three store-backed routes: `source.openStore(param(req, 'name'))` (the `param()` accessor from shared — `req.params.name` alone won't compile under `noUncheckedIndexedAccess`); null → `HttpError(404, 'no_local_db', 'profile has no local database (pure-Notion profiles are read via Notion)')`.

- [ ] **Step 1: Failing tests.** All with a plain-object fake `BoardStore`/`BoardSource` (calls-recording closures, canned returns — `migrate.test.ts` pattern). `routes.test.ts` drives handlers directly with hand-built `BoardRequest`s: list happy path + defaults; `?status=Applied` reaches store as `{ status: 'Applied', archived: false, ... }`; `?limit=999` → 400 validation envelope; `?archived=true` maps to boolean; get 200/404; patch happy (fake returns row; assert `now` is an ISO string arg), patch `{}` → 400, patch unknown-field → 400 (strict), patch on null-store profile → 404 `no_local_db`; meta lists both vocabularies without touching the store (fake `openStore` that throws if called proves it). `service.test.ts`: 404 translation. `profiles/routes.test.ts`: returns `listProfiles()` verbatim.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (service ~40 lines; routes ~150 — if a slice file threatens its cap or a third impl file, split that slice into subfolders per the two-pair rule, e.g. `features/board/routes/`; pre-declared here so nobody improvises). Barrels — the PR-5 API contract (spec §5, type-only imports) is REQUIRED, exact exports from each slice `index.ts`:

```typescript
// features/board/index.ts
export { makeBoardRoutes } from './routes.ts';
export type { ListQuery, TrackingPatchBody } from './routes.ts';       // z.infer of the two request schemas
export type {                                                          // plain interfaces over port types
  BoardListResponse,   // { rows: BoardJobRow[]; total: number; limit: number; offset: number }
  BoardDetailResponse, // BoardJobDetail
  TrackingPatchResponse, // { tracking: TrackingRow }
  BoardMetaResponse,   // { statusOptions: string[]; excitementOptions: string[] }
} from './routes.ts';
// features/profiles/index.ts
export { makeProfilesRoutes } from './routes.ts';
export type { ProfilesResponse } from './routes.ts'; // { profiles: BoardProfile[] }
```
- [ ] **Step 4: Run** — PASS. **Step 5: Gate + commit** — `npm run check`; commit `feat(app): profiles + board feature slices — list/get/patch-tracking/meta routes`.

---

### Task 6: `app/server` — createBoardServer

**Files:**
- Create: `src/app/server/server.ts`, `src/app/server/static.ts`, `src/app/server/index.ts`, tests `server.test.ts`, `static.test.ts`

**Interfaces:**
- Consumes: `BoardSource` (ports), `Logger` (ports/context), both slice factories, `matchRoute`/`readJsonBody`/`HttpError`/`jsonError` (shared), node:http, node:fs, node:path.
- Produces (Task 8 consumes):

```typescript
export interface BoardServerOptions {
  source: BoardSource;
  logger: Logger;
  uiDir?: string;        // absolute path to ui/dist; undefined or missing dir → fallback page
  host?: string;         // default '127.0.0.1' — NEVER widened by config in v1
}
export interface BoardServer {
  listen(port: number): Promise<{ port: number }>; // resolves with the actual bound port (0 ⇒ ephemeral)
  close(): Promise<void>;                          // also calls source.close()
}
export function createBoardServer(opts: BoardServerOptions): BoardServer;
```

**Behavior contract:**
- Request flow: parse `new URL(req.url, 'http://x')`; pathname starting `/api/` → `matchRoute` over `[...makeProfilesRoutes(source), ...makeBoardRoutes(source)]` (assembled ONCE at create time); no match → 404 `not_found`. PATCH routes get `body: await readJsonBody(req)`. Handler result → `res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })` + `JSON.stringify(body)`.
- Error envelope: `HttpError` → its status/code; `ZodError` never escapes (slices convert — but belt-and-braces: treat a leaked one as 400 `validation`); anything else → `logger.error('board: handler failed', { path, error: String(err) })` + 500 `internal` with a GENERIC message (never `err.message`).
- Request log: one `logger.info('http', { method, path, status, ms })` per request (including errors), `ms` = `performance.now()` delta rounded.
- Non-`/api/` GET → `static.ts`: `serveStatic(uiDir, pathname)` — resolves within `uiDir` ONLY (`path.resolve` + `startsWith(uiDir + path.sep)` guard → 403-as-404 outside), `/` → `index.html`, content-type map `{ html, js, css, json, svg, png, ico, map, txt }` default `application/octet-stream`, missing file → SPA fallback to `index.html` when it exists, else the no-UI page: 200 text/plain `"Job Bunny board API is running. UI not built yet — run: npm run ui:build (arrives with PR 5). API: GET /api/profiles"`.
- The server never throws out of the request handler (top-level try/catch — this is also what turns a throwing `source.openStore` into a 500 envelope; pin that with a test); `close()` awaits `server.close()` then `source.close()`.
- Two accepted realities, note them in the file header so nobody "fixes" them: (a) `BoardStore` is synchronous inside async handlers — a slow query blocks the event loop, i.e. effectively a single-request server; fine for one local user, do NOT add worker threads; (b) if the sandbox running tests blocks loopback `fetch`, fall back to `node:http`'s `http.request` against the same `127.0.0.1:<port>` — do not weaken to handler-only tests.

- [ ] **Step 1: Failing tests.** `static.test.ts` (pure, temp dir via `mkdtemp`): serves index.html at `/`; `../../etc/passwd` traversal → no-UI/404 path, NOT file contents; `.js` content-type; missing uiDir → fallback message. `server.test.ts` — the repo's first socket test, `node:test` + real `fetch`, `listen(0)`:

```typescript
const server = createBoardServer({ source: fakeSource, logger: silentLogger });
const { port } = await server.listen(0);
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/profiles`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { profiles: [{ name: 'p1', connector: 'sqlite', hasDb: true }] });
  // 404 envelope: /api/nope → { error: { code: 'not_found', ... } }
  // PATCH with body → reaches fake store patch with parsed body
  // fake store whose listJobs throws → 500 { error: { code: 'internal' } }, message NOT the thrown one
  // GET / (no uiDir) → 200 text/plain containing 'npm run ui:build'
} finally { await server.close(); }
```

  Assert `close()` called `fakeSource.close`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (`server.ts` ~140 lines, `static.ts` ~80). **Step 4: Run** — PASS, 3× (watch for port/teardown flake; every test closes in `finally`).
- [ ] **Step 5: Gate + commit** — `npm run check`; commit `feat(app): board http server — route mounting, error envelope, static ui serving`.

---

### Task 7: `cli/wire/board.ts` — wireBoard / BoardSource assembly

**Files:**
- Create: `src/cli/wire/board.ts`, `src/cli/wire/board.test.ts` (NEW file — `compose.test.ts` is at 800/800; `builders.ts` is at 390/400, hence the separate module)
- Modify: `src/cli/wire/index.ts` (add `export type { BoardWireOverrides } from './board.ts'; export { wireBoard } from './board.ts';`)

**Interfaces:**
- Consumes: `SqliteBoardStore`, `openJobsDb`, `SqliteConnectorSettingsSchema` (adapters/db/sqlite — this file is in the depcruise carve-out from Task 4), `BoardSource, BoardStore, BoardProfile` (ports), node:fs, node:path.
- Produces (Task 8 consumes):

```typescript
export interface BoardWireOverrides {
  root?: string; // repo root; default: resolved like builders.ts does (three dirs up from this module)
}
export function wireBoard(overrides?: BoardWireOverrides): BoardSource;
```

**Behavior contract (tolerant posture — a broken profile never kills the board):**
- `listProfiles()`: `readdirSync(<root>/profiles, { withFileTypes: true })` → directories only, sorted; per dir read+parse `profile.json` — malformed/missing → `{ name, connector: '', hasDb: <file check> }`, never a throw; `connector` = structural string read (`typeof parsed.connector === 'string' ? parsed.connector : ''`); `dbPath` = `SqliteConnectorSettingsSchema` safeParse of `settings.sqlite ?? {}` → `.path` else default `<root>/profiles/<name>/data/jobbunny.db` (same resolution as `wireMigrate`, `builders.ts:353-356`); `hasDb` = `existsSync(dbPath)`.
- `openStore(name)` — SECURITY-ORDERED, three numbered gates, in this exact order (`name` arrives straight from a URL path param; `matchRoute` decodes `%2F`, so `'../rajni'` is a reachable input):
  1. `name` must be strictly equal (`===`) to one of the CURRENT `listProfiles()` names — anything else → null. This membership check, not path math, is the traversal defense.
  2. `hasDb` must be true → else null. NEVER creates a DB file (`openJobsDb` would mkdir+create; the board is read/annotate, not init).
  3. Only then `new SqliteBoardStore(openJobsDb(dbPath))`, memoized per name. NOTE the honest caveat: opening an EXISTING db is still a write (WAL `-wal`/`-shm` sidecars, pending forward migrations run) — acceptable for discovered, opted-in profiles; the gates above keep it away from everything else.
- `openStore` MAY throw past the gates (corrupt file, `user_version` newer than `LATEST_SCHEMA_VERSION` — `migrations.ts:66-71`): that propagates; the server's catch-all turns it into a 500 `internal` envelope and the request log carries the cause. Document the may-throw in `ports/board.ts`'s `openStore` doc comment; Task 6 pins the no-crash behavior.
- `close()`: closes every memoized store, clears the map, idempotent.
- Discovery is at-call (each `listProfiles()` re-reads the dir; store memo survives — a profile created while the server runs appears on next call).

- [ ] **Step 1: Failing tests** (`board.test.ts`, real temp dirs `mkdtemp` — filesystem discovery is the subject; identity via `.name`-less duck-typing: assert `openStore` returns an object with `listJobs`, never `instanceof`): temp root with `profiles/{a,b,rajni-like}/`: `a` valid sqlite profile WITH a db file created via `openJobsDb` then closed; `b` has `profile.json` `connector: 'notion'`, no db → `{ hasDb: false }`, `openStore('b')` null; malformed json dir → `connector: ''`, no throw; unknown name → null; **traversal probes: `openStore('../a')` and `openStore('a/../a')` both null (membership gate, not path normalization)**; memoization (two `openStore('a')` calls → same reference); `close()` then `openStore('a')` → fresh instance works; `openStore` on hasDb-false NEVER creates the file (assert `existsSync` still false after).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (~110 lines, module doc header explaining the carve-out membership + tolerant posture, mirroring `builders.ts:73-80`'s comment style).
- [ ] **Step 4: Run** — PASS; `npx depcruise src` clean (board.ts is already in the carve-out from Task 4). **Step 5: Gate + commit** — `npm run check`; commit `feat(wire): wireBoard — cross-profile BoardSource with lazy sqlite stores`.

---

### Task 8: CLI — args.ts extraction, then the `board` command

**Files:**
- Create: `src/cli/args.ts` (mechanical move), `src/cli/commands/board.ts`, `src/cli/commands/board.test.ts`
- Modify: `src/cli/main.ts` (shrinks, then gains one command wiring), `src/cli/args.ts` gets the board entries

**Interfaces:**
- Consumes: `wireBoard` (wire/index), `createBoardServer` (app/server via `../../app/server/index.ts` — cli→app is the ONE legal inbound edge), `createWireLogger` (ops/observability).
- Produces: `boardCommand(opts: { port: number }, deps?: Partial<BoardDeps>): Promise<number>` with

```typescript
export interface BoardDeps {
  wireBoard: () => BoardSource;
  createServer: (o: BoardServerOptions) => BoardServer;
  logger: Logger;                    // default createWireLogger()
  uiDir: string;                     // default <repo>/ui/dist resolved from import.meta.url
  write: (line: string) => void;     // default console.log
  waitForStop: () => Promise<void>;  // default: resolves on SIGINT/SIGTERM (process.once x2)
}
```

**Two sub-steps, TWO commits:**

- [ ] **Step 1 (mechanical split): create `src/cli/args.ts`** — move `CommandName`, `CommandOptions`, `COMMAND_NAMES`, `USAGE`, `buildOptions`, and the `parseArgs` options literal out of `main.ts` (exports; `main.ts` imports them). `CommandFn`/`CommandRegistry` STAY in `main.ts` — that keeps `main.test.ts`'s `import { type CommandFn, main } from './main.ts'` untouched. ONE required non-verbatim change: the extracted options literal MUST be declared `as const satisfies ParseArgsOptionsConfig` (type from `node:util`) — a bare module-level const widens `type: 'string'` to `string` (TS2322) and degrades the inferred `values` shape `buildOptions` consumes. Acceptance: `npm run typecheck` clean AND `node --test src/cli/main.test.ts` passes with ZERO test edits. `main.ts` lands ≈ 215 lines; `args.ts` ≈ 195 — both capped fine. Gate; commit `refactor(cli): extract args.ts (CommandName/USAGE/buildOptions) — cap headroom for board`.
- [ ] **Step 2: Failing tests** (`board.test.ts`, fake deps object literals): default port used when flag absent; `--port 0` accepted (ephemeral) — command prints the BOUND port from `listen()`'s return; prints `board: http://127.0.0.1:<port>` and one line per profile (`<name> — local db | notion-only`); resolves 0 after `waitForStop()` resolves and `server.close()` was awaited (order-assert via call log); wire/server construction errors propagate (main.ts catch → exit 1). In `main.test.ts` add the dispatch case following the existing `spy()` pattern (449/800 — room).
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.**
  - `board.ts`: wire → createServer → `listen(opts.port)` → print URL + profile lines → `await waitForStop()` → `await server.close()` → return 0.
  - `args.ts`: `'board'` in `CommandName` + `COMMAND_NAMES`; USAGE line `  board     [--port <n>]                    (job board server on 127.0.0.1; profile-less)`; parseArgs `port: { type: 'string' }`; `buildOptions` case `'board'`: profile-less (like `serve`), `port` via the `run-cap-ms` numeric-validation template (`main.ts:236-243` pattern), default `4646`, reject non-integer/negative with `{ error: 'board: --port must be a non-negative integer' }`.
  - `main.ts`: `defaultCommands` entry `board: (async (opts: CommandOptions) => boardCommand({ port: opts.port ?? 4646 })) as CommandFn`; `CommandOptions` gains `port?: number` (in args.ts now).
- [ ] **Step 5: Run** `node --test src/cli/commands/board.test.ts src/cli/main.test.ts` — PASS. **Step 6: Gate + commit** — `npm run check`; commit `feat(cli): jobbunny board — profile-less local board server command`.

---

### Task 9: scaffold default flips to sqlite

**Files:**
- Modify: `src/cli/commands/profile.ts:53-57` (the `MINIMAL_PIPELINE_CONFIG` literal + its stale comment)
- Test: `src/cli/commands/profile.test.ts` (add the missing pin)

- [ ] **Step 1: Failing test** — in `profile.test.ts`, after the existing build-path test's read-back (line ~35 pattern):

```typescript
test('profile build scaffolds connector sqlite (local-first default, spec §8)', async () => {
  // build into a temp dir per the file's existing helper pattern, then:
  const parsed = JSON.parse(await readFile(join(dir, 'profile.json'), 'utf8'));
  assert.equal(parsed.connector, 'sqlite');
  assert.deepEqual(parsed.settings, {});   // sqlite needs no settings slice ({} valid, spec §4)
});
```

- [ ] **Step 2: Run** — FAIL (`'notion'`). **Step 3: Implement** — `connector: 'sqlite'` at line 57; rewrite the comment (lines 51-54) to: `// Minimal-but-valid: connector must name a real adapter for wire() to resolve. Local-first default since the migrate command proved out (local-DB spec §8); 'notion' remains a valid opt-in.` Confirm `PipelineConfigSchema.parse` accepts it (it must — rajni already runs this shape).
- [ ] **Step 4: Run** — PASS (and the existing "kept" test still passes — it hand-writes `'notion'`). **Step 5: Gate + commit** — `npm run check`; commit `feat(cli): profile build scaffolds sqlite connector — local-first default (spec §8)`.

---

### Task 10: runtime verification (throwaway profile only — no commits)

**Files:** none committed.

Hard rails: throwaway profile `zzboardcheck` ONLY; NEVER touch `profiles/harish/**` or `profiles/rajni/**`; while the server is up, NEVER request a store-backed endpoint for any profile other than `zzboardcheck` (`openStore` on an existing DB writes WAL sidecars and runs pending migrations — `GET /api/profiles` listing is safe, it only stats files); `env -u NOTION_TOKEN` on every command; no `--apply`; delete the profile at the end.

- [ ] **Step 1:** `npm run check` green at HEAD.
- [ ] **Step 2:** `node src/cli/main.ts profile build --profile zzboardcheck` — then assert the scaffold: `grep '"connector": "sqlite"' profiles/zzboardcheck/profile.json` (Task 9 live).
- [ ] **Step 3:** Seed one job through the real pipeline write path: create `profiles/zzboardcheck/data/runs/$(date -u +%F)/23-50/08-rank.json` — the date is **UTC** (`stage.ts:82` keys the run folder on `toISOString().slice(0,10)`; using the local date makes the seed invisible in negative-offset-crossing hours and sync silently reports `0 -> 0`), and rank is stage index **08** (zero-padded; an 09 file would tie with sync's own `09-sync.json` on later re-runs) — containing

```json
{"jobs":[{"identity":{"id":"li-board-1","lane":"linkedin","url":"https://example.com/j/1","company":"Acme","title":"Staff Engineer","scrapedAt":"2026-08-02T09:00:00.000Z"},"content":{"rawText":"synthetic"},"evaluation":{"verdicts":[{"rule":"geo","severity":"soft","pass":false,"detail":"timezone overlap thin"}],"matchReasons":["skills: 3/4"],"score":72,"excitement":"Kandipa podu"}}],"dropped":[]}
```

  (field names must match `JDSchema` — check `core/jd/schema.ts` and adjust before running) then `env -u NOTION_TOKEN node src/cli/main.ts stage sync --profile zzboardcheck` → exit 0, `sync: 1 -> 1`, row present in `profiles/zzboardcheck/data/jobbunny.db`.
- [ ] **Step 4 — the board proving itself live:** `env -u NOTION_TOKEN node src/cli/main.ts board --port 4646 &` (background it; capture PID). Then, all against `http://127.0.0.1:4646`:
  - `GET /api/profiles` → 200, contains `{"name":"zzboardcheck","connector":"sqlite","hasDb":true}` (rajni listed too, `hasDb` per its data dir state — flagged, never erroring).
  - `GET /api/profiles/zzboardcheck/jobs` → 200, `total: 1`, row `id === 'li-board-1'`, `reviewFlags: ["timezone overlap thin"]`, `tracking: null`.
  - `GET /api/profiles/zzboardcheck/jobs/li-board-1` → 200 with full `jd`.
  - `PATCH .../jobs/li-board-1/tracking` body `{"status":"Applied","notes":"seed"}` → 200; re-GET list with `?status=Applied` → the row, `tracking.status === "Applied"`.
  - `PATCH` body `{"status":"NotAStatus"}` → 400 `{"error":{"code":"validation",...}}`; `GET /api/profiles/zzboardcheck/jobs/nope` → 404; `GET /api/profiles/nope/jobs` → 404 `no_local_db` or `not_found` (assert envelope shape).
  - `GET /api/profiles/zzboardcheck/meta` → both vocab lists, excitement `["Vera level","Kandipa podu","Try panalam"]`.
  - `GET /` → the no-UI text naming `npm run ui:build`.
- [ ] **Step 5 — WAL coexistence (spec §7):** with the server STILL RUNNING, re-run `env -u NOTION_TOKEN node src/cli/main.ts stage sync --profile zzboardcheck` → exit 0 (upsert of the same row; busy_timeout absorbs any overlap); then `GET .../jobs` again → still `total: 1` AND `tracking.status` still `"Applied"` — the pipeline write did not clobber the tracking zone. Any deviation → BLOCKED.
- [ ] **Step 6:** kill the server PID; `node src/cli/main.ts profile remove --profile zzboardcheck --force`; `git status --porcelain` clean. Any failure → BLOCKED.

---

## Closure (controller/advisor — NOT the lead's package)

1. Final whole-branch review (opus) + one fix wave + scoped re-review.
2. kb-curator: the `src/app/` layer (slices, injection-only adapter access, the two new depcruise rules), `ports/board.ts` ownership-zone enforcement, `wireBoard`'s tolerant discovery + membership-gate security posture, vocab/reviewFlags single-authority (notion schema now imports BOTH vocabularies), scaffold default = sqlite — EXPLICITLY check `.claude/commands/setup.md` (the `/setup` wizard seeds via the same `MINIMAL_PIPELINE_CONFIG`, so its Notion adopt-or-create flow now runs against a sqlite-default profile) and the README's Notion/Telegram procedure, `cli/args.ts` split. Executor.md placement rules if stale.
3. Merge → `main-db` (gates: check green at HEAD; Task 10 is the run test — board + pipeline-adjacent core/notion refactors all exercised live).
4. USER batch: none pending from this PR (CLAUDE.md board/scaffold wording can ride the final main merge proposal).

## Deferred

- `ui/` workspace + `npm run ui:build` + `/setup` fold-in (PR 5 — the no-UI fallback line already points there).
- Board auth of any kind, port config in profile.json, non-loopback bind (out of scope v1).
- `yoe`/`yoe_is_minimum`/`source_url` columns: NO data source exists on the v2 JD — needs a JD-schema feature first (follow-up list; NOT a board gap).
- `review_flags` column (spec §3): v1 derives it from `jd_json` at read time (Task 3) — add the column via forward migration only if list latency ever makes it worth it.
- Rate limiting / concurrent-writer arbitration beyond WAL+busy_timeout (single local user).
- Existing follow-ups: doctor warn for mirror-flag-set-but-malformed-slice; mirror pushes input array not persisted subset; `compose.test.ts` 800/800; `listCacheEntries` truthy city check; migrations pragma order; Connector `close()` lifecycle (board's `BoardStore.close()` partially lands this — the pipeline Connector side remains); `stage.ts` UTC run-folder date.
