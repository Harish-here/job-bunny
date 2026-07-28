/**
 * cli/wire/config.ts (P8, split from wire.ts) — config loading:
 * `loadPipelineConfig`/`loadFilterConfig` read `profiles/<name>/profile.json`
 * / `filter.json`, parse, and validate against the core schemas. This is
 * fail-loud config, NOT a doctor check — a missing/invalid `profile.json`
 * throws immediately (mirrors `ops/doctor/aggregate.ts`'s
 * `profileParsesCheck`, which reports the same failure as a `red` finding
 * instead — the two are deliberately redundant: one lets `/doctor` explain
 * *why* wiring would fail without throwing, the other actually enforces it
 * at wire time).
 *
 * PURE — no `src/adapters/**` import, unlike `compose.ts`.
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { PipelineConfig } from '../../core/config/schema.ts';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import type { FilterConfig } from '../../core/filter/config.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';

// --- shared IO-injection deps ---

export interface ConfigLoaderDeps {
  root?: string;
  readFile?: (path: string) => Promise<string>;
}

function resolveRoot(deps: ConfigLoaderDeps): string {
  return deps.root ?? process.cwd();
}

function resolveReadFile(deps: ConfigLoaderDeps): (path: string) => Promise<string> {
  return deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
}

/** Shared with `compose.ts` (the `search_urls.md`/linkedin-lane ENOENT
 * paths) — internal to the `wire/` module, not part of its public surface. */
export function isNotFound(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT',
  );
}

// --- config loaders ---

/** Reads + validates `profiles/<name>/profile.json`. Fail-loud: a missing
 * file, invalid JSON, or schema mismatch all throw — the pipeline can't be
 * wired without a valid config. */
export async function loadPipelineConfig(
  profileName: string,
  deps: ConfigLoaderDeps = {},
): Promise<PipelineConfig> {
  const readFile = resolveReadFile(deps);
  const filePath = path.join(resolveRoot(deps), 'profiles', profileName, 'profile.json');
  const raw = await readFile(filePath);
  return PipelineConfigSchema.parse(JSON.parse(raw));
}

/** Reads + validates `profiles/<name>/filter.json`. The file is
 * optional (missing ⇒ `undefined`); present-but-invalid still throws —
 * this isn't a doctor check, so it never soft-fails. */
export async function loadFilterConfig(
  profileName: string,
  deps: ConfigLoaderDeps = {},
): Promise<FilterConfig | undefined> {
  const readFile = resolveReadFile(deps);
  const filePath = path.join(resolveRoot(deps), 'profiles', profileName, 'filter.json');
  let raw: string;
  try {
    raw = await readFile(filePath);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  return FilterConfigSchema.parse(JSON.parse(raw));
}
