/**
 * commands/config.ts (config→db Phase 4, Task 6) — `jobbunny config
 * get|set|export|import`: a narrow CLI surface over exactly the four
 * legacy-named config documents (`profile.json`, `filter.json`,
 * `resume.json`, `search_urls.md`) that `ConfigStore` (`ports/
 * config_store.ts`) now owns. `get`/`set` are single-doc raw-text
 * read/write (same TTY-refusal idiom as `state.ts`'s `write`); `export`/
 * `import` move all four docs to/from a plain directory of legacy-named
 * files — `export` for a rebuild/inspection flow (default `--dir
 * profiles/<name>/export/`, gitignored), `import` for seeding a store from
 * disk (missing file = skipped, never an error).
 *
 * This module is under `cli/commands/`, not the `only-wire-imports-adapters`
 * carve-out, so it reaches the store only through `wireConfigStore` (a
 * plain function import from `../wire/index.ts`, never `src/adapters/**`
 * directly) — exactly like `doctorCommand`/`stateCommand`/`setupCommand`
 * already do.
 */
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigStore } from '../../ports/config_store.ts';
import { wireConfigStore } from '../wire/index.ts';

export type ConfigDocName =
  | 'profile.json'
  | 'filter.json'
  | 'resume.json'
  | 'search_urls.md';

/** Fixed order every `export`/`import` walk follows — deterministic
 * output ordering for both the written-lines log and the on-disk files. */
const DOC_ORDER: readonly ConfigDocName[] = [
  'profile.json',
  'filter.json',
  'resume.json',
  'search_urls.md',
];

export interface ConfigCommandOptions {
  profile: string;
  action: 'get' | 'set' | 'export' | 'import';
  /** Required for `get`/`set`. */
  doc?: ConfigDocName;
  /** Optional for `export`/`import` — default `profiles/<profile>/export/`. */
  dir?: string;
}

export interface ConfigDeps {
  /** Test seam — a factory so each call scopes and closes its OWN
   * short-lived store, never a shared/memoized instance. Default binds
   * `wireConfigStore` to `root` (the FINAL resolved root — `configCommand`'s
   * own `deps.root` override, if any — never a pre-merge snapshot, same
   * posture as `setup.ts`'s `configStore` default). */
  configStore: (profileName: string) => ConfigStore;
  /** Injected so `set`'s TTY guard stays testable without a real terminal
   * — defaults to the real `process.stdin.isTTY` check. */
  isStdinTty: () => boolean;
  readStdin: () => Promise<string>;
  /** `get`'s raw doc channel — NO injected newline, same rationale as
   * `state.ts`'s `writeRaw`: a caller piping the output into a
   * byte-identity diff would see a spurious trailing newline otherwise. */
  writeRaw: (text: string) => void;
  /** `export`/`import`'s per-doc summary lines. */
  write: (line: string) => void;
  stderr: (line: string) => void;
  root: string;
  exists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<unknown>;
}

/** Everything except `configStore`, whose default binds to the FINAL
 * resolved `root` (computed by `configCommand` after merging overrides —
 * see `ConfigDeps.configStore`'s own doc comment). */
function defaultFsDeps(): Omit<ConfigDeps, 'configStore'> {
  return {
    isStdinTty: () => process.stdin.isTTY === true,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    writeRaw: (text: string) => {
      process.stdout.write(text);
    },
    write: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
    root: process.cwd(),
    exists: async (p: string) => {
      try {
        await access(p, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (p: string) => readFile(p, 'utf8'),
    writeFile: (p: string, data: string) => writeFile(p, data, 'utf8'),
    mkdir: (p: string) => mkdir(p, { recursive: true }),
  };
}

async function runGet(opts: ConfigCommandOptions, deps: ConfigDeps): Promise<number> {
  const doc = opts.doc as ConfigDocName;
  const store = deps.configStore(opts.profile);
  try {
    const text = await store.readText(doc);
    if (text === undefined) {
      deps.stderr(`config get: no document found for "${doc}"`);
      return 1;
    }
    deps.writeRaw(text);
    return 0;
  } finally {
    store.close();
  }
}

async function runSet(opts: ConfigCommandOptions, deps: ConfigDeps): Promise<number> {
  const doc = opts.doc as ConfigDocName;
  if (deps.isStdinTty()) {
    deps.stderr('config set: expects the document on stdin (pipe it in)');
    return 1;
  }
  const content = await deps.readStdin();
  const store = deps.configStore(opts.profile);
  try {
    await store.writeText(doc, content);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(message);
    return 1;
  } finally {
    store.close();
  }
}

function resolveDir(opts: ConfigCommandOptions, deps: ConfigDeps): string {
  return opts.dir ?? path.join(deps.root, 'profiles', opts.profile, 'export');
}

async function runExport(opts: ConfigCommandOptions, deps: ConfigDeps): Promise<number> {
  const dir = resolveDir(opts, deps);
  await deps.mkdir(dir);
  const store = deps.configStore(opts.profile);
  try {
    for (const key of DOC_ORDER) {
      const text = await store.readText(key);
      if (text === undefined) {
        deps.write(`config export: ${key}: skipped (not present)`);
        continue;
      }
      const filePath = path.join(dir, key);
      await deps.writeFile(filePath, text);
      deps.write(`config export: ${key}: wrote ${filePath}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function runImport(opts: ConfigCommandOptions, deps: ConfigDeps): Promise<number> {
  const dir = resolveDir(opts, deps);
  const store = deps.configStore(opts.profile);
  let rejected = false;
  try {
    for (const key of DOC_ORDER) {
      const filePath = path.join(dir, key);
      if (!(await deps.exists(filePath))) {
        deps.write(`config import: ${key}: skipped (file not found)`);
        continue;
      }
      const text = await deps.readFile(filePath);
      try {
        await store.writeText(key, text);
        deps.write(`config import: ${key}: imported`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.write(`config import: ${key}: rejected — ${message}`);
        rejected = true;
      }
    }
    return rejected ? 1 : 0;
  } finally {
    store.close();
  }
}

export async function configCommand(
  opts: ConfigCommandOptions,
  deps: Partial<ConfigDeps> = {},
): Promise<number> {
  const fsDeps: Omit<ConfigDeps, 'configStore'> = { ...defaultFsDeps(), ...deps };
  const resolved: ConfigDeps = {
    ...fsDeps,
    configStore:
      deps.configStore ?? ((name) => wireConfigStore(name, { root: fsDeps.root })),
  };

  if (opts.action === 'get') return runGet(opts, resolved);
  if (opts.action === 'set') return runSet(opts, resolved);
  if (opts.action === 'export') return runExport(opts, resolved);
  return runImport(opts, resolved);
}
