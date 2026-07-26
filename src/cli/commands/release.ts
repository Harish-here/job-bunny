/**
 * commands/release.ts (P9 pre-cutover) — the `release <X.Y.Z>` CLI command:
 * a faithful TS port of v0 `scripts/ops/release.js`, which owns the
 * mechanical git/GitHub spine of `/wrap ship`: preflight, version-sync,
 * release branch/PR, checks, tag the *merged* main HEAD (never the
 * pre-squash local commit — squash-merge rewrites the SHA).
 *
 * IDEMPOTENT / RESUMABLE: re-running after any failure re-derives the
 * current git/GitHub state and resumes from wherever it left off
 * (`resolveResumeStage` below) instead of erroring or duplicating work —
 * this resume-from-failure behavior is the main value of the tool and
 * must not be lost in any future change here.
 *
 * Deliberately does NOT write release-note prose — CHANGELOG.md must
 * already have a dated `## [X.Y.Z] — YYYY-MM-DD` block before this runs;
 * that stays a `/wrap ship` judgment step. Deliberately does NOT
 * auto-merge unconditionally — once checks are green it pauses for an
 * explicit typed go-ahead (or `--yes` to skip the pause for a
 * pre-approved run).
 *
 * *** `confirmMerge`'s prompt needs LIVE stdin — never run this command
 * backgrounded or detached (same warning v0's CLAUDE.md carried for
 * release.js). ***
 *
 * No `src/adapters/**` import here — every side effect (shelling out to
 * git/gh/npm, reading/writing files, the confirmation prompt, the check
 * poll's sleep) goes through the injected `ReleaseDeps`, mirroring every
 * other `src/cli/commands/*.ts`'s `root: process.cwd()` +
 * dependency-injection convention (see `schedule.ts`, `lane_add_url.ts`).
 * Tests inject fakes for all of these and never shell out for real.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface ReleaseCommandOptions {
  /** Bare version, no "v" prefix (matches CHANGELOG.md / package.json). */
  version: string;
  /** Run preflight + resolve the resume stage, print the plan, mutate nothing. */
  dryRun?: boolean;
  /** Stop right after opening (or finding) the release PR — no checks, no merge. */
  noMerge?: boolean;
  /** Skip the merge confirmation prompt once checks are green. */
  yes?: boolean;
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  error?: unknown;
}

export interface ReleaseDeps {
  root: string;
  /** Single shell-out chokepoint — the real default runs `execFileSync`;
   * tests inject a fake keyed on `${cmd} ${args.join(' ')}`. */
  execCommand: (cmd: string, args: string[]) => ExecResult;
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  /** Resolves with the trimmed answer to an interactive y/N prompt. */
  confirm: (question: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  /** Injectable clock — real default is `Date.now()`; tests fast-forward it
   * without a real 10-minute wait to exercise `waitForChecks`'s timeout path. */
  now: () => number;
  write: (line: string) => void;
  warn: (line: string) => void;
}

function defaultDeps(): ReleaseDeps {
  return {
    root: process.cwd(),
    execCommand: (cmd, args) => {
      try {
        const stdout = execFileSync(cmd, args, { encoding: 'utf8', cwd: process.cwd() });
        return { ok: true, stdout };
      } catch (error) {
        // execFileSync throws on a non-zero exit but still carries the
        // child's stdout (a string, since `encoding` is set) — surface it
        // so callers can parse output from commands that exit non-zero by
        // design (`gh pr checks` exits 1 on failing checks, 8 while pending).
        const stdout = (error as { stdout?: unknown }).stdout;
        return { ok: false, stdout: typeof stdout === 'string' ? stdout : '', error };
      }
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, data) => writeFileSync(p, data),
    confirm: (question) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      }),
    // Plain setTimeout, deliberately not AbortSignal-bound: release is an
    // interactive foreground command (see confirmMerge's live-stdin warning
    // above) whose only cancellation is the user's SIGINT killing the whole
    // process — there is no run-level signal to honor here, and the check
    // poll's own deps.now() deadline bounds the total wait.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    write: (line: string) => console.log(`[release] ${line}`),
    warn: (line: string) => console.error(`[release] ${line}`),
  };
}

// `git status --porcelain` uses fixed two-character status columns before
// each path (e.g. " M CHANGELOG.md") — a trimmed run() strips a leading
// space off the *first* line only, shifting that line's column parse by one
// character, so porcelain output is read via the untrimmed raw stdout.
const VERSION_SYNC_FILES = [
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'README.md',
];

const CHECK_POLL_MS = 15_000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- pure functions (unit tested directly) ----------

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

