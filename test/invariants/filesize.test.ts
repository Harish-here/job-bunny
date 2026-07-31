// Invariant: no file grows past the point where it can be skimmed. Caps and
// rationale live in .claude/agents/executor.md ("File-size caps").

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';

const IMPL_CAP = 400;
const TEST_CAP = 800;

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

test('every src .ts file fits its cap (impl <= 400, test <= 800)', () => {
  const files = sourceFiles();
  // Guard against a vacuous pass (the depcruise cruising-0-modules trap).
  assert.ok(files.length > 50, `expected to walk src/, found only ${files.length} files`);

  const problems: string[] = [];
  for (const file of files) {
    const lines = lineCount(file);
    const cap = capFor(file);
    if (lines > cap) {
      problems.push(`${file}: ${lines} lines exceeds the ${cap}-line cap — split it`);
    }
  }
  assert.deepEqual(problems, []);
});