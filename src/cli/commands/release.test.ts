/**
 * release.test.ts (P9 pre-cutover) — TDD for `releaseCommand`. No real git/gh/npm
 * ever runs: `execCommand` is a fake dispatcher matched on `${cmd} ${args.join(' ')}`
 * prefixes, `readFile`/`writeFile` are in-memory maps, `confirm` and `sleep` are
 * injected fakes. Mirrors v0 `scripts/ops/release.test.js`'s pure-function coverage
 * (parseVersion/changelogHasVersionBlock/packageJsonVersion/updateReadmeBadge/
 * resolveResumeStage) plus orchestration coverage the v0 test deliberately left out
 * (it only shells out to real tools there) — required here because nothing else
 * exercises the resume-state detection, the merge-confirmation gate, or the
 * checks/tag failure paths end to end.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changelogHasVersionBlock,
  packageJsonVersion,
  parseVersion,
  type ReleaseDeps,
  releaseCommand,
  resolveResumeStage,
  STAGE,
  updateReadmeBadge,
} from './release.ts';

// ---------- pure functions ----------

test('parseVersion accepts a plain X.Y.Z version', () => {
  assert.deepEqual(parseVersion('1.3.0'), {
    version: '1.3.0',
    major: 1,
    minor: 3,
    patch: 0,
  });
});

test('parseVersion rejects a leading v prefix', () => {
  assert.throws(() => parseVersion('v1.3.0'));
});

test('parseVersion rejects a 2-part version', () => {
  assert.throws(() => parseVersion('1.3'));
});

test('parseVersion rejects a prerelease suffix', () => {
  assert.throws(() => parseVersion('1.3.0-beta'));
});

test('changelogHasVersionBlock matches the exact em-dash heading', () => {
  const text = '## [1.2.1] — 2026-07-14\n';
  assert.equal(changelogHasVersionBlock(text, '1.2.1'), true);
});

test('changelogHasVersionBlock rejects a missing date', () => {
  assert.equal(changelogHasVersionBlock('## [1.2.1]\n', '1.2.1'), false);
});

test('packageJsonVersion extracts the version field', () => {
  assert.equal(packageJsonVersion('{"name":"job-bunny","version":"1.2.1"}'), '1.2.1');
});

test('updateReadmeBadge reports found:false when the badge is missing entirely', () => {
  const r = updateReadmeBadge('# README with no badge', '1.2.1');
  assert.equal(r.found, false);
  assert.equal(r.changed, false);
});

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

// ---------- orchestration fakes ----------

interface FakeState {
  currentBranch: string;
  version: string;
  branch: string;
  tag: string;
  porcelainDirty?: string;
  tagExistsLocal?: boolean;
  tagExistsRemote?: boolean;
  branchExistsLocal?: boolean;
  branchExistsRemote?: boolean;
  pr?: { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string } | null;
  pkgAtRef?: string | null;
  readmeAtRef?: string | null;
  versionSyncDirty?: boolean;
  /** Sequential responses for successive `gh pr checks` polls. */
  checksSequence?: Array<Array<{ name: string; state: string }>>;
  mergeCommitSha?: string;
  mainHeadAfterMerge?: string;
  fetchOk?: boolean;
  localHead?: string;
  remoteHead?: string;
}

