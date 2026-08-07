/**
 * commands/profile.ts (P8; config→db Phase 4, Task 7) — `profile build
 * --profile <p>` and `profile remove --profile <p>`: the onboarding
 * scaffold and its destructive undo. `build` is seed-never-clobber: it
 * creates `profiles/<p>/` and seeds any MISSING scaffold doc, leaving an
 * existing doc byte-for-byte untouched (`seedProfileDocs` is exported so
 * `setup.ts` reuses the identical rule set instead of duplicating it).
 * `remove` deletes the whole profile directory — destructive, so it only
 * prints what would be removed and exits non-zero unless `--force` is
 * passed (mirrors v0 `scripts/setup/remove_profile.js`'s dry-run-by-
 * default posture); `remove` is unaffected by this task — it deletes the
 * whole directory (config db included) and never reads/writes an
 * individual doc, so it stays on plain `ProfileFsDeps`.
 *
 * `seedProfileDocs` writes through the injected `ConfigStore` seam
 * (`ProfileDocsDeps.configStore`, default `wireConfigStore` — a plain
 * function import from `../wire/index.ts`, never `src/adapters/**`
 * directly) rather than raw `exists`/`readFile`/`writeFile`: "does this
 * doc already exist" is answered by `store.readText(doc) !== undefined`,
 * which already covers BOTH a real `config_docs` row and a legacy file
 * with no row yet (`SqliteConfigStore`'s own lazy lift — see
 * `ports/config_store.ts`).
 *
 * No `src/adapters/**` import — all filesystem access goes through
 * injected deps so tests use a temp dir/fake store and never touch the
 * real `profiles/`.
 */
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import type { ConfigDocKey, ConfigStore } from '../../ports/config_store.ts';
import { wireConfigStore } from '../wire/index.ts';

export interface ProfileFsDeps {
  root: string;
  exists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<unknown>;
  write: (line: string) => void;
}

export function defaultProfileFsDeps(): ProfileFsDeps {
  return {
    root: process.cwd(),
    exists: (p) =>
      access(p, constants.F_OK)
        .then(() => true)
        .catch(() => false),
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, data) => writeFile(p, data),
    mkdir: (p) => mkdir(p, { recursive: true }),
    write: (line) => console.log(line),
  };
}

export interface SeedResult {
  doc: ConfigDocKey;
  status: 'created' | 'kept';
}

// Minimal-but-valid: connector must name a real adapter for wire() to
// resolve. Local-first default since the migrate command proved out
// (local-DB spec §8); 'notion' remains a valid opt-in.
const MINIMAL_PIPELINE_CONFIG = {
  lanes: [],
  connector: 'sqlite',
  notifiers: [],
  routines: [],
  settings: {},
};

// Every FilterConfig field is optional — {} is already a minimal valid
// config (no rules configured, filter stage is a pass-through).
const MINIMAL_FILTER_CONFIG = {};

const SEARCH_URLS_TEMPLATE = `# Search URLs

Hierarchical: Channel -> page -> labeled URLs. One page-type = one inventory in \`src/adapters/lanes/linkedin/page_inventory/<page>.json\`; many URLs may live beneath it.
Add URLs with \`lane add-url\` (strips ephemeral params). Format: \`  • <label> - <url>\`
`;

// avoid.md is no longer seeded here (config→db Phase 4, Task 7): it was
// never migrated into `config_docs` — it stays scaffolded-but-unmanaged,
// exactly as CLAUDE.md already documents ("avoid.md is scaffolded but
// read by no runtime code"). Existing avoid.md files on disk are
// untouched by this — only the SEEDING of new ones stopped.

export interface ProfileDocsDeps {
  root: string;
  /** Test seam — a factory so each call scopes and closes its OWN
   * short-lived store, never a shared/memoized instance. Default binds
   * `wireConfigStore` to the FINAL resolved `root`. */
  configStore: (profileName: string) => ConfigStore;
  mkdir: (path: string) => Promise<unknown>;
  write: (line: string) => void;
}

/** Everything except `configStore`, whose default binds to the FINAL
 * resolved `root` (computed by `profileBuildCommand` after merging
 * overrides — same posture as `config.ts`/`setup.ts`). */
function defaultProfileDocsFsDeps(): Omit<ProfileDocsDeps, 'configStore'> {
  return {
    root: process.cwd(),
    mkdir: (p) => mkdir(p, { recursive: true }),
    write: (line) => console.log(line),
  };
}

/** Distinguishes the ONE failure shape `readText` may throw that
 * `seedProfileDocs` (below) is entitled to treat as "present" (fix round,
 * critical finding) — `SqliteConfigStore`'s own lift-time check, which
 * always throws a message starting with this exact prefix (both the real
 * adapter's "Malformed legacy config file at ..." and any test fake's
 * shorter "Malformed legacy config file: ..." match). Anything else —
 * store construction, db-open (corrupt/newer-schema/permission-denied)
 * failures — must NOT be silently reported "kept"; the old code's bare
 * `catch { ... }` swallowed both alike, turning a broken db into a false
 * all-clear (`profile build`/`profile.json: kept` while nothing was
 * actually read or written).
 *
 * Belt-and-braces error-contract check (fix round 2): the canonical signal
 * is `err.name === 'MalformedLegacyConfigFileError'`
 * (`adapters/db/sqlite/config/store.ts` sets it explicitly on this throw);
 * the message-prefix match here is a fallback for anything that doesn't
 * carry that name (e.g. a test fake using a bare `Error`). */
