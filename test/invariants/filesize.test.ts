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
const PINS = new Map<string, number>([
  // lane.ts's own pin is gone (item 7 of the split brief landed it at
  // exactly 400 lines, at the cap). lane.test.ts's pin is gone too: the
  // test-split dispatch broke the 2958-line file into lane.test.ts,
  // lane_features.test.ts, lane_breaker.test.ts, pacing/pagination.test.ts,
  // pacing/pacing.test.ts, and search_urls.test.ts, plus a shared
  // testkit/ (browser_fakes.ts, fixtures.ts) for fixtures — every result
  // is under the 800-line cap.
  // wire.ts's and wire.test.ts's pins are gone too (task 2 of the split
  // brief, 2026-07-28): wire.ts became src/cli/wire/{config,registry,
  // settings,builders,compose}.ts + index.ts, and wire.test.ts's tests were
  // split by target into {config,registry,settings,compose}.test.ts plus a
  // shared testkit.ts fixture file — every result is under its cap.
  ['src/cli/commands/release.ts', 705],
  ['src/cli/commands/serve.ts', 513],
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
  // The pin list may only shrink. Never pin a NEW file — split it instead.
  assert.ok(PINS.size <= 8, `pin list grew to ${PINS.size} — 8 remain after wire.ts's split (task 2, 2026-07-28)`);

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
