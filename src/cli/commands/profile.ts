/**
 * commands/profile.ts (P8) — `profile build --profile <p>` and
 * `profile remove --profile <p>`: the onboarding scaffold and its
 * destructive undo. `build` is seed-never-clobber: it creates
 * `profiles/<p>/` and seeds any MISSING scaffold file, leaving an
 * existing file byte-for-byte untouched (`seedProfileFiles` is exported
 * so `setup.ts` reuses the identical rule set instead of duplicating
 * it). `remove` deletes the whole profile directory — destructive, so
 * it only prints what would be removed and exits non-zero unless
 * `--force` is passed (mirrors v0 `scripts/setup/remove_profile.js`'s
 * dry-run-by-default posture).
 *
 * No `src/adapters/**` import — all filesystem access goes through
 * injected deps so tests use a temp dir and never touch the real
 * `profiles/`.
 */
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';

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
  file: string;
  status: 'created' | 'kept';
}

// Minimal-but-valid: connector must name a real adapter for `wire()` to
// resolve later.
// New profiles still scaffold to 'notion' — the default flips to 'sqlite'
// once the migrate command lands (local-DB spec §8).
const MINIMAL_PIPELINE_CONFIG = {
  lanes: [],
  connector: 'notion',
  notifiers: [],
  routines: [],
  settings: {},
};

// Every FilterConfig field is optional — {} is already a minimal valid
// config (no rules configured, filter stage is a pass-through).
const MINIMAL_FILTER_CONFIG = {};

const SEARCH_URLS_TEMPLATE = `# Search URLs

Hierarchical: Channel -> page -> labeled URLs. One page-type = one inventory in \`src/adapters/lanes/linkedin/page_inventory/<page>.md\`; many URLs may live beneath it.
Add URLs with \`lane add-url\` (strips ephemeral params). Format: \`  • <label> - <url>\`
`;

const AVOID_TEMPLATE = `# Avoid List

Companies to drop in Stage A (extract, on card data — before opening JDs).
Matching normalizes both sides: lowercase, strip legal suffixes (Pvt, Ltd, Inc, Technologies, Software, Labs), apply the alias map.

## Alias map (variant -> canonical)
`;

/** Seeds any missing scaffold file under `profileDir`; leaves an existing
 * file byte-for-byte untouched. Every seeded JSON file is validated
 * against its real zod schema before being written. Shared by
 * `profile build` and `setup` so the two never disagree on what a fresh
 * profile looks like. */
export async function seedProfileFiles(
  profileDir: string,
  deps: ProfileFsDeps,
): Promise<SeedResult[]> {
  await deps.mkdir(profileDir);

  const results: SeedResult[] = [];

  const seed = async (file: string, contents: string) => {
    const p = path.join(profileDir, file);
    if (await deps.exists(p)) {
      results.push({ file, status: 'kept' });
      return;
    }
    await deps.writeFile(p, contents);
    results.push({ file, status: 'created' });
  };

  const pipelineJson = `${JSON.stringify(PipelineConfigSchema.parse(MINIMAL_PIPELINE_CONFIG), null, 2)}\n`;
  const filterJson = `${JSON.stringify(FilterConfigSchema.parse(MINIMAL_FILTER_CONFIG), null, 2)}\n`;

  await seed('profile.json', pipelineJson);
  await seed('filter.json', filterJson);
  await seed('search_urls.md', SEARCH_URLS_TEMPLATE);
  await seed('avoid.md', AVOID_TEMPLATE);

  return results;
}

export interface ProfileBuildOptions {
  profile: string;
}

export async function profileBuildCommand(
  opts: ProfileBuildOptions,
  deps: Partial<ProfileFsDeps> = {},
): Promise<number> {
  const resolved: ProfileFsDeps = { ...defaultProfileFsDeps(), ...deps };
  const profileDir = path.join(resolved.root, 'profiles', opts.profile);
  const results = await seedProfileFiles(profileDir, resolved);
  for (const r of results) {
    resolved.write(`[profile build] profiles/${opts.profile}/${r.file}: ${r.status}`);
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
