// scripts/ops/release.test.js — node:test unit tests for release.js's pure decision
// functions (parseVersion, changelogHasVersionBlock, packageJsonVersion, updateReadmeBadge,
// resolveResumeStage). No I/O, no real git/gh/npm — the orchestration in main() shells out
// to real tools and is intentionally not covered here, same division as dedup.js/dedupJobs().

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersion,
  changelogHasVersionBlock,
  packageJsonVersion,
  updateReadmeBadge,
  resolveResumeStage,
  STAGE,
} from "./release.js";

// ---------- parseVersion ----------

test("parseVersion accepts a plain X.Y.Z version", () => {
  assert.deepEqual(parseVersion("1.3.0"), { version: "1.3.0", major: 1, minor: 3, patch: 0 });
});

test("parseVersion accepts multi-digit components", () => {
  assert.deepEqual(parseVersion("10.20.30"), { version: "10.20.30", major: 10, minor: 20, patch: 30 });
});

test("parseVersion rejects a leading v prefix", () => {
  assert.throws(() => parseVersion("v1.3.0"));
});

test("parseVersion rejects a 2-part version", () => {
  assert.throws(() => parseVersion("1.3"));
});

test("parseVersion rejects a prerelease suffix", () => {
  assert.throws(() => parseVersion("1.3.0-beta"));
});

test("parseVersion rejects a non-numeric component", () => {
  assert.throws(() => parseVersion("1.3.x"));
});

test("parseVersion rejects empty/undefined input", () => {
  assert.throws(() => parseVersion(""));
  assert.throws(() => parseVersion(undefined));
});

// ---------- changelogHasVersionBlock ----------

const changelogFixture = `# Changelog

## [1.2.1] — 2026-07-14

### Fixed
- Something.

## [1.2.0] — 2026-07-13

### Changed
- Something else.
`;

test("changelogHasVersionBlock matches the exact em-dash heading", () => {
  assert.equal(changelogHasVersionBlock(changelogFixture, "1.2.1"), true);
});

test("changelogHasVersionBlock matches a block that isn't first in the file", () => {
  assert.equal(changelogHasVersionBlock(changelogFixture, "1.2.0"), true);
});

test("changelogHasVersionBlock rejects a hyphen instead of an em dash", () => {
  const hyphenated = changelogFixture.replace("— 2026-07-14", "- 2026-07-14");
  assert.equal(changelogHasVersionBlock(hyphenated, "1.2.1"), false);
});

test("changelogHasVersionBlock rejects a version with no block", () => {
  assert.equal(changelogHasVersionBlock(changelogFixture, "1.3.0"), false);
});

test("changelogHasVersionBlock rejects a missing date", () => {
  const noDate = changelogFixture.replace("## [1.2.1] — 2026-07-14", "## [1.2.1]");
  assert.equal(changelogHasVersionBlock(noDate, "1.2.1"), false);
});

// ---------- packageJsonVersion ----------

test("packageJsonVersion extracts the version field", () => {
  assert.equal(packageJsonVersion('{"name":"job-bunny","version":"1.2.1"}'), "1.2.1");
});

test("packageJsonVersion returns null on malformed JSON", () => {
  assert.equal(packageJsonVersion("{not json"), null);
});

test("packageJsonVersion returns null when version field is absent", () => {
  assert.equal(packageJsonVersion('{"name":"job-bunny"}'), null);
});

// ---------- updateReadmeBadge ----------

const readmeFixture = '<img alt="Version" src="https://img.shields.io/badge/version-1.2.0-e8a0bf">';

test("updateReadmeBadge replaces an outdated badge version", () => {
  const r = updateReadmeBadge(readmeFixture, "1.2.1");
  assert.equal(r.changed, true);
  assert.equal(r.found, true);
  assert.match(r.text, /version-1\.2\.1-e8a0bf/);
});

test("updateReadmeBadge is a no-op when the badge already matches", () => {
  const r = updateReadmeBadge(readmeFixture, "1.2.0");
  assert.equal(r.changed, false);
  assert.equal(r.found, true);
  assert.equal(r.text, readmeFixture);
});

test("updateReadmeBadge reports found:false when the badge is missing entirely", () => {
  const r = updateReadmeBadge("# README with no badge", "1.2.1");
  assert.equal(r.found, false);
  assert.equal(r.changed, false);
});

// ---------- resolveResumeStage ----------

const baseState = {
  tagExistsLocal: false,
  tagExistsRemote: false,
  branchExistsLocal: false,
  branchExistsRemote: false,
  pkgVersionMatches: false,
  readmeBadgeMatches: false,
  hasUncommittedVersionSyncDiff: false,
  prState: null,
};

test("resolveResumeStage: DONE when tag exists locally and remotely", () => {
  assert.equal(
    resolveResumeStage({ ...baseState, tagExistsLocal: true, tagExistsRemote: true }),
    STAGE.DONE
  );
});

test("resolveResumeStage: PUSH_TAG_ONLY when tag exists locally but not remotely", () => {
  assert.equal(
    resolveResumeStage({ ...baseState, tagExistsLocal: true, tagExistsRemote: false }),
    STAGE.PUSH_TAG_ONLY
  );
});

test("resolveResumeStage: AWAITING_TAG when the PR is merged", () => {
  assert.equal(resolveResumeStage({ ...baseState, prState: "MERGED" }), STAGE.AWAITING_TAG);
});

test("resolveResumeStage: AWAITING_MERGE when the PR is open", () => {
  assert.equal(resolveResumeStage({ ...baseState, prState: "OPEN" }), STAGE.AWAITING_MERGE);
});

test("resolveResumeStage: throws on a closed-without-merged PR (anomaly)", () => {
  assert.throws(() => resolveResumeStage({ ...baseState, prState: "CLOSED" }));
});

test("resolveResumeStage: AWAITING_COMMIT when the branch exists but version-sync isn't complete", () => {
  assert.equal(
    resolveResumeStage({ ...baseState, branchExistsLocal: true, pkgVersionMatches: false }),
    STAGE.AWAITING_COMMIT
  );
});

test("resolveResumeStage: AWAITING_COMMIT when version-sync matches but has an uncommitted diff", () => {
  assert.equal(
    resolveResumeStage({
      ...baseState,
      branchExistsLocal: true,
      pkgVersionMatches: true,
      readmeBadgeMatches: true,
      hasUncommittedVersionSyncDiff: true,
    }),
    STAGE.AWAITING_COMMIT
  );
});

test("resolveResumeStage: AWAITING_PR when the branch is fully synced and committed but no PR exists", () => {
  assert.equal(
    resolveResumeStage({
      ...baseState,
      branchExistsRemote: true,
      pkgVersionMatches: true,
      readmeBadgeMatches: true,
    }),
    STAGE.AWAITING_PR
  );
});

test("resolveResumeStage: FRESH when nothing exists yet", () => {
  assert.equal(resolveResumeStage(baseState), STAGE.FRESH);
});
