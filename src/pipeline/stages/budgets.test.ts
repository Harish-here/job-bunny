import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StageBudget } from './budgets.ts';
import { computeRunCapMs, RUN_CAP_MARGIN, STAGE_BUDGETS } from './budgets.ts';

// Verified against every pipeline/stages/*.ts factory's real timeoutMs/
// retries (reconcile 60_000/0, farm 5_400_000/0, source 300_000/0,
// compress 30_000/0, structure 1_800_000/1, assemble 30_000/0, filter
// 30_000/0, dedup 30_000/0, rank 30_000/0, sync 900_000/0):
//   worst case = 60_000 + 5_400_000 + 300_000 + 30_000 + 1_800_000*2 +
//                30_000 + 30_000 + 30_000 + 30_000 + 900_000
//              = 10_410_000
//   run cap    = ceil(10_410_000 * 1.25) = 13_012_500

test('computeRunCapMs() with no argument sums STAGE_BUDGETS and applies RUN_CAP_MARGIN', () => {
  assert.equal(RUN_CAP_MARGIN, 1.25);
  assert.equal(computeRunCapMs(), 13_012_500);
});

test('the default STAGE_BUDGETS table sums to the verified worst-case figure', () => {
  const worstCaseMs = STAGE_BUDGETS.reduce(
    (sum, b) => sum + b.timeoutMs * (b.retries + 1),
    0,
  );
  assert.equal(worstCaseMs, 10_410_000);
});

test('computeRunCapMs() sums a custom budget array, not just the default table', () => {
  const budgets: StageBudget[] = [
    { name: 'a', timeoutMs: 10_000, retries: 0 },
    { name: 'b', timeoutMs: 20_000, retries: 0 },
  ];
  assert.equal(computeRunCapMs(budgets), 37_500); // (10_000 + 20_000) * 1.25
});

test('a stage with retries: 1 counts its timeoutMs twice toward the worst case', () => {
  const budgets: StageBudget[] = [{ name: 'x', timeoutMs: 10_000, retries: 1 }];
  assert.equal(computeRunCapMs(budgets), 25_000); // 10_000 * 2 * 1.25
});
