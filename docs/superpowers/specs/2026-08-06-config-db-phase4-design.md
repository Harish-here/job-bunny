# Phase 4 design — config → per-profile sqlite DB + board UI

Final phase of the persist-to-db program (umbrella §Phase 4). Builds on schema v4. Author: advisor (overnight authorization, ledger L3/L7).

## Goal

`profile.json`, `filter.json`, `resume.json`, `search_urls.md` become rows in `jobbunny.db` (`config_docs`, schema v5) with zod at the write boundary; the board gains config editing and profile creation; `jobbunny config export/import` is the JSON escape hatch. Done when a fresh profile can be created, configured, and run without hand-editing any file, and the rajni fixture rebuilds via import.

## The bootstrap decision (resolves recon friction #2 and ledger L22's deferred collision)

`resolveSqlitePath` today reads `profile.json` to FIND the DB — circular once `profile.json` lives IN the DB. **Resolution: the DB path becomes canonical and fixed — `profiles/<name>/data/jobbunny.db` — and `settings.sqlite.path` is retired.** Verified safe: both real profiles carry `settings.sqlite: {}` (no custom path anywhere). A lifted or hand-written config that still sets `settings.sqlite.path` is a LOUD wire error and a doctor red with the message `settings.sqlite.path is no longer supported — the database always lives at profiles/<name>/data/jobbunny.db; move the file there and delete the setting`. This also eliminates the cross-profile shared-path state collision deferred in L22 (no path knob → no sharing), and collapses the hand-rolled `settings.sqlite` walks in `board.ts`/`wire/daemon.ts`.

## Schema v5

```sql
CREATE TABLE config_docs (
  key        TEXT PRIMARY KEY,   -- 'profile.json' | 'filter.json' | 'resume.json' | 'search_urls.md'
  value_text TEXT NOT NULL,      -- raw document text (JSON text for the three JSON docs; raw markdown for search_urls.md)
  updated_at TEXT NOT NULL
);
```

