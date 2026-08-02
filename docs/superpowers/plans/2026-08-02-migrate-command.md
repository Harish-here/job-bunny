# Migrate Command (PR 2 of local-DB adoption) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Rev 2 — reworked after opus design review (8 blocking changes applied).

**Goal:** One-shot `jobbunny migrate --profile <name> [--apply]` that imports a profile's live Notion DB into its local sqlite store (automated fields → `jobs`, manual tracking columns → `tracking`) and flips that profile's connector to sqlite. Insert-only on both tables — a re-run can never downgrade or clobber anything.

**Architecture:** The Notion adapter owns the page→record mapping (it owns Notion shapes): new `exportForMigration` returns `MigratedRecord[]` (`{ jd, tracking? }`, types in `core/tracking`). The sqlite store gains insert-only `importJobs` + `importTracking`. A light `wireMigrate()` in `cli/wire/builders.ts` (already inside the adapter-import carve-out, with file-size headroom) hands the command a **narrow closure interface** (`MigrateWire`) — no adapter type crosses into `cli/commands/`. Migrate is READ-ONLY on Notion, dry-run by default (zero writes of any kind, no DB file created), idempotent under `--apply` re-runs.

**Tech Stack:** unchanged — TS 7 erasable-only, node:sqlite, zod v4, node:test.

**Spec:** `docs/superpowers/specs/2026-08-01-local-db-jobboard-design.md` §4 + §8 item 2. Branch starts from `main-db` (PR 1 merged).

## Global Constraints

- Runtime deps stay exactly: `@notionhq/client`, `dotenv`, `playwright`, `zod`.
- `adapters/db/notion` and `adapters/db/sqlite` never import each other; only `cli/wire/compose.ts` + `builders.ts` (+ `registry.ts` type-only) may import `src/adapters/**` — **and that carve-out has NO test-file exemption: no file under `src/cli/` other than those three may import adapters, `.test.ts` included** (`.dependency-cruiser.cjs:57-61`).
- File-size caps (`test/invariants/filesize.test.ts`): impl ≤ 400 lines. `compose.ts` is at 384 — add nothing to it beyond the one-line stub-import change in Task 4; `main.ts` is at 374 and Task 5 adds ~13 (lands ~387 — fits, but note the headroom for future PRs).
- Commands never import `src/adapters/**` — injected deps, defaults from `cli/wire` (pattern: `src/cli/commands/doctor.ts`).
- Notion property names/select options byte-exact; `schema.test.ts` untouched.
- Migrate performs ZERO Notion writes — `NotionApi.queryDatabase` is the only Notion call permitted; a test pins this with create/update spies.
- Insert-only imports: `jobs` rows already present were written by the pipeline (richer JD) and are never downgraded (`ON CONFLICT(id) DO NOTHING`); `tracking` rows are board-owned and never overwritten (`ON CONFLICT(job_id) DO NOTHING`).
- zod at ingress: every synthesized `JD` passes `JDSchema.parse`; tracking through `TrackingFieldsSchema.parse`.
- **NEVER run `migrate` against `profiles/rajni`** (its `settings.notion.dbId` is a REAL Notion database id — the "fixture has no Notion IDs" claim is stale), **and never with `--apply` on any profile during verification.**
- Colocated tests; `adapters/db/notion/` already exceeds the two-pair file count — this PR adds files matching its existing flat layout and records the deviation; no restructuring.
- `npm run check` green before every commit; conventional commit messages, no Co-Authored-By / "Generated with" trailers. Node ≥ 24; node:sqlite ExperimentalWarning acceptable.

## Workspace Setup (fold into Task 1's first step)

```bash
cd /Users/harishamutha/Job-bunny-local-db
git switch feat/migrate-command   # created by the controller with this plan committed
npm run check                     # must be green before any change
```

---

### Task 1: `core/tracking` — `TrackingFields` + `MigratedRecord`

**Files:**
- Create: `src/core/tracking/fields.ts`, `src/core/tracking/fields.test.ts`
- Modify: `src/core/tracking/index.ts`

**Interfaces:**
- Produces (consumed by Tasks 2–5): `TrackingFieldsSchema` (zod), `type TrackingFields`, `interface MigratedRecord { jd: JD; tracking?: TrackingFields }`.