function isMalformedLegacyFileError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'MalformedLegacyConfigFileError') return true;
  return err.message.startsWith('Malformed legacy config file');
}

/** Seeds any missing scaffold doc for `profileName` — `profile.json`,
 * `filter.json`, `search_urls.md`, in that order — leaving an existing
 * doc byte-for-byte untouched. "Existing" means present as EITHER a real
 * `config_docs` row or a legacy file with no row yet: `store.readText`
 * already lifts-and-returns a legacy file in that second case (see
 * `SqliteConfigStore`), so a single `readText(doc) !== undefined` check
 * covers both — no separate file-existence check is needed or correct
 * (it would race/duplicate what the adapter already guarantees).
 * `resume.json` is deliberately NEVER seeded here — it's hand-maintained,
 * and `setup`'s own `resume.json` step reports `needs-action` on absence
 * to drive the `/setup` wizard; seeding `{}` would silence that signal.
 * Every seeded JSON doc is validated against its real zod schema before
 * being written. Shared by `profile build` and `setup` so the two never
 * disagree on what a fresh profile looks like. */
export async function seedProfileDocs(
  profileName: string,
  deps: ProfileDocsDeps,
): Promise<SeedResult[]> {
  await deps.mkdir(path.join(deps.root, 'profiles', profileName));

  const results: SeedResult[] = [];
  const store = deps.configStore(profileName);

  try {
    const seed = async (doc: ConfigDocKey, template: string) => {
      let existing: string | undefined;
      try {
        existing = await store.readText(doc);
      } catch (err) {
        if (!isMalformedLegacyFileError(err)) throw err;
        // A legacy file present but malformed enough to fail the store's
        // own lift-time check still counts as "present" — never mask or
        // overwrite an existing (if broken) user file; doctor/setup's
        // other steps already surface the malformed-content problem
        // loudly on their own.
        results.push({ doc, status: 'kept' });
        return;
      }
      if (existing !== undefined) {
        results.push({ doc, status: 'kept' });
        return;
      }
      await store.writeText(doc, template);
      results.push({ doc, status: 'created' });
    };

    const pipelineJson = `${JSON.stringify(PipelineConfigSchema.parse(MINIMAL_PIPELINE_CONFIG), null, 2)}\n`;
    const filterJson = `${JSON.stringify(FilterConfigSchema.parse(MINIMAL_FILTER_CONFIG), null, 2)}\n`;

    await seed('profile.json', pipelineJson);
    await seed('filter.json', filterJson);
    await seed('search_urls.md', SEARCH_URLS_TEMPLATE);
  } finally {
    store.close();
  }

  return results;
}

export interface ProfileBuildOptions {
  profile: string;
}

export async function profileBuildCommand(
  opts: ProfileBuildOptions,
  deps: Partial<ProfileDocsDeps> = {},
): Promise<number> {
  const fsDeps: Omit<ProfileDocsDeps, 'configStore'> = {
    ...defaultProfileDocsFsDeps(),
    ...deps,
  };
  const resolved: ProfileDocsDeps = {
    ...fsDeps,
    configStore:
      deps.configStore ?? ((name) => wireConfigStore(name, { root: fsDeps.root })),
  };
  const results = await seedProfileDocs(opts.profile, resolved);
  for (const r of results) {
    resolved.write(`[profile build] profiles/${opts.profile}/${r.doc}: ${r.status}`);
  }
  return 0;
}

export interface ProfileRemoveOptions {
  profile: string;
  force?: boolean;
}

export interface ProfileRemoveDeps extends ProfileFsDeps {
  readdir: (path: string) => Promise<string[]>;
  rm: (path: string) => Promise<void>;
}

function defaultRemoveDeps(): ProfileRemoveDeps {
  return {
    ...defaultProfileFsDeps(),
    readdir: (p) => readdir(p),
    rm: (p) => rm(p, { recursive: true, force: true }),
  };
}

// The committed fixture profile used by /verify — never removable via
// this command (mirrors v0 remove_profile.js's guard).
const PROTECTED_PROFILES = new Set(['rajni']);

export async function profileRemoveCommand(
  opts: ProfileRemoveOptions,
  deps: Partial<ProfileRemoveDeps> = {},
): Promise<number> {
  const resolved: ProfileRemoveDeps = { ...defaultRemoveDeps(), ...deps };
  const profileDir = path.join(resolved.root, 'profiles', opts.profile);

  if (!(await resolved.exists(profileDir))) {
    resolved.write(
      `[profile remove] profiles/${opts.profile}/ does not exist — nothing to remove.`,
    );
    return 1;
  }

  if (PROTECTED_PROFILES.has(opts.profile)) {
    resolved.write(
      `[profile remove] "${opts.profile}" is a protected fixture profile — never removable via this command.`,
    );
    return 1;
  }

  let entries: string[] = [];
  try {
    entries = await resolved.readdir(profileDir);
  } catch {
    entries = [];
  }

  if (!opts.force) {
    resolved.write(
      `[profile remove] would remove profiles/${opts.profile}/ (${entries.length} entries):`,
    );
    for (const e of entries) resolved.write(`  - ${e}`);
    resolved.write(
      '[profile remove] dry-run — nothing was touched. Re-run with --force to actually remove.',
    );
    return 1;
  }

  await resolved.rm(profileDir);
  resolved.write(
    `[profile remove] deleted profiles/${opts.profile}/ (${entries.length} entries)`,
  );
  return 0;
}