export const STAGE = {
  DONE: 'DONE',
  PUSH_TAG_ONLY: 'PUSH_TAG_ONLY',
  AWAITING_TAG: 'AWAITING_TAG',
  AWAITING_MERGE: 'AWAITING_MERGE',
  AWAITING_PR: 'AWAITING_PR',
  AWAITING_COMMIT: 'AWAITING_COMMIT',
  FRESH: 'FRESH',
} as const;

export type Stage = (typeof STAGE)[keyof typeof STAGE];
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED' | null;

export interface ResumeState {
  tagExistsLocal: boolean;
  tagExistsRemote: boolean;
  branchExistsLocal: boolean;
  branchExistsRemote: boolean;
  pkgVersionMatches: boolean;
  readmeBadgeMatches: boolean;
  hasUncommittedVersionSyncDiff: boolean;
  prState: PrState;
}

// Decides which stage of the pipeline to resume from, given already-gathered
// read-only state. Throws on an anomalous state a re-run shouldn't silently
// guess through (a closed-without-merged PR means something was resolved
// out-of-band and needs a human look).
export function resolveResumeStage(state: ResumeState): Stage {
  const {
    tagExistsLocal,
    tagExistsRemote,
    branchExistsLocal,
    branchExistsRemote,
    pkgVersionMatches,
    readmeBadgeMatches,
    hasUncommittedVersionSyncDiff,
    prState,
  } = state;

  if (tagExistsLocal && tagExistsRemote) return STAGE.DONE;
  if (tagExistsLocal && !tagExistsRemote) return STAGE.PUSH_TAG_ONLY;
  if (prState === 'MERGED') return STAGE.AWAITING_TAG;
  if (prState === 'OPEN') return STAGE.AWAITING_MERGE;
  if (prState === 'CLOSED') {
    throw new Error(
      'release PR was closed without merging — resolve manually before re-running',
    );
  }
  if (branchExistsLocal || branchExistsRemote) {
    if (!pkgVersionMatches || !readmeBadgeMatches || hasUncommittedVersionSyncDiff) {
      return STAGE.AWAITING_COMMIT;
    }
    return STAGE.AWAITING_PR;
  }
  return STAGE.FRESH;
}

// ---------- shell helpers (thin wrappers over the single execCommand dep) ----------

/** Throwing wrapper over the single execCommand dep. `trim: false` exists
 * for `git status --porcelain` output — see the VERSION_SYNC_FILES header
 * note on why porcelain must never be trimmed. */
function run(
  deps: ReleaseDeps,
  cmd: string,
  args: string[],
  opts: { trim?: boolean } = {},
): string {
  const r = deps.execCommand(cmd, args);
  if (!r.ok) {
    throw r.error instanceof Error
      ? r.error
      : new Error(`${cmd} ${args.join(' ')} failed`);
  }
  return opts.trim === false ? r.stdout : r.stdout.trim();
}

function runOk(
  deps: ReleaseDeps,
  cmd: string,
  args: string[],
): { ok: boolean; out: string } {
  const r = deps.execCommand(cmd, args);
  return { ok: r.ok, out: r.ok ? r.stdout.trim() : '' };
}

function readAtRef(deps: ReleaseDeps, ref: string, relPath: string): string | null {
  const out = runOk(deps, 'git', ['show', `${ref}:${relPath}`]);
  return out.ok ? out.out : null;
}

interface PrInfo {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  url: string;
}

function getPr(deps: ReleaseDeps, branch: string): PrInfo | null {
  const out = runOk(deps, 'gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,state,url',
  ]);
  if (!out.ok) return null;
  const arr = JSON.parse(out.out || '[]') as PrInfo[];
  // `--state all` can return a stale CLOSED PR from a previously reused
  // branch alongside the live one — prefer OPEN, then MERGED, and surface
  // a CLOSED PR only when it is all there is (resolveResumeStage treats
  // that as the resolve-manually anomaly it really is).
  return (
    arr.find((pr) => pr.state === 'OPEN') ??
    arr.find((pr) => pr.state === 'MERGED') ??
    arr[0] ??
    null
  );
}

function printResult(deps: ReleaseDeps, result: Record<string, unknown>): void {
  deps.write(`RESULT ${JSON.stringify(result)}`);
}

// ---------- mutating steps (each idempotent — no-ops if already satisfied) ----------

function ensureBranch(
  deps: ReleaseDeps,
  branch: string,
  currentBranch: string,
  branchExistsLocal: boolean,
  branchExistsRemote: boolean,
): void {
  if (currentBranch === branch) return;
  if (branchExistsLocal) {
    run(deps, 'git', ['checkout', branch]);
  } else if (branchExistsRemote) {
    run(deps, 'git', ['checkout', '-b', branch, `origin/${branch}`]);
  } else {
    run(deps, 'git', ['checkout', '-b', branch]);
  }
  deps.write(`on branch ${branch}`);
}

