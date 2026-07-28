// Invariant: no file grows past the point where it can be skimmed. Caps and the
// shrink-only pin ratchet are specified in docs/superpowers/specs/2026-07-28-file-size-caps-design.md;
// the rule's rationale lives in .claude/agents/executor.md ("File-size caps").

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
//
// PINS is now EMPTY — the file-size split effort is complete (task 5, the
// final PR, 2026-07-29): serve.ts became src/cli/commands/serve/{start,
// lifecycle,status}.ts + index.ts (serve.ts itself is gone); launcher.ts
// shed session_clear.ts; aggregate.ts shed config_checks.ts; source.ts shed
// gates.ts; rank.ts shed axes.ts — every result, impl and test alike, is
// under its cap. This map, and the ceiling check below, are kept only
// pending the final removal of this scaffold.
const PINS = new Map<string, number>([]);

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
  // The pin list may only shrink. Never pin a NEW file — split it instead.
  assert.ok(PINS.size <= 0, `pin list grew to ${PINS.size} — it must stay empty (task 5, 2026-07-29)`);

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
