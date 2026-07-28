/**
 * resume.test.ts (split from release.test.ts) — coverage for
 * `resolveResumeStage` (`./resume.ts`), the pure resume-stage decision.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveResumeStage, STAGE } from './resume.ts';

const baseResumeState = {
  tagExistsLocal: false,
  tagExistsRemote: false,
  branchExistsLocal: false,
  branchExistsRemote: false,
  pkgVersionMatches: false,
  readmeBadgeMatches: false,
  hasUncommittedVersionSyncDiff: false,
  prState: null,
};

test('resolveResumeStage: FRESH when nothing exists yet', () => {
  assert.equal(resolveResumeStage(baseResumeState), STAGE.FRESH);
});

test('resolveResumeStage: throws on a closed-without-merged PR (anomaly)', () => {
  assert.throws(() => resolveResumeStage({ ...baseResumeState, prState: 'CLOSED' }));
});
