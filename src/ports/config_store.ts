import type { ZodType } from 'zod';

export type ConfigDocKey =
  | 'profile.json'
  | 'filter.json'
  | 'resume.json'
  | 'search_urls.md';

/**
 * Pipeline CONFIG document store (config→db Phase 4) — the four per-profile
 * hand-edited documents (`profile.json`, `filter.json`, `resume.json`,
 * `search_urls.md`) that used to live as bare files under `profiles/<name>/`.
 * Keys are the legacy filenames verbatim (Phase 3's key-convention
 * precedent, `ports/state_store.ts`) — stable document keys, zero constant
 * churn for the readers that already export them.
 *
 * `readText` returns the document's RAW TEXT (JSON text for the three JSON
 * docs, raw markdown for `search_urls.md`) — never a parsed value. Each
 * caller keeps its OWN existing parse posture (fail-loud `.parse` in
 * `loadPipelineConfig`, tolerant hand-probe in the board, `safeParse`-skip
 * in the daemon scan, raw `JSON.parse` in setup) — this port carries text,
 * it does not itself parse or validate on read.
 *
 * `writeText` validates BEFORE storing: the per-key validators in
 * `core/config/validators.ts` (`validateConfigDoc`) run first, in every
 * production writer, and this port's own contract assumes that discipline —
 * an adapter implementing this port is free to enforce it a second time
 * (see `SqliteConfigStore`), but the port itself does not carry the
 * validator; that stays pure (`core/`), never imported here.
 */
export interface ConfigStore {
  /** Raw text; `undefined` when absent. LOUD on store failure. */
  readText(key: ConfigDocKey): Promise<string | undefined>;
  /** Stores `rawText` UNMODIFIED under `key`. LOUD on failure. */
  writeText(key: ConfigDocKey, rawText: string): Promise<void>;
  close(): void;
}