function ensureVersionSync(deps: ReleaseDeps, version: string): void {
  const packageJsonPath = path.join(deps.root, 'package.json');
  const readmePath = path.join(deps.root, 'README.md');

  const pkgText = deps.readFile(packageJsonPath);
  if (packageJsonVersion(pkgText) === version) {
    deps.write(`package.json already at ${version} — skip`);
  } else {
    run(deps, 'npm', ['version', version, '--no-git-tag-version']);
    deps.write(`package.json/package-lock.json synced to ${version}`);
  }

  const readmeText = deps.readFile(readmePath);
  const badge = updateReadmeBadge(readmeText, version);
  if (!badge.found) {
    throw new Error('README.md version badge not found — cannot verify/update it');
  }
  if (!badge.changed) {
    deps.write(`README badge already ${version} — skip`);
  } else {
    deps.writeFile(readmePath, badge.text);
    deps.write(`README badge updated to ${version}`);
  }
}

function ensureCommit(deps: ReleaseDeps, version: string): void {
  run(deps, 'git', ['add', ...VERSION_SYNC_FILES]);
  const staged = run(deps, 'git', ['diff', '--cached', '--name-only']);
  if (!staged) {
    deps.write('no version-sync changes to commit — skip');
    return;
  }
  run(deps, 'git', ['commit', '-m', `chore: CHANGELOG + version sync for v${version}`]);
  deps.write('committed version-sync chore');
}

function ensurePush(deps: ReleaseDeps, branch: string): void {
  run(deps, 'git', ['push', '-u', 'origin', branch]);
  deps.write(`pushed ${branch}`);
}

function ensurePrCreated(deps: ReleaseDeps, branch: string, version: string): PrInfo {
  const existing = getPr(deps, branch);
  if (existing) {
    if (existing.state === 'CLOSED') {
      throw new Error(
        `release PR for ${branch} was closed without merging — resolve manually`,
      );
    }
    deps.write(`PR #${existing.number} already open (${existing.url})`);
    return existing;
  }
  const body = `Mechanical version-sync release PR for v${version}. See CHANGELOG.md for release notes.`;
  run(deps, 'gh', ['pr', 'create', '--title', `release: v${version}`, '--body', body]);
  const created = getPr(deps, branch);
  if (!created)
    throw new Error('gh pr create reported success but no PR was found for this branch');
  deps.write(`opened PR #${created.number} (${created.url})`);
  return created;
}

interface ChecksResult {
  ok: boolean;
  failed?: Array<{ name: string; state: string }>;
  timedOut?: boolean;
}

/** A check in one of these states can never block the merge. */
const PASSING_CHECK_STATES = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const FAILED_CHECK_STATES = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

async function waitForChecks(deps: ReleaseDeps, prNumber: number): Promise<ChecksResult> {
  const deadline = deps.now() + CHECK_TIMEOUT_MS;
  while (deps.now() < deadline) {
    // `gh pr checks` exits non-zero while checks are pending (8) or failing
    // (1) but still prints the JSON — so the exit code is ignored and the
    // stdout parsed regardless; an unparseable/empty response (gh itself
    // broke) is treated as "still pending" and polled again.
    const r = deps.execCommand('gh', [
      'pr',
      'checks',
      String(prNumber),
      '--json',
      'name,state',
    ]);
    let checks: Array<{ name: string; state: string }> = [];
    try {
      checks = JSON.parse(r.stdout.trim() || '[]');
    } catch {
      checks = [];
    }
    const failed = checks.filter((c) => FAILED_CHECK_STATES.has(c.state));
    if (failed.length) return { ok: false, failed };
    if (checks.length && checks.every((c) => PASSING_CHECK_STATES.has(c.state)))
      return { ok: true };
    await deps.sleep(CHECK_POLL_MS);
  }
  return { ok: false, timedOut: true };
}

async function confirmMerge(
  deps: ReleaseDeps,
  prNumber: number,
  skipPrompt: boolean,
): Promise<boolean> {
  if (skipPrompt) return true;
  const answer = await deps.confirm(
    `PR #${prNumber} checks green. Proceed to merge? [y/N] `,
  );
  return /^y(es)?$/i.test(answer);
}

function mergePr(deps: ReleaseDeps, prNumber: number): void {
  run(deps, 'gh', ['pr', 'merge', String(prNumber), '--squash', '--delete-branch']);
  deps.write(`merged PR #${prNumber}`);
}