- [ ] **Step 1: Failing test** — `src/core/tracking/fields.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrackingFieldsSchema } from './index.ts';

test('TrackingFieldsSchema: every field optional; empty object is valid', () => {
  assert.deepEqual(TrackingFieldsSchema.parse({}), {});
});

test('TrackingFieldsSchema: accepts the full manual-field set', () => {
  const full = {
    status: 'Applied',
    compRange: '30-40 LPA',
    notes: 'Referred by R.',
    contact: 'recruiter@acme.example',
    dateApplied: '2026-07-15',
    nextAction: 'Follow up',
    nextActionDate: '2026-08-05',
  };
  assert.deepEqual(TrackingFieldsSchema.parse(full), full);
});

test('TrackingFieldsSchema: date fields must be YYYY-MM-DD', () => {
  assert.throws(() => TrackingFieldsSchema.parse({ dateApplied: 'yesterday' }));
});
```

- [ ] **Step 2: Run** `node --test src/core/tracking/fields.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/tracking/fields.ts`:

```typescript
/**
 * The human tracking-field shape (local-DB spec §3's `tracking` zone):
 * the manual Notion columns' local home. Owned/edited by the board app
 * (PR 4); written in bulk exactly once by `jobbunny migrate` (PR 2),
 * insert-only — an existing row always wins.
 * All fields optional — a job with no human tracking has no row at all.
 */
import { z } from 'zod';
import type { JD } from '../jd/index.ts';

export const TrackingFieldsSchema = z.object({
  status: z.string().min(1).optional(),
  compRange: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  contact: z.string().min(1).optional(),
  dateApplied: z.iso.date().optional(),
  nextAction: z.string().min(1).optional(),
  nextActionDate: z.iso.date().optional(),
});

export type TrackingFields = z.infer<typeof TrackingFieldsSchema>;

/** One Notion page, translated for import: the synthesized JD plus the
 * manual tracking fields (absent when the page had none). */
export interface MigratedRecord {
  jd: JD;
  tracking?: TrackingFields;
}
```

`src/core/tracking/index.ts` — add:

```typescript
export { type MigratedRecord, type TrackingFields, TrackingFieldsSchema } from './fields.ts';
```

- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Gate + commit** — `npm run check`; `git add src/core/tracking`; commit `feat(core): TrackingFields + MigratedRecord types for the migrate path`.

---

### Task 2: Notion adapter — shared property readers + `exportForMigration`

**Files:**
- Create: `src/adapters/db/notion/properties.ts`, `src/adapters/db/notion/properties.test.ts`
- Create: `src/adapters/db/notion/migrate_export.ts`, `src/adapters/db/notion/migrate_export.test.ts`
- Modify: `src/adapters/db/notion/cache.ts` (export `deriveId`; use shared readers — it currently holds only `plainText`/`propText`/`propUrl`)
- Modify: `src/adapters/db/notion/archive.ts` (use shared readers — it holds all five, delete its private copies)
- Modify: `src/adapters/db/notion/index.ts` (add ONLY `exportForMigration` — `deriveId`, the readers, and `pageToMigratedRecord` stay family-internal; colocated tests import `./migrate_export.ts` directly)

**Interfaces:**
- Consumes: `MigratedRecord`, `TrackingFields` (Task 1); existing `NotionApi`, `PROPERTIES`, option lists.
- Produces: `properties.ts` — `RawPropertyValue`, `RawPage`, `propText`, `propUrl`, `propSelectName`, `propDateStart` (the single shared copy of the reader idiom); `migrate_export.ts` — `exportForMigration(api: NotionApi, dbId: string, ctx: RunContext, now?: string): Promise<MigratedRecord[]>` and `pageToMigratedRecord(raw: unknown, now: string): MigratedRecord` (exported at file level for its colocated test).

