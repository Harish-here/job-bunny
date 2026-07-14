// scripts/ops/release.js — owns the mechanical git/GitHub spine of `/wrap ship`: preflight,
// version-sync, release branch/PR, checks, tag the *merged* main HEAD (never the pre-squash
// local commit — squash-merge rewrites the SHA). Idempotent: re-running after any failure
// re-derives fresh state and resumes from wherever it left off instead of erroring or
// duplicating work.
//
// Deliberately does NOT write release-note prose — CHANGELOG.md must already have a dated
// `## [X.Y.Z] — YYYY-MM-DD` block before this runs; that stays a `/wrap ship` judgment step.
// Deliberately does NOT auto-merge unconditionally — once checks are green it pauses for an
// explicit typed go-ahead (or --yes to skip the pause for a pre-approved run).
//
// Usage: node scripts/ops/release.js <X.Y.Z> [--dry-run] [--no-merge] [--yes]
//   <X.Y.Z>     bare version, no "v" prefix (matches CHANGELOG.md / package.json).
//   --dry-run   run preflight + resolve the resume stage, print the plan, mutate nothing.
//   --no-merge  stop right after opening (or finding) the release PR — no checks, no merge.
//   --yes       skip the merge confirmation prompt once checks are green.
// Flags must come after the version argument.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { isMain, parseFlags } from "../lib/cli.js";
import { prompt } from "../lib/prompt.js";
import { ROOT } from "../lib/config.js";

const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");
const PACKAGE_JSON_PATH = join(ROOT, "package.json");
const README_PATH = join(ROOT, "README.md");

// /wrap ship writes the CHANGELOG.md release-note block on `main` before invoking this
// script and deliberately leaves it uncommitted for ensureCommit() to pick up — so the
// clean-tree preflight must tolerate exactly these files being dirty, not the whole tree.
const VERSION_SYNC_FILES = ["CHANGELOG.md", "package.json", "package-lock.json", "README.md"];

const CHECK_POLL_MS = 15_000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- pure functions (unit tested in release.test.js) ----------

export function parseVersion(versionArg) {
  if (typeof versionArg !== "string" || !versionArg) {
    throw new Error(`version required — expected X.Y.Z, got ${JSON.stringify(versionArg)}`);
  }
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(versionArg);
  if (!m) {
    throw new Error(`invalid version "${versionArg}" — expected X.Y.Z (no "v" prefix, no prerelease suffix)`);
  }
  const [, major, minor, patch] = m;
  return { version: versionArg, major: Number(major), minor: Number(minor), patch: Number(patch) };
}

// CHANGELOG.md's own documented heading format: "## [X.Y.Z] — YYYY-MM-DD" (em dash, not hyphen).
export function changelogHasVersionBlock(text, version) {
  const escaped = version.replace(/\./g, "\\.");
  const re = new RegExp(`^## \\[${escaped}\\] — \\d{4}-\\d{2}-\\d{2}$`, "m");
  return re.test(text);
}

