/**
 * cli/commands/release/version.ts (split from release.ts) — the pure
 * version/CHANGELOG/README-badge/npm-flag helpers `releaseCommand`
 * (`index.ts`) and `ensureVersionSync`/`ensureCommit` (`steps.ts`) build on.
 * No I/O here — every function takes plain strings/env and returns a plain
 * value or throws; the `ReleaseDeps`-mediated file reads/writes live in
 * `index.ts`/`steps.ts`, not here.
 */

// `git status --porcelain` uses fixed two-character status columns before
// each path (e.g. " M CHANGELOG.md") — a trimmed run() strips a leading
// space off the *first* line only, shifting that line's column parse by one
// character, so porcelain output is read via the untrimmed raw stdout
// (see steps.ts's `run`).
export const VERSION_SYNC_FILES = [
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'README.md',
];

export function parseVersion(versionArg: unknown): {
  version: string;
  major: number;
  minor: number;
  patch: number;
} {
  if (typeof versionArg !== 'string' || !versionArg) {
    throw new Error(
      `version required — expected X.Y.Z, got ${JSON.stringify(versionArg)}`,
    );
  }
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(versionArg);
  if (!m) {
    throw new Error(
      `invalid version "${versionArg}" — expected X.Y.Z (no "v" prefix, no prerelease suffix)`,
    );
  }
  const [, major, minor, patch] = m;
  return {
    version: versionArg,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

// CHANGELOG.md's own documented heading format: "## [X.Y.Z] — YYYY-MM-DD" (em dash, not hyphen).
export function changelogHasVersionBlock(text: string, version: string): boolean {
  const escaped = version.replace(/\./g, '\\.');
  const re = new RegExp(`^## \\[${escaped}\\] — \\d{4}-\\d{2}-\\d{2}$`, 'm');
  return re.test(text);
}

export function packageJsonVersion(text: string): string | null {
  try {
    const pkg = JSON.parse(text);
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export interface ReadmeBadgeResult {
  text: string;
  changed: boolean;
  /** false means the badge regex didn't match at all — callers must treat
   * that as a fail-loud preflight error, not a silent no-op: a silently
   * skipped badge is exactly the class of bug that left it stuck at an old
   * version through a whole release cycle. */
  found: boolean;
}

export function updateReadmeBadge(text: string, version: string): ReadmeBadgeResult {
  const re = /(img\.shields\.io\/badge\/version-)([^-]+)(-[^"]+)/;
  const m = re.exec(text);
  if (!m) return { text, changed: false, found: false };
  if (m[2] === version) return { text, changed: false, found: true };
  return { text: text.replace(re, `$1${version}$3`), changed: true, found: true };
}

/** Without a `--` separator, `npm run release <ver> --dry-run` has npm
 * consume the flags itself and forward only the version — the "plan-only"
 * invocation would perform the real release. npm does record each swallowed
 * flag in the script's environment (verified on npm 10.8.2:
 * `npm_config_dry_run`/`npm_config_yes` become `'true'`, `--no-merge` sets
 * `npm_config_merge` to `''`; all three stay unset when the flags are
 * forwarded via `--`), so the CLI can detect the drop and refuse to run. */
export function npmSwallowedFlags(env: Record<string, string | undefined>): string[] {
  if (env.npm_lifecycle_event !== 'release') return [];
  const swallowed: string[] = [];
  if (env.npm_config_dry_run === 'true') swallowed.push('--dry-run');
  if (env.npm_config_merge === '') swallowed.push('--no-merge');
  if (env.npm_config_yes === 'true') swallowed.push('--yes');
  return swallowed;
}
