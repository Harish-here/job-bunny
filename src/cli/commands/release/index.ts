/**
 * cli/commands/release/index.ts (P9 pre-cutover; split from a single
 * release.ts on 2026-07-29) — the `release <X.Y.Z>` CLI command: a faithful
 * TS port of v0 `scripts/ops/release.js`, which owns the mechanical
 * git/GitHub spine of `/wrap ship`: preflight, version-sync, release
 * branch/PR, checks, tag the *merged* main HEAD (never the pre-squash local
 * commit — squash-merge rewrites the SHA).
 *
 * IDEMPOTENT / RESUMABLE: re-running after any failure re-derives the
 * current git/GitHub state and resumes from wherever it left off
 * (`resolveResumeStage`, `./resume.ts`) instead of erroring or duplicating
 * work — this resume-from-failure behavior is the main value of the tool
 * and must not be lost in any future change here.
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
 *
 * Split from a single 705-line release.ts: `./version.ts` (version/
 * CHANGELOG/README/npm-flag pure helpers), `./resume.ts` (the resume-stage
 * decision), `./steps.ts` (shell wrappers, idempotent mutating steps, the
 * checks poll) — this file re-exports the pure symbols so external callers
 * (`cli/main.ts`, this module's own orchestration test) keep a single
 * import surface, and holds `ReleaseDeps`/`defaultDeps`/`releaseCommand`
 * itself, the one part of the split that still needs every other piece.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { type PrState, resolveResumeStage, STAGE } from './resume.ts';
import {
  CHECK_TIMEOUT_MS,
  confirmMerge,
  ensureBranch,
  ensureCommit,
  ensurePrCreated,
  ensurePush,
  ensureVersionSync,
  getPr,
  mergePr,
  printResult,
  pushTagOnly,
  readAtRef,
  run,
  runOk,
  tagFromMergedMain,
  waitForChecks,
} from './steps.ts';
import {
  changelogHasVersionBlock,
  packageJsonVersion,
  parseVersion,
  updateReadmeBadge,
  VERSION_SYNC_FILES,
} from './version.ts';

export type { PrState, ResumeState, Stage } from './resume.ts';
export { resolveResumeStage, STAGE } from './resume.ts';
export type { ReadmeBadgeResult } from './version.ts';
export {
  changelogHasVersionBlock,
  npmSwallowedFlags,
  packageJsonVersion,
  parseVersion,
  updateReadmeBadge,
  VERSION_SYNC_FILES,
} from './version.ts';

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
