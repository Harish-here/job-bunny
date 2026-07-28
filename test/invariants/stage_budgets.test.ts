/**
 * stage_budgets.test.ts — the drift guard for `pipeline/stages/
 * budgets.ts`'s `STAGE_BUDGETS` table (Task 8 of the scheduling-daemon
 * plan).
 *
 * `STAGE_BUDGETS` is a plain data mirror of every stage factory's own
 * `name`/`timeoutMs`/`retries`, read by `computeRunCapMs()` — consumed
 * by both `cli/commands/run.ts` (a real profile's own run) and, more
 * importantly, by `serve` (Task 9), which is cross-profile (D6) and
 * therefore cannot `wire()` a real profile to obtain a live `stages`
 * array the way `run.ts` does for itself. Nothing in the type system
 * enforces that the mirror stays accurate: if a stage's `timeoutMs`/
 * `retries` changes in its own `pipeline/stages/*.ts` factory without a
 * matching edit to `STAGE_BUDGETS`, the daemon's run-cap backstop
 * (`createSpawnRun`'s `runCapMs + BACKSTOP_MARGIN_MS`, Task 8) silently
 * shortens below the real worst case a run could legitimately take —
 * and then SIGKILLs a legitimate in-flight run instead of letting the
 * run's own `runCapMs` watchdog abort it gracefully.
 *
 * This test constructs the REAL stage factories (the same ones
 * `cli/wire/compose.ts` calls) with minimal placeholder ports that are NEVER
 * invoked — `.run()` is never called on any resulting `StageDef`, only
 * `.name`/`.timeoutMs`/`.retries` are read. That construction is
 * fragile: it holds only as long as no stage factory does real work at
 * construction time, which is exactly why it is deliberately confined
 * to this test rather than production code (`budgets.ts` reads a plain
 * table, no stage-factory imports) — an unmirrored change fails loudly
 * here, in CI, rather than silently in a running daemon.
 *
 * Spiritually the successor to `test/invariants/run_cap_backstop.
 * test.ts`, which still exists today and which Task 12 retires
 * alongside the launchd scheduler — it imports `DEFAULT_RUN_CAP_MS`
 * from `adapters/scheduler/launchd/plist.ts`, so it cannot outlive
 * that file. Same intent (catch a stage-budget drift before it reaches
 * production), same `test/invariants/` home, different mechanism (a
 * static table plus this construction-based guard, rather than a
 * hand-copied launchd literal).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RegistryPolicy } from '../../src/core/company/schema.ts';
import { FilterConfigSchema } from '../../src/core/filter/config.ts';
import { RankConfigSchema } from '../../src/core/rank/index.ts';
import { STAGE_BUDGETS } from '../../src/pipeline/stages/budgets.ts';
import {
  assembleStage,
  compressStage,
  dedupStage,
  makeFarmStage,
  makeFilterStage,
  makeRankStage,
  makeReconcileStage,
  makeSourceStage,
  makeStructureStage,
  makeSyncStage,
} from '../../src/pipeline/stages/index.ts';
import type { Connector } from '../../src/ports/connector.ts';
import type { LlmProvider } from '../../src/ports/llm.ts';

/** The frozen 10-stage order (CLAUDE.md's pipeline contract). Spelled out
 * here rather than derived from either side of the comparison: the length
 * check below catches a stage REMOVED from the pipeline, but an ADDED
 * stage mirrored into STAGE_BUDGETS in the same edit would slip past both
 * the length check and the per-index name comparison — the two arrays
 * would simply agree on eleven stages. This literal is the thing that
 * cannot be edited by accident. */
const FROZEN_STAGE_ORDER = [
  'reconcile',
  'farm',
  'source',
  'compress',
  'structure',
  'assemble',
  'filter',
  'dedup',
  'rank',
  'sync',
];

function buildWiredStages() {
  const stubConnector: Connector = {
    name: 'stub',
    rebuildCache: async () => [],
    syncJobs: async () => [],
    archiveStale: async () => ({ archived: 0, dropped: [] }),
  };
  const stubLlm: LlmProvider = { name: 'stub', complete: async () => '' };
  const registryPolicy: RegistryPolicy = {
    reprobeNotFoundAfterDays: 30,
    maxProbeFailures: 3,
    staleAfterFetchFailures: 3,
  };
  return [
    makeReconcileStage(stubConnector),
    makeFarmStage([]),
    makeSourceStage([], registryPolicy, { maxProbesPerRun: 1 }),
    compressStage,
    makeStructureStage(stubLlm),
    assembleStage,
    makeFilterStage(FilterConfigSchema.parse({})),
    dedupStage,
    makeRankStage(RankConfigSchema.parse({})),
    makeSyncStage(stubConnector, {}),
  ];
}

test('the wired stage factories are exactly the frozen ten-stage order', () => {
  assert.deepEqual(
    buildWiredStages().map((stage) => stage.name),
    FROZEN_STAGE_ORDER,
    'the pipeline stage order is frozen — adding, removing, or reordering a stage needs explicit sign-off',
  );
});

test("STAGE_BUDGETS mirrors every wired stage's name/timeoutMs/retries exactly, in order", () => {
  const wired = buildWiredStages();
  assert.equal(
    wired.length,
    STAGE_BUDGETS.length,
    'a stage was added to or removed from the pipeline without a matching STAGE_BUDGETS edit',
  );
  wired.forEach((stage, i) => {
    const budget = STAGE_BUDGETS[i];
    assert.ok(budget, `no STAGE_BUDGETS entry at index ${i} for wired stage "${stage.name}"`);
    assert.equal(budget.name, stage.name);
    assert.equal(budget.timeoutMs, stage.timeoutMs);
    assert.equal(budget.retries, stage.retries);
  });
});
