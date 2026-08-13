/**
 * suspend_gap_vs_tick.test.ts — the coupling + drift-guard check for
 * `core/schedule/suspend.ts`'s mirrored `TICK_MS` constant (Task 7 of the
 * pipeline-stability-hardening plan, blueprint step 1.6).
 *
 * `core/schedule/suspend.ts` cannot import `ops/daemon/daemon.ts` (core may
 * not import ops — `core-is-pure`), so it re-declares its own `TICK_MS`
 * rather than importing the daemon's. That leaves nothing in the type
 * system enforcing the two constants stay equal, or that the suspend-gap
 * threshold derived from the local copy still exceeds a single real tick
 * interval. This test lives outside `src/` (permitted to cross layer
 * boundaries, same idiom as the retired `test/invariants/
 * run_cap_backstop.test.ts`) specifically so it can import both sides and
 * fail loudly the moment either drifts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUSPECTED_SUSPEND_GAP_MS, TICK_MS } from '../../src/core/schedule/suspend.ts';
import { TICK_MS as DAEMON_TICK_MS } from '../../src/ops/daemon/daemon.ts';

test('SUSPECTED_SUSPEND_GAP_MS exceeds a single daemon tick interval', () => {
  assert.ok(
    SUSPECTED_SUSPEND_GAP_MS > DAEMON_TICK_MS,
    'a normal tick could be mistaken for a suspension if the suspend-gap threshold does not exceed one tick interval',
  );
});

test("core/schedule/suspend.ts's mirrored TICK_MS matches ops/daemon/daemon.ts's real one", () => {
  assert.equal(
    TICK_MS,
    DAEMON_TICK_MS,
    "core/schedule/suspend.ts's mirrored TICK_MS drifted from ops/daemon/daemon.ts's real constant — update the mirror to match",
  );
});
