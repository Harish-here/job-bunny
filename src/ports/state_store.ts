import type { ZodType } from 'zod';

/** Pipeline STATE document store (persist-to-db Phase 3) — the ten
 * per-profile JSON files that used to flow through `ports/storage.ts`'s
 * `readJson`/`writeJson` (registry, cache, structure hand-off, LinkedIn
 * lane resume/capture state — see the spec's inventory table). Keys are
 * the EXISTING relPath strings verbatim (e.g. `'registry/api_seen.json'`,
 * `'structure/decisions.json'`) — they are already exported constants in
 * the modules that own them; they become the stable document keys here,
 * giving a 1:1 file→row import mapping and zero constant churn.
 *
 * Read semantics are UNCHANGED from `Storage.readJson`: `undefined` when
 * the key is absent, throws on schema mismatch. `writeDoc` is LOUD (throws
 * on any failure) — UNLIKE `RunStore`'s permanent fail-soft degradation,
 * and matching `CheckpointStore.write`'s posture: state is pipeline data
 * (a lost registry write silently reintroduces already-seen jobs as new,
 * L9), never an observability nice-to-have.
 *
 * The one-time lazy import of a legacy JSON file on a DB miss (the L9
 * mechanism — harish's existing `registry/companies.json` etc. must
 * survive the cutover) is NOT part of this port's contract: it is an
 * implementation detail of the sqlite adapter (`SqliteStateStore`,
 * `adapters/db/sqlite/state/`), invisible to every caller. A caller sees
 * only "was there a value for this key" — never whether that value came
 * from a DB row or a freshly-lifted file.
 *
 * Promise signatures are kept for drop-in compatibility with the
 * `Storage.readJson`/`writeJson` call sites this port replaces, even
 * though the sqlite adapter itself is synchronous under the hood
 * (`node:sqlite`'s `DatabaseSync`, same as `RunStore`/`CheckpointStore`). */
export interface StateStore {
  /** `undefined` when absent; throws on schema mismatch (posture unchanged
   * from `Storage.readJson`). */
  readDoc<T>(key: string, schema: ZodType<T>): Promise<T | undefined>;
  /** LOUD: throws on failure — state is pipeline data, never silently
   * dropped (contrast `RunStore`'s fail-soft degradation). */
  writeDoc(key: string, value: unknown): Promise<void>;
  close(): void;
}