**Mapping contract (decisions made — do not redesign):**
- `identity.id`: `deriveId(jobUrl)`; when un-derivable, fallback `nt-<pageId-without-dashes>` (never skip a page). `identity.lane`: `li-`→`linkedin`, `gh-`→`greenhouse`, `kk-`→`keka`, fallback→`notion-import`.
- `identity.url`: Job URL, fallback `https://www.notion.so/<pageId-without-dashes>`; `company`/`title` fallback `'Unknown company'`/`'Unknown title'` (same idiom as `archive.ts`'s `toDroppedRecord`).
- `identity.scrapedAt`: `<Date Found>T00:00:00.000Z` when Date Found exists, else `now`. (By construction, a page with no Date Found reads as brand-new to `archiveStale` and is immune to the untouched-staleness rule for its first TTL window — intended, not a bug.)
- `structured`: always present — `titleParts.seniority` (select, kept only if in `SENIORITY_OPTIONS`), `locations` = `[{ city }]` when Location City is NON-EMPTY else `[]` (**this non-empty guard is load-bearing**: an `nt-` row can never id-match a future scrape, so `dedup.repost`'s company+title+city key is its only duplicate protection), `workType` via inverse label map `{'On-site':'onsite','Hybrid':'hybrid','Remote':'remote'}` (unknown label → omit), `timezone` (kept only if in `TIMEZONE_OPTIONS`), `skills` = Key Skills split on `', '` (empty → `[]`).
- `evaluation`: `{ verdicts: [], matchReasons: <Match Reasons split on '\n', empty → []>, excitement? (kept only if in EXCITEMENT_OPTIONS) }`. (Notion's Review Flags column is NOT imported — the v1 `jobs` schema has no column for it; recorded in Deferred.)
- `sync`: `{ pageId: <notion page id>, syncedAt: now }` — preserves the Notion anchor inside `jd_json` for PR 3's mirror.
- Every JD goes through `JDSchema.parse` — a parse failure on one page throws loudly (a malformed export must never half-import).
- `tracking`: Status (select), Comp Range/Notes/Contact/Next Action (rich_text), Date Applied/Next Action Date (`date.start` sliced `.slice(0, 10)`); include only non-empty values; all empty ⇒ `tracking` undefined. Validate via `TrackingFieldsSchema.parse`.

- [ ] **Step 1: Extract the shared readers.** Create `src/adapters/db/notion/properties.ts`:

```typescript
/**
 * Shared raw-page property readers — the single copy of the idiom
 * previously duplicated privately in cache.ts (text/url subset) and
 * archive.ts (all five), needed a third time by migrate_export.ts,
 * which forced this extraction. Strictly read-shaping: no API calls.
 */
export interface RawPropertyValue {
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  url?: string | null;
  select?: { name: string } | null;
  date?: { start: string } | null;
}

export interface RawPage {
  id: string;
  properties?: Record<string, RawPropertyValue | undefined>;
}

function plainText(parts: { plain_text: string }[] | undefined): string {
  return (parts ?? []).map((t) => t.plain_text).join('');
}

export function propText(p: RawPropertyValue | undefined): string {
  if (p?.title) return plainText(p.title);
  if (p?.rich_text) return plainText(p.rich_text);
  return '';
}

export function propUrl(p: RawPropertyValue | undefined): string | null {
  return p?.url ?? null;
}

export function propSelectName(p: RawPropertyValue | undefined): string | null {
  return p?.select?.name ?? null;
}

export function propDateStart(p: RawPropertyValue | undefined): string | null {
  return p?.date?.start ?? null;
}
```

`properties.test.ts`: four small tests — `propText` joins title parts; prefers title over rich_text and returns `''` for neither; `propSelectName`/`propDateStart` null for absent; `propUrl` passthrough.

- [ ] **Step 2: Refactor `cache.ts` and `archive.ts`** to import from `./properties.ts`, deleting their private copies (`cache.ts`: `RawPropertyValue`/`RawPage`/`plainText`/`propText`/`propUrl`; `archive.ts`: those plus `propSelectName`/`propDateStart`), and change `function deriveId` → `export function deriveId` in cache.ts. Behavior byte-identical — run `node --test src/adapters/db/notion/cache.test.ts src/adapters/db/notion/archive.test.ts` — Expected: PASS with zero test edits.

- [ ] **Step 3: Failing tests for the mapper** — `migrate_export.test.ts`, copying the stub-client idiom from `cache.test.ts` (`stubWithPages`/`fakeCtx` are file-private there — copy, don't import). Cases against `pageToMigratedRecord(raw, '2026-08-02T10:00:00.000Z')` (1–6) and `exportForMigration` (7–8):

```typescript
// 1. full page (li- URL, all automated + all 7 manual fields) → JD mapped per contract,
//    tracking has all 7 fields, sync.pageId === page id.
// 2. no manual fields → tracking === undefined.
// 3. un-derivable URL → id 'nt-<pageid-no-dashes>', lane 'notion-import'.
// 4. no Job URL → url notion.so permalink fallback; id 'nt-…'.
// 5. workType 'On-site' → 'onsite'; a seniority select NOT in SENIORITY_OPTIONS is omitted;
//    empty Location City → locations [] (never [{city: ''}]).
// 6. no Date Found → scrapedAt === now; Date Found '2026-07-01' → '2026-07-01T00:00:00.000Z'.
// 7. exportForMigration over a two-page stub → 2 records (pagination via queryDatabase).
// 8. ZERO Notion writes: stub's pages.create/pages.update wrapped in call counters —
//    both remain 0 after exportForMigration.
```

Write each as a real `test()` with concrete fixtures and exact assertions.

- [ ] **Step 4: Run** — Expected: FAIL (module not found).

- [ ] **Step 5: Implement `migrate_export.ts`** per the contract:

```typescript
import type { JD, WorkType } from '../../../core/jd/index.ts';
import { JDSchema } from '../../../core/jd/index.ts';
import type { MigratedRecord } from '../../../core/tracking/index.ts';
import { TrackingFieldsSchema } from '../../../core/tracking/index.ts';
import type { RunContext } from '../../../ports/context.ts';
import { deriveId } from './cache.ts';
import type { NotionApi } from './client.ts';
import {
  propDateStart,
  propSelectName,
  propText,
  propUrl,
  type RawPage,
} from './properties.ts';
import {
  EXCITEMENT_OPTIONS,
  PROPERTIES,
  SENIORITY_OPTIONS,
  TIMEZONE_OPTIONS,
} from './schema.ts';

const WORK_TYPE_ENUM: Record<string, WorkType> = {
  'On-site': 'onsite',
  Hybrid: 'hybrid',
  Remote: 'remote',
};

const LANE_BY_PREFIX: Record<string, string> = {
  li: 'linkedin',
  gh: 'greenhouse',
  kk: 'keka',
};

export function pageToMigratedRecord(raw: unknown, now: string): MigratedRecord {
  // implements the mapping contract above verbatim; ends with
  //   jd: JDSchema.parse(candidate),
  //   tracking: hasAnyManualField ? TrackingFieldsSchema.parse(fields) : undefined
}

export async function exportForMigration(
  api: NotionApi,
  dbId: string,
  ctx: RunContext,
  now: string = new Date().toISOString(),
): Promise<MigratedRecord[]> {
  const pages = await api.queryDatabase(dbId, ctx);
  return pages.map((page) => pageToMigratedRecord(page, now));
}
```

The mapper body follows from the contract — every rule stated; "present" for select/text means non-empty after `propText`/`propSelectName`.

- [ ] **Step 6: Run** migrate_export + properties tests — PASS. Update `index.ts`: add ONLY `export { exportForMigration } from './migrate_export.ts';`.

- [ ] **Step 7: Gate + commit** — `npm run check`; commit `feat(notion): exportForMigration + shared property readers (dedup cache/archive copies)`.

---

### Task 3: sqlite store — insert-only `importJobs` + `importTracking`

**Files:**
- Modify: `src/adapters/db/sqlite/store/store.ts`, `src/adapters/db/sqlite/store/store.test.ts`
- Verify only: `src/adapters/db/sqlite/index.ts` already exports `SqliteStore`.

**Interfaces:**
- Consumes: `TrackingFields` (Task 1, type-only import).
- Produces (used by Task 4):
  - `importJobs(jobs: JD[], syncedAt: string): number` — same column mapping as `upsertJobs` but `ON CONFLICT(id) DO NOTHING`; savepoint `jb_jobs_import`; returns inserted count. **An id already present was written by the pipeline (richer JD) and is never downgraded.**
  - `importTracking(rows: { jobId: string; fields: TrackingFields; updatedAt: string }[]): number` — `ON CONFLICT(job_id) DO NOTHING`; savepoint `jb_track_import`; FK enforced (missing job id throws — jobs import first).

- [ ] **Step 1: Failing tests** (append to `store.test.ts`, reusing `freshStore()`/`makeJd()`):

```typescript
test('importJobs inserts new rows, returns the count, and NEVER touches an existing row', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-30')], '2026-08-01T10:00:00.000Z');
  const before = store.db.prepare('SELECT * FROM jobs WHERE id = ?').get('li-30');

  const richer = makeJd('li-30');
  richer.identity.title = 'DIFFERENT TITLE FROM NOTION';
  const n = store.importJobs([richer, makeJd('li-31')], '2026-08-02T10:00:00.000Z');

  assert.equal(n, 1); // only li-31 inserted
  const after = store.db.prepare('SELECT * FROM jobs WHERE id = ?').get('li-30');
  assert.deepEqual(after, before); // byte-identical — pipeline row wins
});

test('importJobs does not revive an archived row (unlike upsertJobs)', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-32')], '2026-08-01T10:00:00.000Z');
  store.markArchived(['li-32'], '2026-08-01T12:00:00.000Z');
  store.importJobs([makeJd('li-32')], '2026-08-02T10:00:00.000Z');
  assert.equal(store.listCacheEntries().length, 0);
});

test('importTracking inserts rows and returns the count', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-20'), makeJd('li-21')], '2026-08-02T10:00:00.000Z');
  const n = store.importTracking([
    { jobId: 'li-20', fields: { status: 'Applied', notes: 'hi' }, updatedAt: '2026-08-02T10:00:00.000Z' },
    { jobId: 'li-21', fields: { status: 'Lead' }, updatedAt: '2026-08-02T10:00:00.000Z' },
  ]);
  assert.equal(n, 2);
  const row = store.db
    .prepare('SELECT status, notes FROM tracking WHERE job_id = ?')
    .get('li-20') as { status: string; notes: string };
  assert.deepEqual(row, { status: 'Applied', notes: 'hi' });
});

test('importTracking never overwrites an existing row (board edits win)', () => {
  const store = freshStore();
  store.upsertJobs([makeJd('li-22')], '2026-08-02T10:00:00.000Z');
  store.importTracking([{ jobId: 'li-22', fields: { status: 'Lead' }, updatedAt: '2026-08-02T10:00:00.000Z' }]);
  const n = store.importTracking([{ jobId: 'li-22', fields: { status: 'Offer' }, updatedAt: '2026-08-03T10:00:00.000Z' }]);
  assert.equal(n, 0);
  const row = store.db.prepare('SELECT status FROM tracking WHERE job_id = ?').get('li-22') as { status: string };
  assert.equal(row.status, 'Lead');
});

test('importTracking throws on a job id with no jobs row (FK enforced)', () => {
  const store = freshStore();
  assert.throws(() =>
    store.importTracking([{ jobId: 'li-404', fields: { status: 'Lead' }, updatedAt: '2026-08-02T10:00:00.000Z' }]),
  );
});
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** both methods in `store.ts`. `importJobs`: extract the 16-value parameter mapping shared with `upsertJobs` into a private `jobRowValues(jd: JD, syncedAt: string): unknown[]` helper used by both statements (the two SQL strings differ only in the `ON CONFLICT` clause — build them from one column-list constant so they cannot drift). `importTracking` exactly:

```typescript
importTracking(
  rows: { jobId: string; fields: TrackingFields; updatedAt: string }[],
): number {
  const stmt = this.db.prepare(
    `INSERT INTO tracking (
       job_id, status, comp_range, notes, contact,
       date_applied, next_action, next_action_date, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO NOTHING`,
  );
  let inserted = 0;
  this.db.exec('SAVEPOINT jb_track_import');
  try {
    for (const row of rows) {
      inserted += Number(
        stmt.run(
          row.jobId,
          row.fields.status ?? null,
          row.fields.compRange ?? null,
          row.fields.notes ?? null,
          row.fields.contact ?? null,
          row.fields.dateApplied ?? null,
          row.fields.nextAction ?? null,
          row.fields.nextActionDate ?? null,
          row.updatedAt,
        ).changes,
      );
    }
    this.db.exec('RELEASE jb_track_import');
  } catch (err) {
    this.db.exec('ROLLBACK TO jb_track_import');
    this.db.exec('RELEASE jb_track_import');
    throw err;
  }
  return inserted;
}
```

- [ ] **Step 4: Run** store tests — PASS — AND `node --test src/adapters/db/sqlite/connector.test.ts` (the `jobRowValues` extraction refactors `upsertJobs`, the live sync write path; its consumer tests must stay green). Watch the file-size cap: store.ts stays well under 400. **Step 5: Gate + commit** — `npm run check`; commit `feat(adapters): insert-only importJobs/importTracking for the migrate path`.

---

### Task 4: `wireMigrate` in `builders.ts`

**Files:**
- Modify: `src/cli/wire/builders.ts` (add `MigrateWire` + `wireMigrate`; add imports: `loadPipelineConfig` from `./config.ts`, `NotionApi`+`NotionSdkClientLike`+`exportForMigration`+`NotionConnectorSettingsSchema` from the notion barrel — `NotionSdkClientLike` is required by the relocated stub — `openJobsDb`+`SqliteStore`+`SqliteConnectorSettingsSchema` from the sqlite barrel, `MigratedRecord` type from core/tracking, `RunContext` type)
- Modify: `src/cli/wire/compose.ts` (ONLY: move `missingTokenNotionClient` out — see Step 3 — import it back from `./builders.ts`, and DROP the now-unused `NotionSdkClientLike` type import (~compose.ts:40-43) or lint fails; net line count must not grow)
- Modify: `src/cli/wire/index.ts` (`export type { MigrateWire } from './builders.ts'; export { wireMigrate } from './builders.ts';`)
- Test: extend `src/cli/wire/compose.test.ts`

**Interfaces:**
- Produces (consumed by Task 5):

```typescript
export interface MigrateWire {
  /** '' when the profile has no settings.notion.dbId — command errors early. */
  dbId: string;
  /** profiles/<name>/profile.json, absolute. */
  profileJsonPath: string;
  /** Resolved jobbunny.db path — printed in the summary; opening is deferred. */
  dbPath: string;
  exportRecords(ctx: RunContext): Promise<MigratedRecord[]>;
  /** Opens the DB on FIRST CALL — dry-run never calls it, so dry-run
   * creates no file. Insert-only on both tables. */
  importRecords(
    records: MigratedRecord[],
    now: string,
  ): { jobs: number; tracking: number };
}
export async function wireMigrate(
  profileName: string,
  overrides: { root?: string; readFile?: (p: string) => Promise<string> } = {},
): Promise<MigrateWire>
```

**Body rules (decisions made):**
- `root`/`readFile` resolved from `overrides` exactly as `wire()` does (`overrides.root ?? process.cwd()`, etc.). The param type is INLINE (as above) — do NOT import `WireOverrides` from `./compose.ts`; that would close a builders↔compose type cycle.
- Config via `loadPipelineConfig`.
- `dbId`: when a `settings.notion` slice exists, `NotionConnectorSettingsSchema.parse(slice).dbId`, else `''` (absent slice is never a throw).
- NotionApi: real when `NOTION_TOKEN` present, else the throwing stub. **Move `missingTokenNotionClient` (currently `compose.ts:153-161`) into `builders.ts` verbatim, export it, and change compose.ts to import it from `./builders.ts`** — one shared copy, compose.ts shrinks.
- `dbPath`: `settings.sqlite`-aware — `SqliteConnectorSettingsSchema.parse(settings.sqlite ?? {}).path ?? path.join(root, 'profiles', profileName, 'data', 'jobbunny.db')`.
- `exportRecords: (ctx) => exportForMigration(api, dbId, ctx)`.
- `importRecords`: lazily `new SqliteStore(openJobsDb(dbPath))` on first call (memoized); then `jobs: store.importJobs(records.map(r => r.jd), now)` and `tracking: store.importTracking(records.filter(r => r.tracking).map(r => ({ jobId: r.jd.identity.id, fields: r.tracking!, updatedAt: now })))`.

- [ ] **Step 1: Failing test** (in `compose.test.ts`, its existing fake-root idiom): `wireMigrate('p1', {root, readFile})` on a fixture profile with `settings.notion.dbId: 'db-x'` → `dbId === 'db-x'`, `profileJsonPath` ends with `profiles/p1/profile.json`, `dbPath` ends with `profiles/p1/data/jobbunny.db`. Second test: no `settings.notion` slice → `dbId === ''`. **No store call, no filesystem touch — do not invoke `importRecords` in these tests** (that behavior is Task 3's coverage).
- [ ] **Step 2: Run** — FAIL (`wireMigrate` not exported). **Step 3: Implement** per body rules. **Step 4: Run** compose tests + `npm run check` — the filesize invariant must pass (builders.ts lands ~250 lines; compose.ts must not grow).
- [ ] **Step 5: Commit** — `feat(wire): wireMigrate — narrow Notion-read + lazy sqlite-import composition`.

---

### Task 5: the `migrate` command + CLI registration

**Files:**
- Create: `src/cli/commands/migrate.ts`, `src/cli/commands/migrate.test.ts`
- Modify: `src/cli/main.ts` (CommandName union, COMMAND_NAMES, USAGE, defaultCommands, buildOptions, parseArgs `apply` flag, `apply?: boolean` on CommandOptions)
- Check first: if `src/cli/main.test.ts` exists, add a dispatch case following its pattern; if absent, skip.

**Interfaces:**
- Consumes: `MigrateWire`/`wireMigrate` via `../wire/index.ts` (types + default dep), `MigratedRecord` type from core.
- Produces: `migrateCommand(opts: { profile: string; apply: boolean }, deps?: Partial<MigrateDeps>): Promise<number>` with `MigrateDeps = { wireMigrate: (p: string) => Promise<MigrateWire>; write: (line: string) => void; readFile: (p: string) => Promise<string>; writeFile: (p: string, data: string) => Promise<void> }`.

**Behavior contract (decisions made):**
- `dbId === ''` → print `no settings.notion.dbId configured for this profile — nothing to migrate` → return 1 (exportRecords never called).
- `RunContext`: `{ profile, signal: AbortSignal.timeout(MIGRATE_DEADLINE_MS), logger, beat() {} }` with `const MIGRATE_DEADLINE_MS = 300_000;` and `logger` from `createWireLogger` (`ops/observability` — `compose.ts:69` shows the import; cli→ops is a legal edge). Only if its signature demands run-folder deps that don't fit a command context, fall back to a local console-backed `Logger` literal and say so in NOTES.
- Read + map via `exportRecords`; compute: total, withTracking, fallback records (`id.startsWith('nt-')`).
- Print summary: counts + one line per fallback record (`nt-… <title> — <company>`) + `db: <dbPath>`.
- Dry-run (default): print `dry-run — nothing written (no DB file created). Re-run with --apply to import and flip the connector.` → return 0. `importRecords` MUST NOT be called; profile.json untouched.
- `--apply`: `const now = new Date().toISOString()`; `const counts = wire.importRecords(records, now)`; flip profile.json (`JSON.parse` → `connector = 'sqlite'`, `settings.sqlite ??= {}`, everything else — including the `notion` slice and legacy top-level keys — byte-preserved through the round-trip → `JSON.stringify(parsed, null, 2) + '\n'`); print `imported <jobs> jobs (<total - jobs> already present, left untouched), <tracking> tracking rows; connector flipped to sqlite` → return 0.
- Errors propagate to main.ts's catch (exit 1) — no swallowing.

- [ ] **Step 1: Failing tests** — `migrate.test.ts`. The fake `MigrateWire` is a **plain object literal** — no `src/adapters/**` import anywhere under `src/cli/`, tests included (`only-wire-imports-adapters` has no test-file exemption):

```typescript
// fake: { dbId, profileJsonPath: <tmpdir>/profile.json, dbPath: '/x/jobbunny.db',
//         exportRecords: async () => FIXTURE_RECORDS,
//         importRecords: (recs, now) => { calls.push([recs, now]); return { jobs: 2, tracking: 1 }; } }
// FIXTURE_RECORDS: three MigratedRecord literals — one with full tracking, one without,
// one with an 'nt-' id.
// 1. dbId '' → returns 1, message printed, exportRecords never called.
// 2. dry-run → summary printed (counts + nt- line), importRecords NOT called,
//    profile.json (a real temp file with legacy keys: notion_db_id, schedule, notify,
//    settings.notion) byte-unchanged.
// 3. --apply → importRecords called once with (FIXTURE_RECORDS, <iso string>); profile.json
//    now has connector 'sqlite', settings.sqlite {}, AND still has settings.notion +
//    notion_db_id + schedule + notify keys intact.
// 4. exportRecords rejects → migrateCommand rejects (main maps to exit 1).
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `migrate.ts` (deps pattern from `doctor.ts`). **Step 4: Run** — PASS.
- [ ] **Step 5: Register in `main.ts`:** `'migrate'` in CommandName + COMMAND_NAMES; USAGE line `  migrate   --profile <name> [--apply]     (Notion → local sqlite import; dry-run by default)`; parseArgs `apply: { type: 'boolean', default: false }`; buildOptions case `'migrate'`: `return needsProfile() ?? { profile, apply: values.apply ?? false };`; defaultCommands entry `migrate: (async (opts: CommandOptions) => migrateCommand({ profile: opts.profile ?? '', apply: opts.apply ?? false })) as CommandFn`. (main.ts lands ~387/400 — note the shrinking headroom in your report.)
- [ ] **Step 6: Gate + commit** — `npm run check`; commit `feat(cli): jobbunny migrate — Notion → sqlite import, dry-run by default`.

---

### Task 6: runtime verification (throwaway profile only)

**Files:** none committed (verification only).

**NEVER run `migrate` against `rajni` (real Notion dbId inside) and never with `--apply` on any profile here.**

- [ ] **Step 1:** `npm run check` — green.
- [ ] **Step 2:** `node src/cli/main.ts profile build --profile zzmigratecheck` → confirm it scaffolds (connector stays `notion` — the default flip is deliberately NOT in this PR, see Deferred).
- [ ] **Step 3:** `node src/cli/main.ts migrate --profile zzmigratecheck` — Expected: exit 1, message `no settings.notion.dbId configured for this profile — nothing to migrate`.
- [ ] **Step 4:** Edit `profiles/zzmigratecheck/profile.json`: set `"settings": { "notion": { "dbId": "deadbeef" } }`. Then `env -u NOTION_TOKEN node src/cli/main.ts migrate --profile zzmigratecheck` — Expected: exit 1 with a LOUD, comprehensible error naming the missing `NOTION_TOKEN` (the wire stub's message), not stack-trace soup. Capture exact output in the report.
- [ ] **Step 5:** Confirm dry-run wrote nothing: `profiles/zzmigratecheck/data/jobbunny.db` must NOT exist.
- [ ] **Step 6:** `node src/cli/main.ts profile remove --profile zzmigratecheck --force`; `git status --porcelain` clean. Any failure → STOP, report BLOCKED.

---

## Closure (controller/advisor work — NOT part of the lead's package)

1. Final whole-branch review (opus) + one fix wave + scoped re-review.
2. kb-curator: rewrite the KB's source-of-truth frontier (§4, §2.1 reconcile/sync rows) to "the profile's primary connector store is the source of truth"; document `migrate`; record the notion-folder file-count deviation.
3. CLAUDE.md proposals to the user (verbatim, approval required): invariant rewording; Commands list gains `migrate`; **correct the stale "rajni… no Notion IDs" claim — rajni's `settings.notion.dbId` is the user's real database id** (and ask whether to scrub it to a fake id in a follow-up).
4. Merge `feat/migrate-command` → `main-db`. Gates: check green; Task 6 is the run test (no `src/pipeline/**` touched by this PR — if the final diff does touch it, also run `stage reconcile --profile rajni`).
5. Real-data proof: `migrate --profile harish` DRY-RUN against live Notion needs the user's `.env` and explicit go-ahead — ask, never assume. Only after that proof: the scaffold-default flip (see Deferred).

## Deferred (explicitly not in this PR)

- **Scaffold default flip to sqlite** (`MINIMAL_PIPELINE_CONFIG.connector`) — spec §8: "sqlite becomes the default only after this proves out" on the real profile. Lands as a follow-up commit on `main-db` after Closure item 5, with the `profile.test.ts` connector assertion (`assert.equal(JSON.parse(pipelineRaw).connector, 'sqlite')` added to the fresh-profile seed test — note: today no test asserts the scaffolded connector).
- PR 3 mirror composite (feeds on the preserved `settings.notion` slice + `sync.pageId` anchors).
- PR 4 app/board (BoardStore port; excitement vocab relocation; Connector close() lifecycle).
- Review Flags / yoe / source_url columns absent from the v1 `jobs` schema (spec §3 lists them; PR-1 shipped without — migrate therefore does not import Review Flags; add via forward migration when the board needs them).
- `listCacheEntries` truthy→`!== null` city check; `migrations.ts` pragma-before-downgrade-check order; `stage.ts` UTC run-folder date bug (pre-existing, tracked separately).