export function packageJsonVersion(text) {
  try {
    const pkg = JSON.parse(text);
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// Returns { text, changed, found }. found:false means the badge regex didn't match at all —
// callers must treat that as a fail-loud preflight error, not a silent no-op: a silently
// skipped badge is exactly the class of bug that left it stuck at 0.12.0 through v1.0.0.
export function updateReadmeBadge(text, version) {
  const re = /(img\.shields\.io\/badge\/version-)([^-]+)(-[^"]+)/;
  const m = re.exec(text);
  if (!m) return { text, changed: false, found: false };
  if (m[2] === version) return { text, changed: false, found: true };
  return { text: text.replace(re, `$1${version}$3`), changed: true, found: true };
}

export const STAGE = {
  DONE: "DONE",
  PUSH_TAG_ONLY: "PUSH_TAG_ONLY",
  AWAITING_TAG: "AWAITING_TAG",
  AWAITING_MERGE: "AWAITING_MERGE",
  AWAITING_PR: "AWAITING_PR",
  AWAITING_COMMIT: "AWAITING_COMMIT",
  FRESH: "FRESH",
};

// Decides which stage of the pipeline to resume from, given already-gathered read-only state.
// Throws on an anomalous state a re-run shouldn't silently guess through (a closed-without-
// merged PR means something was resolved out-of-band and needs a human look).
export function resolveResumeStage(state) {
  const {
    tagExistsLocal,
    tagExistsRemote,
    branchExistsLocal,
    branchExistsRemote,
    pkgVersionMatches,
    readmeBadgeMatches,
    hasUncommittedVersionSyncDiff,
    prState, // null | "OPEN" | "MERGED" | "CLOSED"
  } = state;

  if (tagExistsLocal && tagExistsRemote) return STAGE.DONE;
  if (tagExistsLocal && !tagExistsRemote) return STAGE.PUSH_TAG_ONLY;
  if (prState === "MERGED") return STAGE.AWAITING_TAG;
  if (prState === "OPEN") return STAGE.AWAITING_MERGE;
  if (prState === "CLOSED") {
    throw new Error("release PR was closed without merging — resolve manually before re-running");
  }
  if (branchExistsLocal || branchExistsRemote) {
    if (!pkgVersionMatches || !readmeBadgeMatches || hasUncommittedVersionSyncDiff) {
      return STAGE.AWAITING_COMMIT;
    }
    return STAGE.AWAITING_PR;
  }
  return STAGE.FRESH;
}

// ---------- shell helpers ----------

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT }).trim();
}

// `git status --porcelain` uses fixed two-character status columns before each path (e.g.
// " M CHANGELOG.md") — run()'s .trim() strips a leading space off the *first* line only,
// shifting that line's column parse by one character. Porcelain output must stay untrimmed.
function runPorcelain(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT });
}

function runOk(cmd, args) {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (err) {
    return { ok: false, out: "", err };
  }
}

function readAtRef(ref, relPath) {
  const out = runOk("git", ["show", `${ref}:${relPath}`]);
  return out.ok ? out.out : null;
}

function getPr(branch) {
  const out = runOk("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,url"]);
  if (!out.ok) return null;
  const arr = JSON.parse(out.out || "[]");
  return arr[0] ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[release] ${m}`);

function printResult(result) {
  console.log(`[release] RESULT ${JSON.stringify(result)}`);
}

// ---------- mutating steps (each idempotent — no-ops if already satisfied) ----------

function ensureBranch(branch, currentBranch, branchExistsLocal, branchExistsRemote) {
  if (currentBranch === branch) return;
  if (branchExistsLocal) {
    run("git", ["checkout", branch]);
  } else if (branchExistsRemote) {
    run("git", ["checkout", "-b", branch, `origin/${branch}`]);
  } else {
    run("git", ["checkout", "-b", branch]);
  }
  log(`on branch ${branch}`);
}

function ensureVersionSync(version) {
  const pkgText = readFileSync(PACKAGE_JSON_PATH, "utf8");
  if (packageJsonVersion(pkgText) === version) {
    log(`package.json already at ${version} — skip`);
  } else {
    run("npm", ["version", version, "--no-git-tag-version"]);
    log(`package.json/package-lock.json synced to ${version}`);
  }

  const readmeText = readFileSync(README_PATH, "utf8");
  const badge = updateReadmeBadge(readmeText, version);
  if (!badge.found) {
    throw new Error("README.md version badge not found — cannot verify/update it");
  }
  if (!badge.changed) {
    log(`README badge already ${version} — skip`);
  } else {
    writeFileSync(README_PATH, badge.text);
    log(`README badge updated to ${version}`);
  }
}

function ensureCommit(version) {
  run("git", ["add", ...VERSION_SYNC_FILES]);
  const staged = run("git", ["diff", "--cached", "--name-only"]);
  if (!staged) {
    log("no version-sync changes to commit — skip");
    return;
  }
  run("git", ["commit", "-m", `chore: CHANGELOG + version sync for v${version}`]);
  log("committed version-sync chore");
}

function ensurePush(branch) {
  run("git", ["push", "-u", "origin", branch]);
  log(`pushed ${branch}`);
}

function ensurePrCreated(branch, version) {
  const existing = getPr(branch);
  if (existing) {
    if (existing.state === "CLOSED") {
      throw new Error(`release PR for ${branch} was closed without merging — resolve manually`);
    }
    log(`PR #${existing.number} already open (${existing.url})`);
    return existing;
  }
  const body = `Mechanical version-sync release PR for v${version}. See CHANGELOG.md for release notes.`;
  run("gh", ["pr", "create", "--title", `release: v${version}`, "--body", body]);
  const created = getPr(branch);
  if (!created) throw new Error("gh pr create reported success but no PR was found for this branch");
  log(`opened PR #${created.number} (${created.url})`);
  return created;
}

