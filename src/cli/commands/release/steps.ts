/**
 * cli/commands/release/steps.ts (split from release.ts) — the shell
 * wrappers, idempotent mutating steps, and the checks poll `index.ts`'s
 * `releaseCommand` orchestrates. Every function here takes the single
 * `ReleaseDeps` dependency bag (see `index.ts`) — no direct `execFileSync`/
 * `fs` calls, so the orchestration test can fake all of git/gh/npm through
 * one `execCommand` dispatcher.
 */
import path from 'node:path';
import type { ReleaseDeps } from './index.ts';
import { packageJsonVersion, updateReadmeBadge, VERSION_SYNC_FILES } from './version.ts';

const CHECK_POLL_MS = 15_000;
export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- shell helpers (thin wrappers over the single execCommand dep) ----------

/** Throwing wrapper over the single execCommand dep. `trim: false` exists
 * for `git status --porcelain` output — see `version.ts`'s
 * `VERSION_SYNC_FILES` header note on why porcelain must never be trimmed. */
export function run(
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

export function runOk(
  deps: ReleaseDeps,
  cmd: string,
  args: string[],
): { ok: boolean; out: string } {
  const r = deps.execCommand(cmd, args);
  return { ok: r.ok, out: r.ok ? r.stdout.trim() : '' };
}

export function readAtRef(
  deps: ReleaseDeps,
  ref: string,
  relPath: string,
): string | null {
  const out = runOk(deps, 'git', ['show', `${ref}:${relPath}`]);
  return out.ok ? out.out : null;
}

export interface PrInfo {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  url: string;
}

export function getPr(deps: ReleaseDeps, branch: string): PrInfo | null {
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

export function printResult(deps: ReleaseDeps, result: Record<string, unknown>): void {
  deps.write(`RESULT ${JSON.stringify(result)}`);
}

// ---------- mutating steps (each idempotent — no-ops if already satisfied) ----------

export function ensureBranch(
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

export function ensureVersionSync(deps: ReleaseDeps, version: string): void {
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

export function ensureCommit(deps: ReleaseDeps, version: string): void {
  run(deps, 'git', ['add', ...VERSION_SYNC_FILES]);
  const staged = run(deps, 'git', ['diff', '--cached', '--name-only']);
  if (!staged) {
    deps.write('no version-sync changes to commit — skip');
    return;
  }
  run(deps, 'git', ['commit', '-m', `chore: CHANGELOG + version sync for v${version}`]);
  deps.write('committed version-sync chore');
}

export function ensurePush(deps: ReleaseDeps, branch: string): void {
  run(deps, 'git', ['push', '-u', 'origin', branch]);
  deps.write(`pushed ${branch}`);
}

export function ensurePrCreated(
  deps: ReleaseDeps,
  branch: string,
  version: string,
): PrInfo {
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

export interface ChecksResult {
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

export async function waitForChecks(
  deps: ReleaseDeps,
  prNumber: number,
): Promise<ChecksResult> {
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

export async function confirmMerge(
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

export function mergePr(deps: ReleaseDeps, prNumber: number): void {
  run(deps, 'gh', ['pr', 'merge', String(prNumber), '--squash', '--delete-branch']);
  deps.write(`merged PR #${prNumber}`);
}

// Tags only after confirming the target commit is actually reachable from
// origin/main post-merge — the direct fix for the "tagged the pre-squash
// local commit, tagged an orphan" hazard.
export function tagFromMergedMain(
  deps: ReleaseDeps,
  prNumber: number,
  version: string,
): string {
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

export function pushTagOnly(deps: ReleaseDeps, tag: string): void {
  run(deps, 'git', ['push', 'origin', tag]);
  deps.write(`pushed existing local tag ${tag}`);
}