Keys are the legacy filenames (Phase 3's key convention). `value_text` stores the document's RAW TEXT, not a normalized re-serialization — see lift semantics.

## Port: `ports/config_store.ts`

```ts
export type ConfigDocKey = 'profile.json' | 'filter.json' | 'resume.json' | 'search_urls.md';
export interface ConfigStore {
  /** Raw text; undefined when absent. LOUD on store failure. */
  readText(key: ConfigDocKey): Promise<string | undefined>;
  /** Validation happens at THIS boundary: the adapter stores rawText only after
   *  the caller-supplied check passes (see per-key validators below). */
  writeText(key: ConfigDocKey, rawText: string): Promise<void>;
  close(): void;
}
```

Per-key validators live in `core/config` (pure): `profile.json` → `PipelineConfigSchema.parse(JSON.parse(text))`; `filter.json` → `FilterConfigSchema.parse(...)`; `resume.json` → JSON-validity only (its zod schema is dead code that doesn't match reality — see cleanup below); `search_urls.md` → non-empty string. `writeText` in every production writer calls the validator FIRST (write-boundary zod, umbrella D-requirement); `readText` returns raw text and each reader keeps its EXACT current parse posture (fail-loud `.parse` in `loadPipelineConfig`, tolerant hand-probe in the board, `safeParse`-skip in the daemon scan, raw `JSON.parse` in setup) — behavior identity per call site, per the recon's 12-posture map.

## Adapter: `adapters/db/sqlite/config/` — `SqliteConfigStore(dbPath, profileDir, deps?)`

- Same shared-DB open path/pragmas; LOUD posture.
- **Lazy lift (Phase 3's corrected pattern):** `readText` miss → legacy file at `<profileDir>/<key>` → **validate BEFORE insert** (JSON-validity for the three JSON docs, non-empty for the md; NOT full schema — lift must not choke on rajni's tolerated legacy v0 keys, which today's non-strict `z.object` allows through readers) → INSERT raw file text unmodified → return. Legacy files never modified/deleted (inert; rajni's stay tracked as the fixture import source). `writeText` never touches files.
- Storing RAW text (not parsed-then-reserialized) preserves unknown-key and formatting fidelity — `migrate --apply`'s observable behavior on legacy-shaped configs is unchanged.

## Reader migration (postures preserved per recon)

- `cli/wire/config.ts` `loadPipelineConfig`/`loadFilterConfig`: read via ConfigStore (constructed on the canonical path), parse exactly as today (loud / optional-but-strict). Missing doc AND no legacy file → same throw as today's missing `profile.json`.
- `cli/wire/board.ts` `readProfileInfo`: canonical dbPath (no config read needed for the path!); `connector` probed from the config doc via a short-lived store, same bare-try/tolerant `''` fallback; `hasDb = existsSync(canonical)`. The `openStore` membership gate (path-traversal defense) is UNCHANGED — discovery stays `readdirSync(profiles/)` (filesystem-is-registry, umbrella D-decision).
- `cli/wire/daemon.ts` `resolveProfileDbPath`: becomes the canonical-path helper (no file read); the existsSync-guard/no-create/fresh-store-per-read discipline from Phase 2 applies to its config reads too.
- `ops/daemon/scan/scan.ts`: schedule read via a short-lived ConfigStore per profile, `safeParse`-skip posture unchanged; never creates a DB (existsSync guard — a never-run profile has no DB and no legacy file → skipped, same as today's missing-file skip; a legacy-only profile lifts).
- `cli/commands/setup.ts` `readConnectorNeeds` + `stepSearchUrls` + `stepResume`: via ConfigStore (raw text, own parsing preserved).
- The three `search_urls.md` parsers keep operating on the doc STRING unchanged — consolidation is a refactor deferred beyond this program (noted, not done: transport-only phase).

## Write surfaces

- **CLI:** `jobbunny config get <doc> --profile <p>` (raw text to stdout) / `config set <doc> --profile <p>` (stdin, TTY-refused, validator-gated) / `config export --profile <p> [--dir <d>]` (writes the four legacy-named files) / `config import --profile <p> [--dir <d>]` (validator-gated writes from files). Export→import round-trips byte-exact.
- **`lane add-url`:** same string surgery, on `readText('search_urls.md') ?? template` → surgery → `writeText`.
- **`profile build`:** seeds missing DOCS with the same templates via validator-gated `writeText` (never clobbers an existing row or a legacy file pending lift — check row AND file absence). **`avoid.md` seeding is deleted** (dead surface, umbrella-sanctioned) — `profile build` stops creating it; existing files untouched.
- **`migrate --apply`:** its profile.json read-modify-write goes through the store (read raw → same key edits → write; validated as JSON-validity + PipelineConfigSchema on the RESULT — its output is schema-shaped today, so this is safe).
- **Board:** `GET/PUT /api/profiles/:name/config/:doc` (PUT validator-gated, 422 with the zod error message on failure) and `POST /api/profiles` `{name}` (name-sanitized: `^[a-z0-9_-]+$`, mkdir `profiles/<name>/data`, seed docs into a fresh DB — the `profile build` seeding path reused). Board UI: a Settings page per profile — raw-text editors for the four docs with server-side validation errors surfaced, plus a create-profile form. Deliberately NOT form-builders over the schema (v1 scope; the escape hatch is the point).
- **`/setup` command doc:** steps that hand-edit files (4, 5, 6, 7, 9 per recon) switch to `jobbunny config get|set` pipes.
- **`profile remove`:** unchanged — `rm -rf profiles/<name>/` already removes the DB and thus the config rows; docs updated to say so.

## Dead code removed

`src/core/profile/` (ResumeSchema et al.) — zero importers, shape doesn't match reality; deleted. Root `config.json` handling if any exists (umbrella lists it; recon found none live — verify by grep, delete remnants).

## Hard-rule amendment (PRE-APPROVED, ledger L7 — applied in-phase)

CLAUDE.md's board bullet becomes, verbatim as approved: "**The board server binds `127.0.0.1` and writes only the `tracking` and config tables.** `jobs` and the runs tables stay pipeline/runner-only — the split is structural (`ports/board.ts`)." Enforced structurally: the board's write surface is `updateTracking` + the new config writes; `ports/board.ts` doc states it. Other CLAUDE.md lines that become stale (Profiles section's file-editing language, `avoid.md` note, `settings.sqlite` mentions) are NOT edited — proposed replacements go to the ledger for morning approval.

## Testing and rollout

- Unit: migration v5; store CRUD + raw-fidelity + lift-validates-before-insert (incl. rajni-shaped v0-keys config lifting successfully); per-reader posture pins (loud/tolerant/skip preserved); validator gates (bad JSON → 422/CLI exit 1, schema violation names the field); export/import round-trip; sqlite.path retirement error (wire loud + doctor red); board create-profile name sanitization + traversal defense intact.
- **Live verification (rajni, L10 precheck):** (a) fresh DB: first `wire()` lifts all four tracked fixture docs (rows match files byte-exact); (b) full staged chain + resume runs green reading config from DB only (move legacy files aside for run 2); (c) `config export` reproduces the four files byte-exact vs the tracked fixtures; (d) board: edit filter.json via PUT (invalid → 422 with zod message; valid → row updated), create a throwaway profile via POST, run `profile remove --force` on it; (e) `lane add-url` surgery lands in the doc; (f) fresh v0→v5 migration.
- The final program gate (live harish run on the merged branch) exercises the whole lift chain on real data.
