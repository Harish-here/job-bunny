# File-Size Gate (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the file-size gate — an invariant test enforcing impl ≤ 400 / test ≤ 800 lines with a shrink-only pin list for current offenders — plus the rule prose in the executor agent.

**Architecture:** The gate is a `node:test` invariant at `test/invariants/filesize.test.ts` (the repo's established home for cross-cutting invariants; `scripts/` is a dead v0 path and must not be used). The existing `npm test` glob `test/**/*.test.ts` picks it up automatically, so it is inside `npm run check` with no CI changes; a new `npm run filesize` script runs it alone. Pre-existing offenders are pinned at their exact current line counts; pins may only shrink and die entirely in the final PR of the effort.

**Tech Stack:** Node 24 built-ins only (`node:test`, `node:fs`, `node:path`). No new dependencies (hard 3-runtime-dep cap).

**Spec:** `docs/superpowers/specs/2026-07-28-file-size-caps-design.md` (Task 2 amends its gate location — see Task 2 rationale).

> Historical note (2026-07-28): implementation found a 12th offender missed by the census below — `src/cli/commands/serve.ts` (513 lines). The committed gate pins 12 files; the committed test, not this plan's code block, is canonical.

## Global Constraints

- Node ≥ 24 required; verify `node -v` before running anything (`source ~/.nvm/nvm.sh && nvm use 24` if lower).
- Branch: `feat/file-size-caps` (already exists, holds the spec commit). `main` is protected — land via PR.
- ESM, TypeScript 7, erasable-syntax-only (no enums/namespaces), strict.
- No new runtime or dev dependencies.
- Markdown instruction files are code: state each rule once; tighten, don't duplicate.
- Every task ends with its verification commands actually run and passing.

---

### Task 1: The gate — `test/invariants/filesize.test.ts` + `npm run filesize`

**Files:**
- Create: `test/invariants/filesize.test.ts`
- Modify: `package.json` (add one script line)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the invariant test file and the `npm run filesize` script name; Task 2's prose references both verbatim.

- [ ] **Step 1: Confirm preconditions**

Run:
```bash
git branch --show-current
node -v
```
Expected: `feat/file-size-caps`, and a v24+ Node. If the branch is wrong, STOP.

- [ ] **Step 2: Create the gate test**

Create `test/invariants/filesize.test.ts` with exactly:

```ts
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';

const IMPL_CAP = 400;
const TEST_CAP = 800;

// Temporary pin list — see docs/superpowers/specs/2026-07-28-file-size-caps-design.md.
// A pinned file may never exceed its pin; when it shrinks, the pin must shrink with
// it, and once the file is under its cap the pin must be removed. Delete this map
// entirely in the final PR of the file-size effort.
const PINS = new Map<string, number>([
  ['src/adapters/lanes/linkedin/lane.ts', 1173],
  ['src/adapters/lanes/linkedin/lane.test.ts', 2956],
  ['src/cli/wire.ts', 772],
  ['src/cli/wire.test.ts', 882],
  ['src/cli/commands/release.ts', 705],
  ['src/adapters/browser/cdp-chrome/provider.ts', 582],
  ['src/adapters/browser/cdp-chrome/provider.test.ts', 877],
  ['src/adapters/browser/cdp-chrome/launcher.ts', 447],
  ['src/ops/doctor/aggregate.ts', 439],
  ['src/pipeline/stages/source.ts', 427],
  ['src/core/rank/rank.ts', 407],
]);

const ROOT = join(import.meta.dirname, '..', '..');

function sourceFiles(): string[] {
  return readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts'))
    .map((p) => ['src', ...p.split(sep)].join('/'))
    .sort();
}

function lineCount(repoPath: string): number {
  const text = readFileSync(join(ROOT, ...repoPath.split('/')), 'utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function capFor(repoPath: string): number {
  return repoPath.endsWith('.test.ts') ? TEST_CAP : IMPL_CAP;
}

test('every src .ts file fits its cap (impl <= 400, test <= 800); pins shrink-only', () => {
  const files = sourceFiles();
  // Guard against a vacuous pass (the depcruise cruising-0-modules trap).
  assert.ok(files.length > 50, `expected to walk src/, found only ${files.length} files`);

  const problems: string[] = [];
  for (const file of files) {
    const lines = lineCount(file);
    const cap = capFor(file);
    const pin = PINS.get(file);
    if (pin === undefined) {
      if (lines > cap) {
        problems.push(`${file}: ${lines} lines exceeds the ${cap}-line cap — split it`);
      }
      continue;
    }
    if (pin <= cap) {
      problems.push(`${file}: pin ${pin} is within the ${cap}-line cap — delete the pin`);
    } else if (lines > pin) {
      problems.push(`${file}: ${lines} lines exceeds its pin of ${pin} — pinned files may only shrink`);
    } else if (lines < pin) {
      problems.push(
        lines <= cap
          ? `${file}: now ${lines} lines (<= ${cap}) — remove its pin`
          : `${file}: shrank to ${lines} lines — lower its pin from ${pin} to ${lines}`,
      );
    }
  }
  assert.deepEqual(problems, []);
});

test('pin list contains no stale paths', () => {
  const files = new Set(sourceFiles());
  const stale = [...PINS.keys()].filter((p) => !files.has(p));
  assert.deepEqual(stale, [], `remove pins for deleted/renamed files: ${stale.join(', ')}`);
});
```

Notes for the implementer:
- `lineCount` matches `wc -l` semantics (a trailing newline does not add a line), so the pins above — measured with `wc -l` on 2026-07-28 — compare exactly.
- The walk uses `fs.readdirSync` recursive rather than `git ls-files` so untracked new files are caught before they are ever committed, and the test needs no git binary.
- `p.split(sep)` then joining with `/` normalizes Windows backslash paths; CI runs this on macos/ubuntu/windows.

- [ ] **Step 3: Run the gate — expect PASS**

Run:
```bash
node --test test/invariants/filesize.test.ts
```
Expected: 2 passing tests, 0 failing. If the first test fails, compare each reported count against the pin values — if a pinned file changed size since 2026-07-28, update its pin to the reported actual value (shrink) — but if a file GREW past its pin, STOP and report: that is real regression, not plan drift.

- [ ] **Step 4: Negative-verify the cap logic**

Temporarily edit `IMPL_CAP` from `400` to `10`, rerun:
```bash
node --test test/invariants/filesize.test.ts
```
Expected: FAIL, with the assertion diff listing many `exceeds the 10-line cap` entries. Revert `IMPL_CAP` to `400`, rerun, expect PASS. This proves the gate actually fires (guards against a silently-vacuous test).

- [ ] **Step 5: Negative-verify the stale-pin check**

Temporarily add `['src/does-not-exist.ts', 999],` to `PINS`, rerun the same command.
Expected: FAIL — the stale-paths test reports `src/does-not-exist.ts`, AND the first test reports it as a stale entry is absent from the walk (only the stale-paths failure is required). Revert, rerun, expect PASS with 2/2.

- [ ] **Step 6: Add the `filesize` npm script**

In `package.json`, inside `"scripts"`, add after the `"boundaries"` line:

```json
    "filesize": "node --test test/invariants/filesize.test.ts",
```

Do NOT modify the `"check"` script — the gate already runs inside `npm test` via the existing `test/**/*.test.ts` glob.

- [ ] **Step 7: Verify wiring**

Run:
```bash
npm run filesize
```
Expected: 2/2 pass.
```bash
npm test 2>&1 | grep -i filesize
```
Expected: output shows `filesize.test.ts` among executed test files (proves `npm run check` covers it with no further wiring).

- [ ] **Step 8: Commit**

```bash
git add test/invariants/filesize.test.ts package.json
git commit -m "test(invariants): add file-size gate (impl <=400, test <=800) with shrink-only pins

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Docs — rule prose in executor.md, spec amendment

**Files:**
- Modify: `.claude/agents/executor.md` (§3 Conventions checklist)
- Modify: `docs/superpowers/specs/2026-07-28-file-size-caps-design.md` (gate location)

**Interfaces:**
- Consumes: file path `test/invariants/filesize.test.ts` and script name `npm run filesize` from Task 1 — reference them verbatim.
- Produces: nothing later tasks depend on.

**Rationale for the spec amendment:** the spec placed the gate at `scripts/filesize.ts`, but `scripts/` is a dead v0 path by hard repo rule (executor.md §4.5, CLAUDE.md) and does not exist on this branch. `test/invariants/` is the repo's established home for cross-cutting invariants. The user-approved decisions (caps, pins, sequencing, executor-only prose) are unchanged.

- [ ] **Step 1: Add the rule bullet to executor.md**

In `.claude/agents/executor.md`, in section `## 3. Conventions checklist — apply to every change`, insert the following bullet immediately AFTER the `- **Colocated tests.**` bullet's paragraph and BEFORE `- **Zod at ingress, types inferred.**`:

```markdown
- **File-size caps — the modularity forcing function.**
  Implementation `.ts` files stay ≤ 400 lines; `.test.ts` files ≤ 800. Enforced by `test/invariants/filesize.test.ts` (runs inside `npm test`; alone via `npm run filesize`). Hitting a cap is a design signal, not a formatting problem: the file has grown a second responsibility — find the seam and split it (see the two-pair rule); never trim comments or compress code to sneak under. Pre-existing offenders are pinned in that test at their current size; pins only shrink, and the pin list is deleted once the last offender is split.
```

- [ ] **Step 2: Amend the spec's gate section**

In `docs/superpowers/specs/2026-07-28-file-size-caps-design.md`, replace the first paragraph of `## The gate` (the one beginning `A small script (`scripts/filesize.ts``) with:

```markdown
The gate is an invariant test, `test/invariants/filesize.test.ts` — the repo's established home for cross-cutting invariants (`scripts/` is a dead v0 path and is never used). It walks `src/**/*.ts`, counts lines with `wc -l` semantics, and fails listing every over-cap file. It runs inside `npm test` — and therefore `npm run check` — automatically; `npm run filesize` runs it alone. End state: **empty pin list** — the check passes because nothing is over cap.
```

Then in the `## Sequencing` section, replace the text `the check script + its test + \`npm run filesize\` wired into \`npm run check\`` with `the invariant gate test + \`npm run filesize\``.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/executor.md docs/superpowers/specs/2026-07-28-file-size-caps-design.md
git commit -m "docs: file-size rule in executor conventions; spec gate moves to test/invariants

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Full gate + PR

**Files:** none created or modified.

**Interfaces:**
- Consumes: all commits from Tasks 1-2 on `feat/file-size-caps`.
- Produces: the open PR.

- [ ] **Step 1: Run the full gate**

Run:
```bash
npm run check
```
Expected: typecheck, lint, boundaries, and all tests pass (including the new gate). If anything fails, fix the root cause — never weaken the gate to pass.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/file-size-caps
```

```bash
gh pr create --title "test: file-size gate — impl <=400 / test <=800 lines, shrink-only pins" --body "## Summary
- Adds \`test/invariants/filesize.test.ts\`: every implementation file <= 400 lines, every test file <= 800, with the 11 current offenders pinned at their exact sizes (pins may only shrink; the list dies in the final PR of this effort).
- \`npm run filesize\` runs the gate alone; it already runs inside \`npm test\` / \`npm run check\` via the existing glob — no CI changes.
- Adds the file-size rule to the executor agent's conventions checklist and amends the design spec's gate location (\`scripts/\` is a dead v0 path; \`test/invariants/\` is the repo's invariant home).

Design: docs/superpowers/specs/2026-07-28-file-size-caps-design.md
Plan: docs/superpowers/plans/2026-07-28-file-size-gate.md

## Test plan
- [x] \`npm run check\` green locally
- [x] Gate negative-verified (cap tightened to 10 fails loudly; stale pin fails loudly)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: PR URL printed. Report it.

---

## Self-review notes (already applied)

- Spec coverage: gate ✔ (Task 1), pin list with exact 2026-07-28 values ✔ (Task 1), `npm run filesize` ✔ (Task 1 Step 6), inside `npm run check` ✔ (transitively via `npm test`; verified Task 1 Step 7), executor.md prose ✔ (Task 2), spec location amendment ✔ (Task 2). Out of scope, deliberately: any file splitting (PRs 2-N), explainer KB (rule lives in executor.md only — user decision).
- The gate walks the filesystem, not git, so new untracked files are covered pre-commit; `test/invariants/filesize.test.ts` itself is outside `src/` and thus not self-measured — acceptable, it is ~90 lines.
- Biome's `files.includes` is `src/**` so the new test file is not linted/formatted by `npm run lint` — same as the two existing `test/invariants/` files; keep its style consistent manually.