function makeExecCommand(state: FakeState) {
  let checksCallIndex = 0;
  // `git rev-parse HEAD` is called twice in different contexts: once during
  // preflight (before any merge — must equal origin/main) and once inside
  // `tagFromMergedMain` after `checkout main && pull` (must equal the PR's
  // merge-commit SHA). A stateless fake can't tell these apart by args
  // alone, so the SECOND call returns `mainHeadAfterMerge` when set.
  let revParseHeadCalls = 0;
  // Mutates when the fake sees `gh pr create` — models the PR that comes
  // into existence as a side effect of that call, the way the real GitHub
  // state would after a real `gh pr create`.
  let currentPr = state.pr ?? null;
  return (cmd: string, args: string[]) => {
    const joined = args.join(' ');
    const ok = (stdout = '') => ({ ok: true, stdout });
    const fail = () => ({
      ok: false,
      stdout: '',
      error: new Error(`fake: ${cmd} ${joined} not ok`),
    });

    if (cmd === 'gh' && joined === 'auth status') return ok('logged in');

    if (cmd === 'git' && joined === 'rev-parse --abbrev-ref HEAD')
      return ok(state.currentBranch);
    if (cmd === 'git' && joined === 'status --porcelain')
      return ok(state.porcelainDirty ?? '');
    if (cmd === 'git' && joined === 'fetch origin main --quiet') return ok('');
    if (cmd === 'git' && joined === 'rev-parse HEAD') {
      revParseHeadCalls += 1;
      if (revParseHeadCalls >= 2 && state.mainHeadAfterMerge !== undefined) {
        return ok(state.mainHeadAfterMerge);
      }
      return ok(state.localHead ?? 'localsha');
    }
    if (cmd === 'git' && joined === 'rev-parse origin/main')
      return ok(state.remoteHead ?? state.localHead ?? 'localsha');

    if (cmd === 'git' && joined === `tag -l ${state.tag}`) {
      return ok(state.tagExistsLocal ? state.tag : '');
    }
    if (cmd === 'git' && joined === `ls-remote --tags origin ${state.tag}`) {
      return ok(state.tagExistsRemote ? `deadbeef\trefs/tags/${state.tag}` : '');
    }
    if (cmd === 'git' && joined === `rev-parse --verify --quiet ${state.branch}`) {
      return state.branchExistsLocal ? ok(state.branch) : fail();
    }
    if (cmd === 'git' && joined === `ls-remote --heads origin ${state.branch}`) {
      return ok(state.branchExistsRemote ? `deadbeef\trefs/heads/${state.branch}` : '');
    }
    if (cmd === 'gh' && joined.startsWith(`pr list --head ${state.branch}`)) {
      return ok(JSON.stringify(currentPr ? [currentPr] : []));
    }
    if (cmd === 'git' && joined.startsWith('show ') && joined.endsWith(':package.json')) {
      return state.pkgAtRef != null ? ok(state.pkgAtRef) : fail();
    }
    if (cmd === 'git' && joined.startsWith('show ') && joined.endsWith(':README.md')) {
      return state.readmeAtRef != null ? ok(state.readmeAtRef) : fail();
    }
    if (cmd === 'git' && joined.startsWith(`status --porcelain -- ${'CHANGELOG.md'}`)) {
      return ok(state.versionSyncDirty ? ' M CHANGELOG.md\n' : '');
    }
    if (cmd === 'npm' && joined.startsWith('version ')) return ok('');
    if (cmd === 'git' && joined.startsWith('add ')) return ok('');
    if (cmd === 'git' && joined === 'diff --cached --name-only')
      return ok('CHANGELOG.md\n');
    if (cmd === 'git' && joined.startsWith('commit -m')) return ok('');
    if (cmd === 'git' && joined.startsWith('push -u origin')) return ok('');
    if (cmd === 'gh' && joined.startsWith('pr create')) {
      currentPr = { number: 999, state: 'OPEN', url: 'https://example/pr/999' };
      return ok('');
    }
    if (cmd === 'gh' && joined.startsWith('pr checks ')) {
      const seq = state.checksSequence ?? [];
      const resp = seq[Math.min(checksCallIndex, seq.length - 1)] ?? [];
      checksCallIndex += 1;
      return ok(JSON.stringify(resp));
    }
    if (cmd === 'gh' && joined.startsWith('pr merge')) return ok('');
    if (cmd === 'git' && joined === 'checkout main') return ok('');
    if (cmd === 'git' && joined.startsWith('checkout')) return ok('');
    if (cmd === 'git' && joined === 'pull') return ok('');
    if (cmd === 'gh' && joined.startsWith('pr view ')) {
      return ok(JSON.stringify({ mergeCommit: { oid: state.mergeCommitSha } }));
    }
    if (cmd === 'git' && joined.startsWith('tag ')) return ok('');
    if (cmd === 'git' && joined.startsWith('push origin')) return ok('');

    throw new Error(`unhandled fake command: ${cmd} ${joined}`);
  };
}