// Tags only after confirming the target commit is actually reachable from
// origin/main post-merge — the direct fix for the "tagged the pre-squash
// local commit, tagged an orphan" hazard.
function tagFromMergedMain(deps: ReleaseDeps, prNumber: number, version: string): string {
  run(deps, 'git', ['checkout', 'main']);
  run(deps, 'git', ['pull']);
  const mainHead = run(deps, 'git', ['rev-parse', 'HEAD']);
  const prView = JSON.parse(
    run(deps, 'gh', ['pr', 'view', String(prNumber), '--json', 'mergeCommit']),
  ) as { mergeCommit?: { oid?: string } };
  const mergeSha = prView.mergeCommit?.oid;
  if (!mergeSha || mergeSha !== mainHead) {
    throw new Error(
      `merged commit (${mergeSha || 'unknown'}) does not match main HEAD (${mainHead}) after pull — ` +
        'refusing to tag a possibly-orphan commit; pull manually and re-run',
    );
  }
  const tag = `v${version}`;
  run(deps, 'git', ['tag', tag]);
  run(deps, 'git', ['push', 'origin', tag]);
  deps.write(`tagged and pushed ${tag}`);
  return tag;
}

function pushTagOnly(deps: ReleaseDeps, tag: string): void {
  run(deps, 'git', ['push', 'origin', tag]);
  deps.write(`pushed existing local tag ${tag}`);
}

// ---------- orchestration ----------