async function waitForChecks(prNumber) {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const out = runOk("gh", ["pr", "checks", String(prNumber), "--json", "name,state"]);
    if (out.ok) {
      const checks = JSON.parse(out.out || "[]");
      const failed = checks.filter((c) => c.state === "FAILURE" || c.state === "ERROR");
      if (failed.length) return { ok: false, failed };
      if (checks.length && checks.every((c) => c.state === "SUCCESS")) return { ok: true };
    }
    await sleep(CHECK_POLL_MS);
  }
  return { ok: false, timedOut: true };
}

async function confirmMerge(prNumber, skipPrompt) {
  if (skipPrompt) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await prompt(rl, `PR #${prNumber} checks green. Proceed to merge? [y/N] `);
  } finally {
    rl.close();
  }
  return /^y(es)?$/i.test(answer);
}

function mergePr(prNumber) {
  run("gh", ["pr", "merge", String(prNumber), "--squash", "--delete-branch"]);
  log(`merged PR #${prNumber}`);
}

// Tags only after confirming the target commit is actually reachable from origin/main post-
// merge — the direct fix for the "tagged the pre-squash local commit, tagged an orphan" hazard.
function tagFromMergedMain(prNumber, version) {
  run("git", ["checkout", "main"]);
  run("git", ["pull"]);
  const mainHead = run("git", ["rev-parse", "HEAD"]);
  const prView = JSON.parse(run("gh", ["pr", "view", String(prNumber), "--json", "mergeCommit"]));
  const mergeSha = prView.mergeCommit?.oid;
  if (!mergeSha || mergeSha !== mainHead) {
    throw new Error(
      `merged commit (${mergeSha || "unknown"}) does not match main HEAD (${mainHead}) after pull — ` +
        "refusing to tag a possibly-orphan commit; pull manually and re-run"
    );
  }
  const tag = `v${version}`;
  run("git", ["tag", tag]);
  run("git", ["push", "origin", tag]);
  log(`tagged and pushed ${tag}`);
  return tag;
}

function pushTagOnly(tag) {
  run("git", ["push", "origin", tag]);
  log(`pushed existing local tag ${tag}`);
}

// ---------- orchestration ----------