function makeDeps(state: FakeState, overrides: Partial<ReleaseDeps> = {}): ReleaseDeps {
  const files = new Map<string, string>([
    ['/repo/CHANGELOG.md', `## [${state.version}] — 2026-07-25\n`],
    ['/repo/package.json', JSON.stringify({ name: 'job-bunny', version: '0.0.0' })],
    ['/repo/README.md', '<img src="https://img.shields.io/badge/version-0.0.0-e8a0bf">'],
  ]);
  const logs: string[] = [];
  return {
    root: '/repo',
    execCommand: makeExecCommand(state),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`fake readFile: no fixture for ${p}`);
      return v;
    },
    writeFile: (p, data) => {
      files.set(p, data);
    },
    confirm: async () => 'n',
    sleep: async () => {},
    now: () => Date.now(),
    write: (line) => logs.push(line),
    warn: (line) => logs.push(line),
    ...overrides,
  };
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    currentBranch: 'main',
    version: '1.3.0',
    branch: 'release/v1.3.0',
    tag: 'v1.3.0',
    ...overrides,
  };
}

// ---------- dirty working tree ----------

test('rejects a dirty working tree with unrelated changes on main', async () => {
  const state = baseState({ porcelainDirty: ' M some_other_file.js\n' });
  const deps = makeDeps(state);
  const code = await releaseCommand({ version: '1.3.0' }, deps);
  assert.equal(code, 1);
});

// ---------- invalid version ----------

test('rejects an invalid version string', async () => {
  const state = baseState();
  const deps = makeDeps(state);
  const code = await releaseCommand({ version: 'v1.3' }, deps);
  assert.equal(code, 1);
});

// ---------- missing/undated CHANGELOG block ----------

test('rejects a CHANGELOG.md with no dated block for the version', async () => {
  const state = baseState();
  const deps = makeDeps(state);
  (deps.readFile as (p: string) => string) = (p: string) => {
    if (p === '/repo/CHANGELOG.md') return '# Changelog\nnothing here\n';
    if (p === '/repo/package.json') return JSON.stringify({ version: '0.0.0' });
    if (p === '/repo/README.md')
      return '<img src="https://img.shields.io/badge/version-0.0.0-e8a0bf">';
    throw new Error(`unexpected readFile ${p}`);
  };
  const code = await releaseCommand({ version: '1.3.0' }, deps);
  assert.equal(code, 1);
});

// ---------- resume states ----------

test('resume: DONE when tag exists locally and remotely — no-op success', async () => {
  const state = baseState({ tagExistsLocal: true, tagExistsRemote: true });
  const deps = makeDeps(state);
  const code = await releaseCommand({ version: '1.3.0' }, deps);
  assert.equal(code, 0);
});

test('resume: PUSH_TAG_ONLY pushes the existing local tag and stops', async () => {
  const state = baseState({ tagExistsLocal: true, tagExistsRemote: false });
  const pushed: string[][] = [];
  const deps = makeDeps(state);
  const wrapped = deps.execCommand;
  deps.execCommand = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'push') pushed.push(args);
    return wrapped(cmd, args);
  };
  const code = await releaseCommand({ version: '1.3.0' }, deps);
  assert.equal(code, 0);
  assert.ok(pushed.some((a) => a.includes('v1.3.0')));
});

test('resume: AWAITING_TAG tags the merged main HEAD when the SHA matches', async () => {
  const state = baseState({
    pr: { number: 42, state: 'MERGED', url: 'https://example/pr/42' },
    mergeCommitSha: 'abc123',
    mainHeadAfterMerge: 'abc123',
  });
  const deps = makeDeps(state);
  const code = await releaseCommand({ version: '1.3.0' }, deps);
  assert.equal(code, 0);
});

test('resume: AWAITING_COMMIT re-runs version sync/commit/push/PR when branch exists but pkg version is stale', async () => {
  const state = baseState({
    branchExistsLocal: true,
    pkgAtRef: JSON.stringify({ version: '0.0.0' }),
    readmeAtRef: '<img src="https://img.shields.io/badge/version-0.0.0-e8a0bf">',
    checksSequence: [[{ name: 'test', state: 'SUCCESS' }]],
    mergeCommitSha: 'deadbeef',
    mainHeadAfterMerge: 'deadbeef',
  });
  const deps = makeDeps(state);
  const code = await releaseCommand({ version: '1.3.0', yes: true }, deps);
  assert.equal(code, 0);
});