export async function releaseCommand(
  opts: ReleaseCommandOptions,
  overrides: Partial<ReleaseDeps> = {},
): Promise<number> {
  const deps: ReleaseDeps = { ...defaultDeps(), ...overrides };
  const changelogPath = path.join(deps.root, 'CHANGELOG.md');

  const DRY_RUN = opts.dryRun ?? false;
  const NO_MERGE = opts.noMerge ?? false;
  const YES = opts.yes ?? false;

  try {
    const { version } = parseVersion(opts.version);
    const tag = `v${version}`;
    const branch = `release/${tag}`;

    // ---- preflight (read-only, hard stop on first failure) ----
    const auth = runOk(deps, 'gh', ['auth', 'status']);
    if (!auth.ok) throw new Error('gh CLI not authenticated — run `gh auth login`');

    const currentBranch = run(deps, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (currentBranch !== 'main' && currentBranch !== branch) {
      throw new Error(`on branch "${currentBranch}" — expected "main" or "${branch}"`);
    }
    if (currentBranch === 'main') {
      const dirty = run(deps, 'git', ['status', '--porcelain'], { trim: false });
      const strayDirty = dirty
        .split('\n')
        .filter(Boolean)
        .filter((line) => !VERSION_SYNC_FILES.includes(line.slice(3).trim()));
      if (strayDirty.length) {
        throw new Error(
          `working tree has unrelated uncommitted changes — commit or stash first:\n${strayDirty.join('\n')}`,
        );
      }
      run(deps, 'git', ['fetch', 'origin', 'main', '--quiet']);
      const local = run(deps, 'git', ['rev-parse', 'HEAD']);
      const remote = run(deps, 'git', ['rev-parse', 'origin/main']);
      if (local !== remote)
        throw new Error('main is not up to date with origin/main — git pull first');
    }

    const changelogText = deps.readFile(changelogPath);
    if (!changelogHasVersionBlock(changelogText, version)) {
      throw new Error(
        `CHANGELOG.md has no dated block for ${version} — write the release notes first (this command does not write prose)`,
      );
    }

    // ---- state gathering (read-only) ----
    const tagExistsLocal = run(deps, 'git', ['tag', '-l', tag]) === tag;
    const tagExistsRemote = run(deps, 'git', [
      'ls-remote',
      '--tags',
      'origin',
      tag,
    ]).includes(tag);
    const branchExistsLocal = runOk(deps, 'git', [
      'rev-parse',
      '--verify',
      '--quiet',
      branch,
    ]).ok;
    const branchExistsRemote = run(deps, 'git', [
      'ls-remote',
      '--heads',
      'origin',
      branch,
    ]).includes(branch);
    if (branchExistsRemote && !branchExistsLocal) {
      // ls-remote proved the branch exists on the remote, but nothing so
      // far has fetched it — the resume paths below read `origin/<branch>`
      // refs (readAtRef, ensureBranch), which fail with "invalid reference"
      // in a fresh clone or a pruned repo unless the ref is actually local.
      run(deps, 'git', ['fetch', 'origin', branch, '--quiet']);
    }
    const pr = getPr(deps, branch);

    let pkgVersionMatches = false;
    let readmeBadgeMatches = false;
    let hasUncommittedVersionSyncDiff = false;
    if (branchExistsLocal || branchExistsRemote) {
      const ref = branchExistsLocal ? branch : `origin/${branch}`;
      const pkgAtRef = readAtRef(deps, ref, 'package.json');
      const readmeAtRef = readAtRef(deps, ref, 'README.md');
      pkgVersionMatches = pkgAtRef !== null && packageJsonVersion(pkgAtRef) === version;
      // `.found` must be checked alongside `.changed` — a README with no
      // badge at all is "needs the version-sync step" (AWAITING_COMMIT,
      // where ensureVersionSync fail-louds on it), never "already matches".
      if (readmeAtRef !== null) {
        const badgeAtRef = updateReadmeBadge(readmeAtRef, version);
        readmeBadgeMatches = badgeAtRef.found && !badgeAtRef.changed;
      }
      if (currentBranch === branch) {
        const dirty = run(deps, 'git', [
          'status',
          '--porcelain',
          '--',
          ...VERSION_SYNC_FILES,
        ]);
        hasUncommittedVersionSyncDiff = dirty !== '';
      }
    }

    const stage = resolveResumeStage({
      tagExistsLocal,
      tagExistsRemote,
      branchExistsLocal,
      branchExistsRemote,
      pkgVersionMatches,
      readmeBadgeMatches,
      hasUncommittedVersionSyncDiff,
      prState: (pr?.state ?? null) as PrState,
    });
    deps.write(`resolved resume stage: ${stage}`);

    if (DRY_RUN) {
      deps.write(`dry run — would proceed from stage ${stage}, nothing mutated`);
      return 0;
    }

    if (stage === STAGE.DONE) {
      deps.write(`${tag} already tagged and pushed — nothing to do`);
      printResult(deps, { status: 'success', version, tag, note: 'already released' });
      return 0;
    }

    if (stage === STAGE.PUSH_TAG_ONLY) {
      pushTagOnly(deps, tag);
      printResult(deps, { status: 'success', version, tag });
      return 0;
    }

    let prNumber = pr?.number;
    let prUrl = pr?.url;

    if (stage === STAGE.AWAITING_TAG) {
      const finalTag = tagFromMergedMain(deps, prNumber as number, version);
      printResult(deps, { status: 'success', version, tag: finalTag, prNumber, prUrl });
      return 0;
    }

    if (stage !== STAGE.AWAITING_MERGE) {
      // FRESH / AWAITING_COMMIT / AWAITING_PR all resume the same idempotent
      // pre-PR pipeline — each step below no-ops on its own if already
      // satisfied, so the distinction between these three stages only
      // affects the log message, not the code path.
      ensureBranch(deps, branch, currentBranch, branchExistsLocal, branchExistsRemote);
      ensureVersionSync(deps, version);
      ensureCommit(deps, version);
      ensurePush(deps, branch);
      const created = ensurePrCreated(deps, branch, version);
      prNumber = created.number;
      prUrl = created.url;
    }

    // Checked here — after the PR exists on every path, including an
    // AWAITING_MERGE resume — so `--no-merge` on a re-run can never fall
    // through to the checks/merge/tag pipeline.
    if (NO_MERGE) {
      deps.write(`--no-merge: stopping after PR #${prNumber} (${prUrl})`);
      printResult(deps, {
        status: 'stopped',
        version,
        prNumber,
        prUrl,
        stage: 'no-merge',
      });
      return 0;
    }

    deps.write(`waiting for checks on PR #${prNumber}...`);
    const checkResult = await waitForChecks(deps, prNumber as number);
    if (!checkResult.ok) {
      if (checkResult.timedOut) {
        throw new Error(
          `checks still pending after ${CHECK_TIMEOUT_MS / 60_000}m — re-run to keep waiting (PR #${prNumber})`,
        );
      }
      throw new Error(
        `check(s) failed on PR #${prNumber}: ${(checkResult.failed ?? []).map((c) => c.name).join(', ')} — fix on ${branch} and re-push`,
      );
    }
    deps.write(`checks green on PR #${prNumber}`);

    const go = await confirmMerge(deps, prNumber as number, YES);
    if (!go) {
      throw new Error(
        `merge not confirmed — PR #${prNumber} left open; re-run with --yes once ready`,
      );
    }

    mergePr(deps, prNumber as number);
    const finalTag = tagFromMergedMain(deps, prNumber as number, version);
    printResult(deps, { status: 'success', version, tag: finalTag, prNumber, prUrl });
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.warn(`FAILED: ${message}`);
    printResult(deps, { status: 'failed', reason: message });
    return 1;
  }
}
