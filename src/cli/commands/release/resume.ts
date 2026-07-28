/**
 * cli/commands/release/resume.ts (split from release.ts) — the resume-stage
 * decision: given already-gathered read-only git/GitHub state, which stage
 * of the idempotent release pipeline (`index.ts`'s `releaseCommand`) to
 * resume from. Pure — no I/O, no `ReleaseDeps` — the state-gathering that
 * feeds it lives in `index.ts`.
 */

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
