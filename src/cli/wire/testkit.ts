/**
 * cli/wire/testkit.ts (P8, split from wire.test.ts) — shared fixtures for
 * `config.test.ts` and `compose.test.ts`: a POSIX-literal fake repo root,
 * a fake `readFile` keyed by exact path, an in-memory `fakeConfigStore`
 * (config→db Phase 4 — the `readFile`-fixture replacement every `wire()`/
 * `loadPipelineConfig`/`loadFilterConfig` caller now feeds instead), and
 * the profile/filter/data path helpers that key them. Test-only — not part
 * of the module's public surface (`index.ts`).
 *
 * The rest of this file is free to pass `root: '/repo'` (a POSIX-literal
 * input string, never resolved by the OS) into `wire()`/loadPipelineConfig
 * etc — but production code composes lookups via `path.join`, so any fixture
 * KEY or path EXPECTATION derived from that root must go through `join` too,
 * or it silently misses on windows-latest (backslash-joined paths).
 */
import { join } from 'node:path';
import type { ConfigDocKey, ConfigStore } from '../../ports/config_store.ts';

export const REPO_ROOT = '/repo';

export function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(
    `ENOENT: no such file or directory, open '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

export function fakeReadFile(
  files: Record<string, string>,
): (path: string) => Promise<string> {
  return async (path: string) => {
    if (Object.hasOwn(files, path)) return files[path] as string;
    throw enoent(path);
  };
}

/** In-memory `ConfigStore` fake, pre-seeded with `docs`. No legacy-file
 * lift, no db file, no `close()`-side-effect — purely a `Map` — this is
 * the shared conversion target for every test that used to feed `wire()`/
 * `loadPipelineConfig`/`loadFilterConfig` a `readFile` fixture keyed by
 * `profile.json`/`filter.json`/`search_urls.md` content. */
export function fakeConfigStore(
  docs: Partial<Record<ConfigDocKey, string>>,
): ConfigStore {
  const map = new Map(Object.entries(docs));
  return {
    readText: async (key) => map.get(key),
    writeText: async (key, text) => {
      map.set(key, text);
    },
    close() {},
  };
}

export function profilePath(name: string, root: string = REPO_ROOT): string {
  return join(root, 'profiles', name, 'profile.json');
}

export function filterPath(name: string, root: string = REPO_ROOT): string {
  return join(root, 'profiles', name, 'filter.json');
}

export function dataPath(name: string, root: string = REPO_ROOT): string {
  return join(root, 'profiles', name, 'data');
}