test('resume: AWAITING_PR opens a PR when branch is synced/committed but no PR exists', async () => {
  const state = baseState({
    branchExistsRemote: true,
    pkgAtRef: JSON.stringify({ version: '1.3.0' }),
    readmeAtRef: '<img src="https://img.shields.io/badge/version-1.3.0-e8a0bf">',
    checksSequence: [[{ name: 'test', state: 'SUCCESS' }]],
    mergeCommitSha: 'deadbeef',
    mainHeadAfterMerge: 'deadbeef',
  });
  const deps = makeDeps(state);
  const code = await releaseCommand({ version: '1.3.0', yes: true }, deps);
  assert.equal(code, 0);
});

test('resume: AWAITING_MERGE waits for checks and merges directly, skipping the pre-PR steps', async () => {
  const state = baseState({
    pr: { number: 7, state: 'OPEN', url: 'https://example/pr/7' },
    branchExistsRemote: true,
    pkgAtRef: JSON.stringify({ version: '1.3.0' }),
    readmeAtRef: '<img src="https://img.shields.io/badge/version-1.3.0-e8a0bf">',
    checksSequence: [[{ name: 'test', state: 'SUCCESS' }]],
    mergeCommitSha: 'deadbeef',
    mainHeadAfterMerge: 'deadbeef',
  });
  const deps = makeDeps(state);
  const code = await releaseCommand({ version: '1.3.0', yes: true }, deps);
  assert.equal(code, 0);
});

// ---------- --yes / interactive prompt ----------

test('--yes skips the interactive merge prompt', async () => {
  const state = baseState({
    pr: { number: 7, state: 'OPEN', url: 'https://example/pr/7' },
    checksSequence: [[{ name: 'test', state: 'SUCCESS' }]],
    mergeCommitSha: 'deadbeef',
    mainHeadAfterMerge: 'deadbeef',
  });
  let confirmCalled = false;
  const deps = makeDeps(state, {
    confirm: async () => {
      confirmCalled = true;
      return 'n';
    },
  });
  const code = await releaseCommand({ version: '1.3.0', yes: true }, deps);
  assert.equal(code, 0);
  assert.equal(confirmCalled, false);
});

test('without --yes, a "no" answer aborts without merging', async () => {
  const state = baseState({
    pr: { number: 7, state: 'OPEN', url: 'https://example/pr/7' },
    checksSequence: [[{ name: 'test', state: 'SUCCESS' }]],
  });
  let merged = false;
  const deps = makeDeps(state);
  const wrapped = deps.execCommand;
  deps.execCommand = (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') merged = true;
    return wrapped(cmd, args);
  };
  const code = await releaseCommand({ version: '1.3.0' }, deps); // confirm defaults to 'n'
  assert.equal(code, 1);
  assert.equal(merged, false);
});

// ---------- waitForChecks failure paths ----------

test('fails loudly when the "test" check reports FAILURE', async () => {
  const state = baseState({
    pr: { number: 7, state: 'OPEN', url: 'https://example/pr/7' },
    checksSequence: [[{ name: 'test', state: 'FAILURE' }]],
  });
  const deps = makeDeps(state, { confirm: async () => 'y' });
  const code = await releaseCommand({ version: '1.3.0' }, deps);
  assert.equal(code, 1);
});

test('fails loudly when checks time out (never reach SUCCESS)', async () => {
  const state = baseState({
    pr: { number: 7, state: 'OPEN', url: 'https://example/pr/7' },
    checksSequence: [[{ name: 'test', state: 'PENDING' }]],
  });
  // Injectable clock jumps 11 minutes forward on the first sleep — exercises
  // the timeout path without a real 10-minute wait.
  let elapsed = 0;
  const deps = makeDeps(state, {
    confirm: async () => 'y',
    now: () => elapsed,
    sleep: async () => {
      elapsed += 11 * 60 * 1000;
    },
  });
  const code = await releaseCommand({ version: '1.3.0' }, deps);
  assert.equal(code, 1);
});

// ---------- tag step refuses on SHA mismatch ----------

test('refuses to tag when the merged commit SHA does not match main HEAD', async () => {
  const state = baseState({
    pr: { number: 42, state: 'MERGED', url: 'https://example/pr/42' },
    mergeCommitSha: 'abc123',
    mainHeadAfterMerge: 'different-sha',
  });
  const deps = makeDeps(state);
  const code = await releaseCommand({ version: '1.3.0' }, deps);
  assert.equal(code, 1);
});