async function main() {
  const { positional } = parseFlags();
  const DRY_RUN = process.argv.includes("--dry-run");
  const NO_MERGE = process.argv.includes("--no-merge");
  const YES = process.argv.includes("--yes");

  const { version } = parseVersion(positional[0]);
  const tag = `v${version}`;
  const branch = `release/${tag}`;

  // ---- preflight (read-only, hard stop on first failure) ----
  const auth = runOk("gh", ["auth", "status"]);
  if (!auth.ok) throw new Error("gh CLI not authenticated — run `gh auth login`");

  const currentBranch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch !== "main" && currentBranch !== branch) {
    throw new Error(`on branch "${currentBranch}" — expected "main" or "${branch}"`);
  }
  if (currentBranch === "main") {
    const dirty = runPorcelain("git", ["status", "--porcelain"]);
    const strayDirty = dirty
      .split("\n")
      .filter(Boolean)
      .filter((line) => !VERSION_SYNC_FILES.includes(line.slice(3).trim()));
    if (strayDirty.length) {
      throw new Error(`working tree has unrelated uncommitted changes — commit or stash first:\n${strayDirty.join("\n")}`);
    }
    run("git", ["fetch", "origin", "main", "--quiet"]);
    const local = run("git", ["rev-parse", "HEAD"]);
    const remote = run("git", ["rev-parse", "origin/main"]);
    if (local !== remote) throw new Error("main is not up to date with origin/main — git pull first");
  }

  const changelogText = readFileSync(CHANGELOG_PATH, "utf8");
  if (!changelogHasVersionBlock(changelogText, version)) {
    throw new Error(
      `CHANGELOG.md has no dated block for ${version} — write the release notes first (this script does not write prose)`
    );
  }

  // ---- state gathering (read-only) ----
  const tagExistsLocal = run("git", ["tag", "-l", tag]) === tag;
  const tagExistsRemote = run("git", ["ls-remote", "--tags", "origin", tag]).includes(tag);
  const branchExistsLocal = runOk("git", ["rev-parse", "--verify", "--quiet", branch]).ok;
  const branchExistsRemote = run("git", ["ls-remote", "--heads", "origin", branch]).includes(branch);
  const pr = getPr(branch);

  let pkgVersionMatches = false;
  let readmeBadgeMatches = false;
  let hasUncommittedVersionSyncDiff = false;
  if (branchExistsLocal || branchExistsRemote) {
    const ref = branchExistsLocal ? branch : `origin/${branch}`;
    const pkgAtRef = readAtRef(ref, "package.json");
    const readmeAtRef = readAtRef(ref, "README.md");
    pkgVersionMatches = pkgAtRef !== null && packageJsonVersion(pkgAtRef) === version;
    readmeBadgeMatches = readmeAtRef !== null && !updateReadmeBadge(readmeAtRef, version).changed;
    if (currentBranch === branch) {
      const dirty = run("git", ["status", "--porcelain", "--", ...VERSION_SYNC_FILES]);
      hasUncommittedVersionSyncDiff = dirty !== "";
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
    prState: pr?.state ?? null,
  });
  log(`resolved resume stage: ${stage}`);

  if (DRY_RUN) {
    log(`dry run — would proceed from stage ${stage}, nothing mutated`);
    return;
  }

  if (stage === STAGE.DONE) {
    log(`${tag} already tagged and pushed — nothing to do`);
    printResult({ status: "success", version, tag, note: "already released" });
    return;
  }

  if (stage === STAGE.PUSH_TAG_ONLY) {
    pushTagOnly(tag);
    printResult({ status: "success", version, tag });
    return;
  }

  let prNumber = pr?.number;
  let prUrl = pr?.url;

  if (stage === STAGE.AWAITING_TAG) {
    const finalTag = tagFromMergedMain(prNumber, version);
    printResult({ status: "success", version, tag: finalTag, prNumber, prUrl });
    return;
  }

  if (stage !== STAGE.AWAITING_MERGE) {
    // FRESH / AWAITING_COMMIT / AWAITING_PR all resume the same idempotent pre-PR pipeline —
    // each step below no-ops on its own if already satisfied, so the distinction between
    // these three stages only affects the log message, not the code path.
    ensureBranch(branch, currentBranch, branchExistsLocal, branchExistsRemote);
    ensureVersionSync(version);
    ensureCommit(version);
    ensurePush(branch);
    const created = ensurePrCreated(branch, version);
    prNumber = created.number;
    prUrl = created.url;

    if (NO_MERGE) {
      log(`--no-merge: stopping after PR #${prNumber} (${prUrl})`);
      printResult({ status: "stopped", version, prNumber, prUrl, stage: "no-merge" });
      return;
    }
  }

  log(`waiting for checks on PR #${prNumber}...`);
  const checkResult = await waitForChecks(prNumber);
  if (!checkResult.ok) {
    if (checkResult.timedOut) {
      throw new Error(`checks still pending after ${CHECK_TIMEOUT_MS / 60_000}m — re-run to keep waiting (PR #${prNumber})`);
    }
    throw new Error(
      `check(s) failed on PR #${prNumber}: ${checkResult.failed.map((c) => c.name).join(", ")} — fix on ${branch} and re-push`
    );
  }
  log(`checks green on PR #${prNumber}`);

  const go = await confirmMerge(prNumber, YES);
  if (!go) {
    throw new Error(`merge not confirmed — PR #${prNumber} left open; re-run with --yes once ready`);
  }

  mergePr(prNumber);
  const finalTag = tagFromMergedMain(prNumber, version);
  printResult({ status: "success", version, tag: finalTag, prNumber, prUrl });
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[release] FAILED: ${err.message}`);
    printResult({ status: "failed", reason: err.message });
    process.exit(1);
  });
}
