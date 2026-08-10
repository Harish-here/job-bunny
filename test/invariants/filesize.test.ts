// Invariant: no file grows past the point where it can be skimmed. Caps and
// rationale live in .claude/agents/executor.md ("File-size caps"). Scope is
// exactly four roots — src/, test/, ui/src/, ui/e2e/ — never ui/ wholesale
// (that would walk ui/node_modules and ui/dist).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';

const IMPL_CAP = 400;
const TEST_CAP = 800;

const ROOT = join(import.meta.dirname, '..', '..');

// Each root gets its own vacuous-pass floor (the depcruise
// cruising-0-modules trap): a root that resolves to zero files must fail
// loudly, not pass green. Floors are round numbers comfortably below each
// root's current file count (roughly half), so a root that empties out
// trips the guard long before it reaches zero.
const ROOTS: { dir: string; floor: number }[] = [
  { dir: 'src', floor: 200 },
  { dir: 'test', floor: 3 },
  { dir: 'ui/src', floor: 80 },
  { dir: 'ui/e2e', floor: 6 },
];

function filesUnder(root: string): string[] {
  return readdirSync(join(ROOT, ...root.split('/')), { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
    .map((p) => [...root.split('/'), ...p.split(sep)].join('/'))
    .sort();
}

function sourceFiles(): string[] {
  return ROOTS.flatMap((r) => filesUnder(r.dir));
}

function lineCount(repoPath: string): number {
  const text = readFileSync(join(ROOT, ...repoPath.split('/')), 'utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function capFor(repoPath: string): number {
  const base = repoPath.split('/').at(-1) ?? '';
  const isTest = /\.(test|spec)\.tsx?$/.test(base);
  return isTest ? TEST_CAP : IMPL_CAP;
}

test('every src/test/ui .ts and .tsx file fits its cap (impl <= 400, test <= 800)', () => {
  for (const { dir, floor } of ROOTS) {
    const files = filesUnder(dir);
    // Guard against a vacuous pass per root (the depcruise cruising-0-modules trap).
    assert.ok(
      files.length > floor,
      `expected to walk ${dir}/, found only ${files.length} files`,
    );
  }

  const problems: string[] = [];
  for (const file of sourceFiles()) {
    const lines = lineCount(file);
    const cap = capFor(file);
    if (lines > cap) {
      problems.push(`${file}: ${lines} lines exceeds the ${cap}-line cap — split it`);
    }
  }
  assert.deepEqual(problems, []);
});
