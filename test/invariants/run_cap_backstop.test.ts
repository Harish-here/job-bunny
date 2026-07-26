/**
 * run_cap_backstop.test.ts — enforces, automatically, the one invariant
 * that closed a real incident (P9 closure register item 2): the launchd
 * hard-kill backstop (`DEFAULT_RUN_CAP_MS` in
 * `src/adapters/scheduler/launchd/plist.ts`, used by `buildCommand`'s
 * embedded watchdog when `wireScheduler()` doesn't supply an explicit
 * `runCapMs`) MUST stay above the derived run-level cap
 * (`computeRunCapMs` in `src/cli/commands/run.ts`, driven by the live
 * wired stage table's `timeoutMs`/`retries`). If it doesn't, launchd
 * SIGKILLs a legitimate in-flight run.
 *
 * `plist.test.ts` used to guard this with a hand-copied literal
 * (`PRODUCTION_RUN_CAP_MS = 13_012_500`) that nobody re-derives when a
 * stage's `timeoutMs`/`retries` changes — so the guard silently stopped
 * meaning anything the moment it drifted from the real wired value. This
 * test replaces that literal with the REAL production stage table, built
 * by the REAL `wire()` (the same composition every scheduled run goes
 * through), so it fails the moment either side moves without the other.
 *
 * `wire()` is fed a synthetic profile (`lanes: []`) via a fake `readFile`
 * — never the committed `profiles/rajni` fixture — so this stays a pure
 * unit test with zero filesystem side effects on any tracked profile
 * directory. This is safe because every stage's `timeoutMs`/`retries` is
 * a hardcoded constant in its `pipeline/stages/*.ts` factory, wholly
 * independent of which lanes/connector a profile configures — `farm`'s
 * budget is the same whether `farmingLanes` is `[]` or `['linkedin']` —
 * so an empty-lanes synthetic profile exercises the exact same 10-stage
 * timeout/retry table `wire()` builds for any real profile.
 *
 * Boundary note (why this file lives outside `src/`, not next to either
 * side it checks): `.dependency-cruiser.cjs` forbids `adapters -> cli`
 * (`nothing-imports-cli`) and forbids anything but `cli/wire.ts` from
 * importing `adapters` (`only-wire-imports-adapters`), so no test file
 * under `src/` may import both `cli/commands/run.ts` and
 * `adapters/scheduler/launchd/plist.ts`. `.dependency-cruiser.cjs`'s
 * `options.includeOnly: '^src'` means `npm run boundaries` (`depcruise
 * src`) only ever crawls forward from files under `src/` — a file
 * outside `src/` is never an entry point and is never reached while
 * walking those files' import graphs, so its own outbound imports are
 * never visited or rule-checked. `src/adapters/db/notion/schema.test.ts`
 * already relies on this exact mechanism (dynamically importing
 * `scripts/notion/schema.js` from inside `src/`, verified there with
 * `npx depcruise src` showing zero violations and the file as an
 * "orphan"); this test is the mirror image — a file OUTSIDE `src/`
 * statically importing two modules INSIDE `src/` that may not legally
 * import each other. Confirmed the same way: `npx depcruise src` reports
 * zero violations and never lists this file at all (it isn't `^src`, so
 * it's excluded from the cruise before rule evaluation, not merely from
 * the forbidden-edge check).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeRunCapMs } from '../../src/cli/commands/run.ts';
import { wire } from '../../src/cli/wire.ts';
import { DEFAULT_RUN_CAP_MS } from '../../src/adapters/scheduler/launchd/plist.ts';

const FAKE_ROOT = '/fake-repo-root';
const FAKE_PROFILE = 'ci-fixture';

// Minimal PipelineConfig: `lanes: []` means `buildLanes()` never reads
// `search_urls.md` or a page inventory, and every other stage factory's
// `timeoutMs`/`retries` is a hardcoded constant unaffected by `settings`.
const PROFILE_JSON = JSON.stringify({
  lanes: [],
  connector: 'notion',
  notifiers: [],
  routines: [],
  settings: {
    notion: { dbId: 'fake-db-id', dryRun: true },
  },
});

// filter.json is optional (loadFilterConfig returns undefined if absent),
// but `makeFilterStage`/`FilterConfigSchema.parse({})` both tolerate an
// empty object, so an empty filter config keeps this fixture minimal.
const FILTER_JSON = JSON.stringify({});

function fakeReadFile(path: string): Promise<string> {
  if (path === `${FAKE_ROOT}/profiles/${FAKE_PROFILE}/profile.json`) {
    return Promise.resolve(PROFILE_JSON);
  }
  if (path === `${FAKE_ROOT}/profiles/${FAKE_PROFILE}/filter.json`) {
    return Promise.resolve(FILTER_JSON);
  }
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return Promise.reject(err);
}

test('DEFAULT_RUN_CAP_MS backstop exceeds the real derived run cap (live wire() stage table)', async () => {
  const { stages } = await wire(FAKE_PROFILE, { root: FAKE_ROOT, readFile: fakeReadFile });
  const derivedCapMs = computeRunCapMs(stages);

  assert.ok(
    DEFAULT_RUN_CAP_MS > derivedCapMs,
    `DEFAULT_RUN_CAP_MS (${DEFAULT_RUN_CAP_MS}) must exceed the production-derived run cap ` +
      `(${derivedCapMs}) — otherwise wireScheduler()'s launchd backstop SIGKILLs a legitimate ` +
      `in-flight run before its own runCapMs watchdog gets a chance to abort gracefully. Either ` +
      'bump DEFAULT_RUN_CAP_MS in src/adapters/scheduler/launchd/plist.ts, or the stage table just ' +
      'grew faster than the backstop headroom accounts for.',
  );
});
