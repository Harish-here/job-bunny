# LinkedIn Throttle Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a normal LinkedIn fire ~2.5× slower and less bursty, and turn a soft-throttled session from a mystery outage into a first-class, self-recovering `skipped` state.

**Architecture:** Four independently testable units, per the spec's §4.1. (1) **Pacing** — the lane's existing injected `sleepFn`/`randomFn` seam gains a second call site (a pause between saved-search URLs) and `cli/wire.ts`'s existing `settings.linkedin` zod schema raises its jitter defaults and gains an inter-URL pair. (2) A **pure throttle classifier** (`throttle.ts`) that counts consecutive server-withheld JD shells. (3) A **breaker store** (`breaker_store.ts`) persisting `{ openedAt, tripCount, lastProbeAt }` to `.chrome-debug/.jobbunny-linkedin-breaker.json` behind injectable fs deps, mirroring `adapters/browser/cdp-chrome/ownership/pidfile.ts` exactly. (4) One change in the `farm` stage so a `skipped` lane is excluded from the "every attempted lane failed" denominator. The lane composes all four: an open breaker returns `skipped` without launching Chrome; a half-open breaker spends ~2 requests on a probe; three consecutive shells mid-fire open the breaker, stop the fire, and keep every capture.

**Tech Stack:** TypeScript 7 (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, erasable-syntax-only), ESM, `node:test` + `node:assert/strict`, `node:vm` for in-page script tests, zod, Biome. Node ≥ 24, no build step.

**Spec:** `docs/superpowers/specs/2026-07-28-linkedin-throttle-guard-design.md` (decisions D1–D13 are final — implement as written; disagreements go in the implementer's NOTES, never into the code).

## Global Constraints

- Node ≥ 24 required (native type-stripping, no build step). `.nvmrc` pins it; plain `node`/`npm` work. If `node -v` shows < 24: `source ~/.nvm/nvm.sh && nvm use 24`.
- ESM only. TypeScript 7 `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + **`erasableSyntaxOnly`**: no enums, no namespaces, **no constructor parameter properties** (`constructor(private x: number)` will not compile — assign in the body).
- Runtime deps stay at three (`@notionhq/client`, `playwright`, `zod`; `dotenv` is the de-facto 4th). **Add no dependency.**
- Two-pair rule: every module is a folder with an `index.ts` public surface; internals are not imported across module boundaries.
- Colocated tests: `foo.ts` pairs with `foo.test.ts` in the same folder. `node:test` only.
- **Hermetic tests, no exceptions**: no real browser, no network, no real filesystem, no real clock. Every fs dep and every `now()` is injected. A test that would sit in a real `sleep` is a broken test — inject a spy `sleepFn`.
- Boundary rules (`npm run boundaries`, dependency-cruiser): `adapters/` may import only `ports` + `core` — never `pipeline`, `routines`, `ops`, or `cli`. **`adapters-no-cross-family`: `adapters/lanes/linkedin` may not import `adapters/browser/cdp-chrome`.** Only `src/cli/wire.ts` may import `src/adapters/**`.
- Biome owns lint/format: 2-space indent, 90-column line width, single quotes. Run it; do not hand-format to another style.
- **THE gate is `npm run check`** (typecheck + lint + boundaries + tests) — CI's `test` check is exactly this. Every task ends with it green. Fix root causes; never weaken a rule or skip a check to make it pass.
- `main` is protected — land via PR with the `test` check green.
- Never run pipeline stages against `profiles/harish/` (real user data). The fixture profile is `profiles/rajni/`.
- Do not hand-edit `CHANGELOG.md` or `package.json`'s version — owned by `npm run release`.
- Do not touch `src/adapters/lanes/linkedin/page_inventory/*.json`. The selectors were re-verified live on 2026-07-28 at a 100% match rate; this outage was not DOM drift (spec §1).
- Do not raise `farm`'s `TIMEOUT_MS` (spec §2 non-goals, D2). The new pacing must fit the existing 90-minute budget.
- Commit messages in this plan carry **no** trailers — no `Co-Authored-By`, no `Generated with`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/adapters/lanes/linkedin/jd_open.ts` | Modify | Export `buildJdRootPresenceScript` — the in-page check that separates "`jdRoot` matched but empty" (shell) from "`jdRoot` matched nothing" (drift). Today `buildJdTextScript` returns `''` for both, so the two are indistinguishable (spec §4.3). |
| `src/adapters/lanes/linkedin/jd_open.test.ts` | Modify | `node:vm` tests for the new script, using the file's existing fake-`document` harness. |
| `src/adapters/lanes/linkedin/throttle.ts` | **Create** | Pure, zero imports: `JdOutcome`, the two threshold constants, `ThrottleCounter`. |
| `src/adapters/lanes/linkedin/throttle.test.ts` | **Create** | Table tests over outcome sequences. |
| `src/adapters/lanes/linkedin/breaker_store.ts` | **Create** | `.chrome-debug/.jobbunny-linkedin-breaker.json` read/derive/write/delete behind injectable fs deps + injected `now`. |
| `src/adapters/lanes/linkedin/breaker_store.test.ts` | **Create** | Fake deps + fixed `now`; never touches a real fs or clock. |
| `src/adapters/lanes/linkedin/lane.ts` | Modify | Inter-URL pause; breaker read/probe/trip flow; honest all-urls-failed evidence. |
| `src/adapters/lanes/linkedin/lane.test.ts` | Modify | Pacing counts, open/half-open/trip paths, message wording. |
| `src/adapters/lanes/linkedin/index.ts` | Modify | Export the new public surface `wire.ts` needs. |
| `src/ports/lane.ts` | Modify | `FarmingLane.source()` gains `skipped?: { reason: string }`. |
| `src/pipeline/stages/farm.ts` | Modify | Skipped lanes excluded from the total-outage denominator; `TIMEOUT_MS` doc comment updated (value unchanged). |
| `src/pipeline/stages/farm.test.ts` | Modify | Skipped-lane cases. |
| `src/cli/wire.ts` | Modify | Raise the two jitter defaults; add the inter-URL pair to the same zod settings schema; pass `DEFAULT_USER_DATA_DIR` + real breaker deps into the lane. |
| `src/cli/wire.test.ts` | Modify | Updated default assertions + the new resolver's tests. |
| `CLAUDE.md` | Modify | One hard-rule line for the throttle guard + breaker file location. |
| `.claude/agents/explainer.md` | Modify | KB lines: lane pacing + breaker; farm's revised total-outage denominator. |

**Note on the two-pair rule:** `src/adapters/lanes/linkedin/` already holds six implementation files (`capture_store`, `harvest`, `inventory`, `jd_open`, `lane`, `resume_state`) — it was past the two-implementation-file threshold before this plan existed. `throttle.ts` and `breaker_store.ts` land as siblings because the spec names them as independent units and because splitting six pre-existing files into subfolders is a refactor with its own review surface, not part of a throttle fix. A follow-up split (`linkedin/throttle/` holding `counter.ts` + `breaker_store.ts` + `index.ts`) is recorded under Deferred follow-ups.

**Boundary note that governs Task 5:** `.chrome-debug/`'s path constant `DEFAULT_USER_DATA_DIR` lives in `src/adapters/browser/cdp-chrome/launcher.ts`. `adapters/browser` and `adapters/lanes` are **different adapter families**, and `adapters-no-cross-family` forbids the lane importing it. `lane.ts` must therefore never import anything from `adapters/browser/**`; `wire.ts` (which may import both) reads the constant and passes it to the lane as a plain `string`.

---

### Task 1: Detection primitives — shell vs missing, and the consecutive-shell counter

Delivers the two pure pieces the rest of the design depends on: an in-page script that can tell a present-but-empty `jdRoot` from an absent one, and a counter that decides when a run of shells means "throttled".

**Files:**
- Modify: `src/adapters/lanes/linkedin/jd_open.ts` (add an export next to `buildJdAnchorScript`, ~line 103)
- Test: `src/adapters/lanes/linkedin/jd_open.test.ts` (append at end of file)
- Create: `src/adapters/lanes/linkedin/throttle.ts`
- Test: `src/adapters/lanes/linkedin/throttle.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. `jd_open.ts`'s existing `buildJdAnchorScript(anchorText?, minChars?): string` is the style to mirror (a `string` of in-page source, exported purely so `node:vm` can execute it against a fake `document`).
- Produces:
  - `export function buildJdRootPresenceScript(jdRootSelector: string): string` — in-page source evaluating to `'1'` when `document.querySelector(jdRootSelector)` matches anything, `''` otherwise. Its source **must contain the literal token `jd-root-presence`** (as a comment) — `lane.test.ts`'s single fake `evaluate` routes scripts by inspecting their source, exactly as it already routes `buildHarvestScript` by the token `cardListSel`.
  - `export type JdOutcome = 'ok' | 'shell' | 'missing'`
  - `export const THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP = 3`
  - `export const THROTTLE_COOLDOWN_MS = 4 * 60 * 60 * 1000` (14_400_000)
  - `export class ThrottleCounter { constructor(threshold?: number); record(outcome: JdOutcome): void; get tripped(): boolean }`

- [ ] **Step 1: Write the failing vm tests for `buildJdRootPresenceScript`**

Append to `src/adapters/lanes/linkedin/jd_open.test.ts`. The file already imports `vm` from `node:vm` (line 5) and already has an `import { buildJdAnchorScript, openJd } from './jd_open.ts';` (line 11) — extend that import to `import { buildJdAnchorScript, buildJdRootPresenceScript, openJd } from './jd_open.ts';`.

```typescript
// --- buildJdRootPresenceScript, evaluated over a fake `document` via node:vm ---

/** Fake `document` whose querySelector matches `selector` and nothing else.
 * The returned element deliberately has NO text — the whole point of the
 * presence script is that a matched-but-empty jdRoot (the server-withheld
 * shell, spec §1) is distinguishable from no match at all. */
function fakePresenceDocument(selector: string | null): unknown {
  return {
    querySelector(s: string) {
      return selector !== null && s === selector ? { textContent: '' } : null;
    },
  };
}

test("buildJdRootPresenceScript returns '1' for a matched element even when it holds no text (the shell signature)", async () => {
  const selector = '[componentkey^="JobDetails_AboutTheJob"]';
  const document = fakePresenceDocument(selector);

  const result = await vm.runInNewContext(buildJdRootPresenceScript(selector), {
    document,
  });

  assert.equal(result, '1');
});

test("buildJdRootPresenceScript returns '' when the selector matches nothing (selector drift, not a throttle)", async () => {
  const document = fakePresenceDocument(null);

  const result = await vm.runInNewContext(
    buildJdRootPresenceScript('[componentkey^="JobDetails_AboutTheJob"]'),
    { document },
  );

  assert.equal(result, '');
});

test('buildJdRootPresenceScript carries the jd-root-presence marker token so a fake page can route it', () => {
  assert.match(buildJdRootPresenceScript('#x'), /jd-root-presence/);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
node --test src/adapters/lanes/linkedin/jd_open.test.ts
```

Expected: FAIL — `SyntaxError: The requested module './jd_open.ts' does not provide an export named 'buildJdRootPresenceScript'`.

- [ ] **Step 3: Implement `buildJdRootPresenceScript`**

In `src/adapters/lanes/linkedin/jd_open.ts`, insert this immediately after `buildJdAnchorScript` (which ends at line 117, just before `export interface JdOpenResult`):

```typescript
/** In-page presence check for jdRoot, returning `'1'` when the selector
 * matches ANY element and `''` when it matches none — deliberately
 * ignoring the element's text.
 *
 * This exists because `buildJdTextScript` above cannot answer the question
 * the throttle guard needs: it returns `''` both for "jdRoot matched
 * nothing" (selector drift) and for "jdRoot matched an element whose text
 * is empty" (the server-withheld skeleton shell LinkedIn serves to a
 * soft-blocked session — spec §1/§4.3). Those two are different failures
 * with opposite fixes (regenerate the inventory vs. back off), so the lane
 * runs this script after a failed JD open to tell them apart.
 *
 * The `jd-root-presence` comment token is load-bearing: lane.test.ts's
 * single fake `evaluate` routes scripts by inspecting their source (the
 * same trick that routes the harvest script by its `cardListSel`
 * declaration), so this script must stay identifiable. Exported for direct
 * vm-based testing, same pattern as buildJdAnchorScript. */
export function buildJdRootPresenceScript(jdRootSelector: string): string {
  return `(() => {
  // jd-root-presence
  const el = document.querySelector(${JSON.stringify(jdRootSelector)});
  return el ? '1' : '';
})()`;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test src/adapters/lanes/linkedin/jd_open.test.ts
```

Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Write the failing tests for `ThrottleCounter`**

Create `src/adapters/lanes/linkedin/throttle.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JdOutcome } from './throttle.ts';
import {
  THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP,
  THROTTLE_COOLDOWN_MS,
  ThrottleCounter,
} from './throttle.ts';

test('thresholds are the spec values: 3 consecutive shells (D5), 4h cooldown (D7)', () => {
  assert.equal(THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP, 3);
  assert.equal(THROTTLE_COOLDOWN_MS, 14_400_000);
});

const CASES: Array<{ name: string; outcomes: JdOutcome[]; tripped: boolean }> = [
  { name: 'no outcomes recorded at all', outcomes: [], tripped: false },
  { name: 'one shell', outcomes: ['shell'], tripped: false },
  { name: 'two consecutive shells (one below threshold)', outcomes: ['shell', 'shell'], tripped: false },
  { name: 'three consecutive shells', outcomes: ['shell', 'shell', 'shell'], tripped: true },
  {
    name: 'four consecutive shells stays tripped',
    outcomes: ['shell', 'shell', 'shell', 'shell'],
    tripped: true,
  },
  {
    name: 'an ok between shells resets the streak',
    outcomes: ['shell', 'shell', 'ok', 'shell', 'shell'],
    tripped: false,
  },
  {
    name: 'an ok after three shells clears the trip',
    outcomes: ['shell', 'shell', 'shell', 'ok'],
    tripped: false,
  },
  {
    name: 'missing never counts toward a trip, however many',
    outcomes: ['missing', 'missing', 'missing', 'missing', 'missing'],
    tripped: false,
  },
  {
    name: 'missing does not break a shell streak either',
    outcomes: ['shell', 'missing', 'shell', 'missing', 'shell'],
    tripped: true,
  },
  {
    name: 'ok outcomes alone never trip',
    outcomes: ['ok', 'ok', 'ok', 'ok'],
    tripped: false,
  },
];

for (const testCase of CASES) {
  test(`ThrottleCounter: ${testCase.name} -> tripped=${testCase.tripped}`, () => {
    const counter = new ThrottleCounter();
    for (const outcome of testCase.outcomes) counter.record(outcome);
    assert.equal(counter.tripped, testCase.tripped);
  });
}

test('ThrottleCounter: tripped flips exactly at the threshold, not before', () => {
  const counter = new ThrottleCounter();
  counter.record('shell');
  assert.equal(counter.tripped, false);
  counter.record('shell');
  assert.equal(counter.tripped, false);
  counter.record('shell');
  assert.equal(counter.tripped, true);
});

test('ThrottleCounter: honors an injected threshold (so a test never has to hardcode 3)', () => {
  const counter = new ThrottleCounter(2);
  counter.record('shell');
  assert.equal(counter.tripped, false);
  counter.record('shell');
  assert.equal(counter.tripped, true);
});
```

- [ ] **Step 6: Run the tests and watch them fail**

```bash
node --test src/adapters/lanes/linkedin/throttle.test.ts
```

Expected: FAIL — `Cannot find module '.../src/adapters/lanes/linkedin/throttle.ts'`.

- [ ] **Step 7: Implement `throttle.ts`**

Create `src/adapters/lanes/linkedin/throttle.ts`:

```typescript
/**
 * Throttle classifier (spec §4.3) — PURE, zero imports, no I/O, no clock.
 *
 * On 2026-07-28 LinkedIn soft-throttled the shared `.chrome-debug` session:
 * the JD hydration request returned 503 while every other request on the
 * page returned 200, so `jdRoot` was present in the DOM with
 * `textContent.length === 0` — a skeleton shell. That is a completely
 * different failure from `jdRoot` not matching at all (selector drift),
 * and conflating the two is the misdiagnosis this module exists to end.
 *
 * Counting is CONSECUTIVE, not cumulative (D5): one or two empty JDs happen
 * for benign reasons (a pulled posting, a slow pane), so a mostly-healthy
 * fire with scattered failures must never trip. A real-text outcome resets
 * the streak; a `missing` outcome leaves it untouched, because selector
 * drift is not evidence of a throttle in either direction.
 */

/** One JD open's outcome. `shell` = jdRoot matched, extracted text empty
 * (the throttle signature). `missing` = jdRoot matched nothing (selector
 * drift — NOT a throttle signal). `ok` = real text came back. */
export type JdOutcome = 'ok' | 'shell' | 'missing';

/** Consecutive `shell` outcomes that mean "this session is blocked" (D5). */
export const THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP = 3;

/** How long the breaker stays open after a trip (D7): long enough to
 * outlast a typical soft block and to break the three-fires-in-five-hours
 * stacking pattern, short enough that same-day recovery is still possible. */
export const THROTTLE_COOLDOWN_MS = 4 * 60 * 60 * 1000;

export class ThrottleCounter {
  private consecutiveShells = 0;
  private readonly threshold: number;

  constructor(threshold: number = THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP) {
    this.threshold = threshold;
  }

  record(outcome: JdOutcome): void {
    if (outcome === 'ok') {
      this.consecutiveShells = 0;
      return;
    }
    if (outcome === 'shell') {
      this.consecutiveShells += 1;
    }
    // 'missing' deliberately falls through: it neither counts toward a trip
    // nor breaks an existing streak.
  }

  get tripped(): boolean {
    return this.consecutiveShells >= this.threshold;
  }
}
```

- [ ] **Step 8: Run the tests and watch them pass**

```bash
node --test src/adapters/lanes/linkedin/throttle.test.ts
```

Expected: PASS — 13 tests.

- [ ] **Step 9: Run the full gate**

```bash
npm run check
```

Expected: typecheck, lint, boundaries, and every test green.

- [ ] **Step 10: Commit**

```bash
git add src/adapters/lanes/linkedin/jd_open.ts src/adapters/lanes/linkedin/jd_open.test.ts src/adapters/lanes/linkedin/throttle.ts src/adapters/lanes/linkedin/throttle.test.ts
git commit -m "feat(linkedin): detect a server-withheld JD shell and count consecutive ones"
```

---

### Task 2: Breaker store — session-scoped, injectable fs, never throws

Persists the throttle state next to the Chrome pid file it deliberately mirrors. Nothing here knows about the lane; it is a file plus three derived phases.

**Files:**
- Create: `src/adapters/lanes/linkedin/breaker_store.ts`
- Test: `src/adapters/lanes/linkedin/breaker_store.test.ts`
- Reference (read, do not modify): `src/adapters/browser/cdp-chrome/ownership/pidfile.ts` — `ChromePidfileDeps` is the shape to mirror, minus `pidIsAlive`.

**Interfaces:**
- Consumes: nothing. `cooldownMs` is a **parameter**, not an import — that keeps this module free of any dependency on `throttle.ts` (the lane passes `THROTTLE_COOLDOWN_MS` in).
- Produces:
  - `export interface LinkedinBreakerState { openedAt: string; tripCount: number; lastProbeAt?: string }`
  - `export interface LinkedinBreakerDeps { existsSync(path: string): boolean; readFileSync(path: string): string; writeFileSync(path: string, data: string): void; mkdirSync(path: string): void; unlinkSync(path: string): void; now(): Date }`
  - `export type BreakerPhase = 'closed' | 'open' | 'half-open'`
  - `export function linkedinBreakerPath(userDataDir: string): string`
  - `export function readBreaker(userDataDir: string, deps: LinkedinBreakerDeps): LinkedinBreakerState | undefined`
  - `export function breakerPhase(state: LinkedinBreakerState | undefined, now: Date, cooldownMs: number): BreakerPhase`
  - `export function openBreaker(userDataDir: string, deps: LinkedinBreakerDeps, prev?: LinkedinBreakerState): boolean`
  - `export function recordProbe(userDataDir: string, deps: LinkedinBreakerDeps, prev?: LinkedinBreakerState): boolean`
  - `export function closeBreaker(userDataDir: string, deps: LinkedinBreakerDeps): void`
  - `export function defaultLinkedinBreakerDeps(): LinkedinBreakerDeps`

- [ ] **Step 1: Write the failing test file**

Create `src/adapters/lanes/linkedin/breaker_store.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LinkedinBreakerDeps, LinkedinBreakerState } from './breaker_store.ts';
import {
  breakerPhase,
  closeBreaker,
  defaultLinkedinBreakerDeps,
  linkedinBreakerPath,
  openBreaker,
  readBreaker,
  recordProbe,
} from './breaker_store.ts';

const USER_DATA_DIR = '/repo/.chrome-debug';
// Built via node:path's join (not a literal) so the expected value tracks
// whatever separator the host platform produces — linkedinBreakerPath is
// implemented with join too. Same posture as pidfile.test.ts.
const BREAKER_PATH = join(USER_DATA_DIR, '.jobbunny-linkedin-breaker.json');

const NOW = new Date('2026-07-28T12:00:00.000Z');
const COOLDOWN_MS = 4 * 60 * 60 * 1000;

function fakeDeps(overrides: Partial<LinkedinBreakerDeps> = {}): LinkedinBreakerDeps {
  return {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('no file');
    },
    writeFileSync: () => {},
    mkdirSync: () => {},
    unlinkSync: () => {},
    now: () => NOW,
    ...overrides,
  };
}

/** fakeDeps with a file "on disk" holding exactly `raw`. */
function storedDeps(
  raw: string,
  overrides: Partial<LinkedinBreakerDeps> = {},
): LinkedinBreakerDeps {
  return fakeDeps({ existsSync: () => true, readFileSync: () => raw, ...overrides });
}

test('linkedinBreakerPath joins userDataDir with the fixed breaker file name', () => {
  assert.equal(linkedinBreakerPath(USER_DATA_DIR), BREAKER_PATH);
});

// --- readBreaker ---

test('readBreaker: no file -> undefined, and readFileSync is never called', () => {
  let reads = 0;
  const deps = fakeDeps({
    readFileSync: () => {
      reads += 1;
      return '';
    },
  });
  assert.equal(readBreaker(USER_DATA_DIR, deps), undefined);
  assert.equal(reads, 0);
});

test('readBreaker: a well-formed file round-trips, including the optional lastProbeAt', () => {
  const state: LinkedinBreakerState = {
    openedAt: '2026-07-28T09:00:00.000Z',
    tripCount: 2,
    lastProbeAt: '2026-07-28T11:00:00.000Z',
  };
  assert.deepEqual(readBreaker(USER_DATA_DIR, storedDeps(JSON.stringify(state))), state);
});

test('readBreaker: reads the path linkedinBreakerPath produces', () => {
  const paths: string[] = [];
  const deps = storedDeps('{"openedAt":"2026-07-28T09:00:00.000Z","tripCount":1}', {
    existsSync: (path) => {
      paths.push(path);
      return true;
    },
  });
  readBreaker(USER_DATA_DIR, deps);
  assert.deepEqual(paths, [BREAKER_PATH]);
});

test('readBreaker: unparseable JSON -> undefined, never throws, and does NOT delete the file', () => {
  let unlinks = 0;
  const deps = storedDeps('{not json', { unlinkSync: () => { unlinks += 1; } });
  assert.equal(readBreaker(USER_DATA_DIR, deps), undefined);
  assert.equal(unlinks, 0);
});

test('readBreaker: wrong shape (tripCount not a number) -> undefined', () => {
  const raw = JSON.stringify({ openedAt: '2026-07-28T09:00:00.000Z', tripCount: 'two' });
  assert.equal(readBreaker(USER_DATA_DIR, storedDeps(raw)), undefined);
});

test('readBreaker: an openedAt that is not a parseable date -> undefined', () => {
  const raw = JSON.stringify({ openedAt: 'yesterday-ish', tripCount: 1 });
  assert.equal(readBreaker(USER_DATA_DIR, storedDeps(raw)), undefined);
});

test('readBreaker: an unreadable file (EACCES) -> undefined, never throws', () => {
  const deps = fakeDeps({
    existsSync: () => true,
    readFileSync: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(readBreaker(USER_DATA_DIR, deps), undefined);
});

// --- breakerPhase ---

function stateOpenedAt(iso: string): LinkedinBreakerState {
  return { openedAt: iso, tripCount: 1 };
}

test('breakerPhase: no state at all -> closed', () => {
  assert.equal(breakerPhase(undefined, NOW, COOLDOWN_MS), 'closed');
});

test('breakerPhase: inside the cooldown window -> open', () => {
  // Opened 1h ago, 4h cooldown.
  assert.equal(
    breakerPhase(stateOpenedAt('2026-07-28T11:00:00.000Z'), NOW, COOLDOWN_MS),
    'open',
  );
});

test('breakerPhase: exactly AT the boundary -> half-open (>= is recovery, not still-open)', () => {
  assert.equal(
    breakerPhase(stateOpenedAt('2026-07-28T08:00:00.000Z'), NOW, COOLDOWN_MS),
    'half-open',
  );
});

test('breakerPhase: one millisecond before the boundary is still open', () => {
  assert.equal(
    breakerPhase(stateOpenedAt('2026-07-28T08:00:00.001Z'), NOW, COOLDOWN_MS),
    'open',
  );
});

test('breakerPhase: well past the window -> half-open', () => {
  assert.equal(
    breakerPhase(stateOpenedAt('2026-07-27T08:00:00.000Z'), NOW, COOLDOWN_MS),
    'half-open',
  );
});

test('breakerPhase: a corrupt openedAt is treated as closed, never as a permanent block (D12)', () => {
  assert.equal(breakerPhase(stateOpenedAt('not-a-date'), NOW, COOLDOWN_MS), 'closed');
});

// --- openBreaker ---

test('openBreaker: writes openedAt=now and tripCount=1 when there was no prior state', () => {
  const writes: Array<{ path: string; data: string }> = [];
  const deps = fakeDeps({
    writeFileSync: (path, data) => {
      writes.push({ path, data });
    },
  });

  assert.equal(openBreaker(USER_DATA_DIR, deps), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.path, BREAKER_PATH);
  assert.deepEqual(JSON.parse(writes[0]?.data ?? '{}'), {
    openedAt: NOW.toISOString(),
    tripCount: 1,
  });
});

test('openBreaker: increments a prior tripCount and preserves lastProbeAt', () => {
  const writes: string[] = [];
  const deps = fakeDeps({ writeFileSync: (_path, data) => { writes.push(data); } });
  const prev: LinkedinBreakerState = {
    openedAt: '2026-07-28T04:00:00.000Z',
    tripCount: 3,
    lastProbeAt: '2026-07-28T11:59:00.000Z',
  };

  assert.equal(openBreaker(USER_DATA_DIR, deps, prev), true);
  assert.deepEqual(JSON.parse(writes[0] ?? '{}'), {
    openedAt: NOW.toISOString(),
    tripCount: 4,
    lastProbeAt: '2026-07-28T11:59:00.000Z',
  });
});

test('openBreaker: creates userDataDir BEFORE writing (a fresh clone has no .chrome-debug/)', () => {
  const order: string[] = [];
  const deps = fakeDeps({
    mkdirSync: (path) => {
      order.push(`mkdir:${path}`);
    },
    writeFileSync: (path) => {
      order.push(`write:${path}`);
    },
  });

  openBreaker(USER_DATA_DIR, deps);

  assert.deepEqual(order, [`mkdir:${USER_DATA_DIR}`, `write:${BREAKER_PATH}`]);
});

test('openBreaker: a failed write returns false and never throws (D12 — fail toward working)', () => {
  const deps = fakeDeps({
    writeFileSync: () => {
      throw new Error('ENOSPC: no space left on device');
    },
  });
  assert.equal(openBreaker(USER_DATA_DIR, deps), false);
});

test('openBreaker: a failed mkdir returns false and never throws', () => {
  const deps = fakeDeps({
    mkdirSync: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(openBreaker(USER_DATA_DIR, deps), false);
});

// --- recordProbe ---

test('recordProbe: stamps lastProbeAt while leaving openedAt and tripCount untouched', () => {
  const writes: string[] = [];
  const deps = fakeDeps({ writeFileSync: (_path, data) => { writes.push(data); } });
  const prev: LinkedinBreakerState = {
    openedAt: '2026-07-28T04:00:00.000Z',
    tripCount: 2,
  };

  assert.equal(recordProbe(USER_DATA_DIR, deps, prev), true);
  assert.deepEqual(JSON.parse(writes[0] ?? '{}'), {
    openedAt: '2026-07-28T04:00:00.000Z',
    tripCount: 2,
    lastProbeAt: NOW.toISOString(),
  });
});

test('recordProbe: with no prior state it writes nothing — stamping a probe must never OPEN the breaker', () => {
  let writes = 0;
  const deps = fakeDeps({ writeFileSync: () => { writes += 1; } });
  assert.equal(recordProbe(USER_DATA_DIR, deps, undefined), false);
  assert.equal(writes, 0);
});

test('recordProbe: a failed write returns false and never throws', () => {
  const deps = fakeDeps({
    writeFileSync: () => {
      throw new Error('EROFS: read-only file system');
    },
  });
  const prev: LinkedinBreakerState = { openedAt: '2026-07-28T04:00:00.000Z', tripCount: 1 };
  assert.equal(recordProbe(USER_DATA_DIR, deps, prev), false);
});

// --- closeBreaker ---

test('closeBreaker: unlinks the breaker file', () => {
  const unlinked: string[] = [];
  const deps = fakeDeps({
    existsSync: () => true,
    unlinkSync: (path) => {
      unlinked.push(path);
    },
  });
  closeBreaker(USER_DATA_DIR, deps);
  assert.deepEqual(unlinked, [BREAKER_PATH]);
});

test('closeBreaker: tolerates a missing file (ENOENT) without throwing', () => {
  const deps = fakeDeps({
    existsSync: () => true,
    unlinkSync: () => {
      throw new Error('ENOENT: no such file or directory');
    },
  });
  assert.doesNotThrow(() => closeBreaker(USER_DATA_DIR, deps));
});

// --- defaultLinkedinBreakerDeps ---

test('defaultLinkedinBreakerDeps supplies every dep and a real clock', () => {
  const deps = defaultLinkedinBreakerDeps();
  for (const key of [
    'existsSync',
    'readFileSync',
    'writeFileSync',
    'mkdirSync',
    'unlinkSync',
    'now',
  ] as const) {
    assert.equal(typeof deps[key], 'function', `${key} must be provided`);
  }
  assert.ok(deps.now() instanceof Date);
  // No pidIsAlive: unlike the Chrome pid file this state describes a
  // time window, not a process.
  assert.equal('pidIsAlive' in deps, false);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
node --test src/adapters/lanes/linkedin/breaker_store.test.ts
```

Expected: FAIL — `Cannot find module '.../src/adapters/lanes/linkedin/breaker_store.ts'`.

- [ ] **Step 3: Implement `breaker_store.ts`**

Create `src/adapters/lanes/linkedin/breaker_store.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LinkedIn throttle circuit-breaker state (spec §4.4, D11) —
 * `<userDataDir>/.jobbunny-linkedin-breaker.json`.
 *
 * SESSION-scoped, not profile-scoped, and that is the whole point: the
 * throttle is a property of the shared `.chrome-debug` Chrome profile whose
 * cookies every profile farms through, so profile-scoped state would make
 * each profile relearn the same session-wide block. It sits next to the
 * Chrome pid file (`.jobbunny-chrome.json`) for exactly that reason, and
 * mirrors `adapters/browser/cdp-chrome/ownership/pidfile.ts`'s injectable-
 * deps shape (minus `pidIsAlive` — this state describes a time window, not
 * a process) so no test ever touches a real filesystem or clock.
 *
 * FAILURE POSTURE (D12): breaker state must never break a run. Every read
 * failure degrades to `undefined` (⇒ phase `closed` ⇒ farm normally) and
 * every write failure is swallowed into a `false` return. The worst case of
 * a lost write is that the next fire re-detects the throttle — exactly the
 * position the pipeline was in before this file existed.
 *
 * This module deliberately does NOT import `throttle.ts`: the cooldown is a
 * parameter of `breakerPhase`, so the store stays a plain file+phase
 * utility with no opinion about thresholds.
 */
export interface LinkedinBreakerState {
  /** ISO 8601 — when the breaker was last opened. */
  openedAt: string;
  /** Cumulative trips, diagnostic only. */
  tripCount: number;
  /** ISO 8601 — when a half-open probe last ran. */
  lastProbeAt?: string;
}

export interface LinkedinBreakerDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  /** Recursive mkdir of the breaker file's parent (userDataDir) — on a
   * fresh clone `.chrome-debug/` may not exist yet (spec §5). */
  mkdirSync(path: string): void;
  unlinkSync(path: string): void;
  now(): Date;
}

/** Derived, never stored as a string (spec §4.4). */
export type BreakerPhase = 'closed' | 'open' | 'half-open';

const BREAKER_FILE_NAME = '.jobbunny-linkedin-breaker.json';

export function linkedinBreakerPath(userDataDir: string): string {
  return join(userDataDir, BREAKER_FILE_NAME);
}

function isBreakerShape(value: unknown): value is LinkedinBreakerState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<LinkedinBreakerState>;
  if (typeof v.openedAt !== 'string' || !Number.isFinite(Date.parse(v.openedAt))) {
    return false;
  }
  if (typeof v.tripCount !== 'number' || !Number.isFinite(v.tripCount)) return false;
  return v.lastProbeAt === undefined || typeof v.lastProbeAt === 'string';
}

/**
 * Reads the breaker file. A missing, unreadable, unparseable, or
 * wrong-shaped file is `undefined` — which `breakerPhase` turns into
 * `closed`, i.e. farm normally (D12).
 *
 * Unlike the Chrome pid file this never self-heals by deleting a bad file:
 * deleting is a write, writes can fail, and a corrupt breaker file is
 * already harmless (it reads as closed). Leaving it in place also leaves
 * the evidence for whoever investigates.
 */
export function readBreaker(
  userDataDir: string,
  deps: LinkedinBreakerDeps,
): LinkedinBreakerState | undefined {
  try {
    const path = linkedinBreakerPath(userDataDir);
    if (!deps.existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(deps.readFileSync(path));
    return isBreakerShape(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Phase for `state` at `now` (spec §4.4). A missing state, or one whose
 * `openedAt` will not parse, is `closed` — corrupt state must never
 * masquerade as a permanent block. */
export function breakerPhase(
  state: LinkedinBreakerState | undefined,
  now: Date,
  cooldownMs: number,
): BreakerPhase {
  if (!state) return 'closed';
  const openedAtMs = Date.parse(state.openedAt);
  if (!Number.isFinite(openedAtMs)) return 'closed';
  return now.getTime() < openedAtMs + cooldownMs ? 'open' : 'half-open';
}

function writeState(
  userDataDir: string,
  deps: LinkedinBreakerDeps,
  state: LinkedinBreakerState,
): boolean {
  try {
    deps.mkdirSync(userDataDir);
    deps.writeFileSync(linkedinBreakerPath(userDataDir), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Opens (or re-opens) the breaker: `openedAt = now`, `tripCount`
 * incremented off `prev`. Returns false on a failed write — the caller logs
 * a warning and continues (D12). */
export function openBreaker(
  userDataDir: string,
  deps: LinkedinBreakerDeps,
  prev?: LinkedinBreakerState,
): boolean {
  const next: LinkedinBreakerState = {
    openedAt: deps.now().toISOString(),
    tripCount: (prev?.tripCount ?? 0) + 1,
  };
  // Preserved rather than dropped: a re-open following a failed half-open
  // probe should not erase the record of that probe.
  if (prev?.lastProbeAt !== undefined) next.lastProbeAt = prev.lastProbeAt;
  return writeState(userDataDir, deps, next);
}

/** Stamps `lastProbeAt = now` on an EXISTING open state, leaving
 * `openedAt`/`tripCount` untouched. With no prior state there is nothing to
 * stamp and this writes nothing: inventing an `openedAt` here would open a
 * breaker that a probe was only meant to observe. */
export function recordProbe(
  userDataDir: string,
  deps: LinkedinBreakerDeps,
  prev?: LinkedinBreakerState,
): boolean {
  if (!prev) return false;
  return writeState(userDataDir, deps, {
    openedAt: prev.openedAt,
    tripCount: prev.tripCount,
    lastProbeAt: deps.now().toISOString(),
  });
}

/** Closes the breaker by deleting the file — the absence of the file IS
 * the closed state. Every failure (ENOENT included) is swallowed. */
export function closeBreaker(userDataDir: string, deps: LinkedinBreakerDeps): void {
  try {
    const path = linkedinBreakerPath(userDataDir);
    if (!deps.existsSync(path)) return;
    deps.unlinkSync(path);
  } catch {
    // Nothing to do: a breaker file we failed to delete simply gets
    // re-probed on the next fire past its cooldown.
  }
}

/** Real (non-test) deps — node:fs sync calls plus a real clock, mirroring
 * `defaultChromePidfileDeps()` in
 * `adapters/browser/cdp-chrome/ownership/pidfile.ts`. */
export function defaultLinkedinBreakerDeps(): LinkedinBreakerDeps {
  return {
    existsSync: (path) => existsSync(path),
    readFileSync: (path) => readFileSync(path, 'utf8'),
    writeFileSync: (path, data) => writeFileSync(path, data, 'utf8'),
    mkdirSync: (path) => {
      mkdirSync(path, { recursive: true });
    },
    unlinkSync: (path) => unlinkSync(path),
    now: () => new Date(),
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test src/adapters/lanes/linkedin/breaker_store.test.ts
```

Expected: PASS — 22 tests.

- [ ] **Step 5: Run the full gate**

```bash
npm run check
```

Expected: green. In particular `boundaries` must stay green — this file imports only `node:fs`/`node:path`, no other layer.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/lanes/linkedin/breaker_store.ts src/adapters/lanes/linkedin/breaker_store.test.ts
git commit -m "feat(linkedin): persist throttle breaker state beside the chrome pid file"
```

---

### Task 3: Pacing — 5–12s jitter, 20–45s between saved-search URLs

Slows a normal fire from ~10 min to ~25 min against an unchanged 90-min stage budget (D2). Nothing here knows about the breaker.

**Files:**
- Modify: `src/cli/wire.ts` (constants at lines 477–478; schema at 487–494; `resolveJitterRange` at 499–502; `buildLanes` call at 366–372; `buildLinkedInLane` at 387–431)
- Test: `src/cli/wire.test.ts` (the `resolveJitterRange` block, lines 107–143)
- Modify: `src/adapters/lanes/linkedin/lane.ts` (constants near line 54; constructor at 248–273; `jitter` at 279–283; url loop at 370–375)
- Test: `src/adapters/lanes/linkedin/lane.test.ts` (append after the existing jitter block, which ends ~line 1890)
- Modify: `src/pipeline/stages/farm.ts` (the `TIMEOUT_MS` doc comment, lines 12–19 — **comment only; the value stays 5_400_000**)

**Interfaces:**
- Consumes: the lane's existing `jitterMs(minMs, maxMs, rand?)` (exported from `lane.ts`), its private `sleepFn: (ms: number, signal: AbortSignal) => Promise<void>` and `randomFn: () => number` constructor params (positions 9 and 10).
- Produces:
  - `lane.ts`: two new module-private constants `DEFAULT_INTER_URL_DELAY_MIN_MS = 0` / `DEFAULT_INTER_URL_DELAY_MAX_MS = 0`, two new constructor params appended **after `sleepFn`** — position 11 `interUrlDelayMinMs: number`, position 12 `interUrlDelayMaxMs: number` — and a private `interUrlPause(ctx: RunContext): Promise<void>`.
  - `wire.ts`: `DEFAULT_JITTER_MIN_MS = 5_000`, `DEFAULT_JITTER_MAX_MS = 12_000`, `DEFAULT_INTER_URL_DELAY_MIN_MS = 20_000`, `DEFAULT_INTER_URL_DELAY_MAX_MS = 45_000`; the module-private schema renamed `JitterSettingsSchema` → `LinkedinPacingSettingsSchema` and extended with `interUrlDelayMinMs`/`interUrlDelayMaxMs`; unchanged export `resolveJitterRange(settings: unknown): { minMs: number; maxMs: number }`; **new** export `resolveInterUrlDelayRange(settings: unknown): { minMs: number; maxMs: number }`; `buildLinkedInLane` gains a 4th parameter `interUrlDelayRange: { minMs: number; maxMs: number }`.

- [ ] **Step 1: Write the failing lane pacing tests**

Append to `src/adapters/lanes/linkedin/lane.test.ts`, immediately after the existing test `'jitter: an already-aborted ctx.signal makes the (real, default) jitter reject immediately — the run fails fast rather than hanging for seconds'` (ends ~line 1890, just before the `// ---------- parseSearchUrls ----------` divider). All helpers used below (`singlePageInventory`, `newScript`, `FakeBrowserProvider`, `FakeStorage`, `fakeCtx`, `fixtureFilterConfig`, `spySleepFn`, `URL_1`, `URL_2`, `RESUME_STATE_PATH`, `LinkedInLane`) already exist in this file — do not redefine them.

```typescript
// ---------- inter-url pacing (throttle guard D2, 2026-07-28) ----------

const URL_3 =
  'https://www.linkedin.com/jobs/search/?keywords=Principal+Frontend+Engineer&f_TPR=r86400&sortBy=R';

/** Seeds one url with a single gate-passing card whose JD opens cleanly —
 * just enough for the url loop to complete an iteration and move on. */
function seedTrivialUrl(script: Script, url: string, jobId: string): void {
  script.harvestByUrl.set(url, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: `/jobs/view/${jobId}/`,
    },
  ]);
  script.jdTextByUrl.set(
    `https://www.linkedin.com/jobs/view/${jobId}/`,
    `JD text — ${jobId}`,
  );
}

test('inter-url pause: 3 attempted urls produce exactly 2 pauses, each the configured midpoint', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3001');
  seedTrivialUrl(script, URL_2, '3002');
  seedTrivialUrl(script, URL_3, '3003');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2, URL_3] }],
    fixtureFilterConfig(),
    storage,
    undefined, // maxCardsPerUrl: default
    0, // jitterMinMs — jitter OFF, so every recorded sleep is an inter-url pause
    0, // jitterMaxMs
    () => 0.5, // randomFn: deterministic midpoint
    spySleepFn(sleepCalls),
    20_000, // interUrlDelayMinMs
    45_000, // interUrlDelayMaxMs
  );

  await lane.source(fakeCtx());

  // Never before the first url, never after the last: N - 1 pauses.
  assert.equal(sleepCalls.length, 2);
  for (const ms of sleepCalls) {
    assert.equal(ms, 20_000 + Math.floor(0.5 * (45_000 - 20_000)));
    assert.ok(ms >= 20_000 && ms < 45_000);
  }
});

test('inter-url pause: a single url produces zero pauses', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3101');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 0);
});

test('inter-url pause: a zero-length range is a no-op — the sleepFn is never called', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3201');
  seedTrivialUrl(script, URL_2, '3202');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    0, // interUrlDelayMinMs
    0, // interUrlDelayMaxMs
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 0);
});

test('inter-url pause: a url skipped as already-done costs no pause — only attempted urls are paced', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3301');
  seedTrivialUrl(script, URL_2, '3302');
  seedTrivialUrl(script, URL_3, '3303');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  // The MIDDLE url was already captured by an earlier fire today, so this
  // fire attempts URL_1 and URL_3 only — 2 attempts, 1 pause between them.
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_2]: 1 } });
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2, URL_3] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 1);
});

test('inter-url pause: pauses between urls that live in DIFFERENT page groups too', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3401');
  seedTrivialUrl(script, URL_2, '3402');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    // Two groups of one url each, both resolving to the same inventory.
    [
      { page: inv.page, urls: [URL_1] },
      { page: inv.page, urls: [URL_2] },
    ],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 1);
});
```

- [ ] **Step 2: Run the lane tests and watch them fail**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: FAIL — every new test reports `sleepCalls.length` of 0 where 2 (or 1) was expected, because the two extra constructor arguments are currently ignored (TypeScript also errors: `Expected 0-10 arguments, but got 12` under `npm run typecheck`).

- [ ] **Step 3: Implement the inter-URL pause in `lane.ts`**

3a. Add the constants immediately after `DEFAULT_JITTER_MAX_MS` (line 55):

```typescript
/** Randomized pause BETWEEN saved-search urls (throttle guard D2,
 * 2026-07-28). Same no-op-by-default posture as the jitter constants
 * directly above: `(0, 0)` here so every pre-existing `new LinkedInLane(...)`
 * call site keeps its original speed, with the real production range
 * (20_000, 45_000) applied once at wiring time by
 * `resolveInterUrlDelayRange` in `cli/wire.ts`. */
const DEFAULT_INTER_URL_DELAY_MIN_MS = 0;
const DEFAULT_INTER_URL_DELAY_MAX_MS = 0;
```

3b. Add two fields next to the jitter fields (after line 246's `sleepFn` declaration):

```typescript
  private readonly interUrlDelayMinMs: number;
  private readonly interUrlDelayMaxMs: number;
```

3c. Append two parameters to the constructor, **after `sleepFn`** (line 261), and assign them:

```typescript
    sleepFn: (ms: number, signal: AbortSignal) => Promise<void> = sleep,
    // Appended after sleepFn (rather than beside the jitter pair) so every
    // existing positional call site — this file's whole test suite —
    // compiles unchanged.
    interUrlDelayMinMs: number = DEFAULT_INTER_URL_DELAY_MIN_MS,
    interUrlDelayMaxMs: number = DEFAULT_INTER_URL_DELAY_MAX_MS,
  ) {
```

and in the body, after `this.sleepFn = sleepFn;`:

```typescript
    this.interUrlDelayMinMs = interUrlDelayMinMs;
    this.interUrlDelayMaxMs = interUrlDelayMaxMs;
```

3d. Add the pause helper immediately after the existing private `jitter` method (ends line 283):

```typescript
  /** Randomized pause between saved-search urls (D2). Distinct from
   * `jitter`, which paces individual navigations inside one url: this is
   * the gap that stops 21 saved searches from arriving as one burst, the
   * pattern that most likely provoked the 2026-07-28 soft block. Shares
   * `jitterMs` + `sleepFn` + `randomFn` with jitter, so it is abort-aware
   * for free and a zero-length range is a no-op. */
  private async interUrlPause(ctx: RunContext): Promise<void> {
    const ms = jitterMs(
      this.interUrlDelayMinMs,
      this.interUrlDelayMaxMs,
      this.randomFn,
    );
    if (ms <= 0) return;
    await this.sleepFn(ms, ctx.signal);
  }
```

3e. Declare the tracking flag immediately before the group loop (line 356's `for (const group of this.urls) {`) — **outside** it, so the pause also applies between urls in different groups:

```typescript
    // True once this run has actually attempted a url. Gates the inter-url
    // pause so it never fires before the first attempt, and — because it is
    // declared outside the group loop — still fires across a group boundary.
    let attemptedAnyUrl = false;
```

3f. Insert the pause in the url loop, immediately after the `shouldSkip` short-circuit (lines 371–374) and before `const stat: UrlStat = {`:

```typescript
          if (resumeState.shouldSkip(url)) {
            ctx.logger.info('linkedin lane: skipping already-done url', { url });
            continue;
          }

          // Placed AFTER the skip check on purpose: a url this fire never
          // touches must not cost 20-45s of wall clock. Deliberately outside
          // the per-url try/catch below — the only way sleepFn rejects is an
          // aborted ctx.signal, which must propagate loud (the run is over),
          // not be recorded as this url's SoftError.
          if (attemptedAnyUrl) await this.interUrlPause(ctx);
          attemptedAnyUrl = true;
```

- [ ] **Step 4: Run the lane tests and watch them pass**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: PASS, including all pre-existing tests (they pass no 11th/12th argument, so the range defaults to `(0, 0)` and no new sleep occurs).

- [ ] **Step 5: Write the failing wire tests**

In `src/cli/wire.test.ts`, replace the whole `resolveJitterRange` block (lines 107–143) with:

```typescript
// --- linkedin pacing settings (throttle guard D2/D3, 2026-07-28) ---

test('resolveJitterRange: defaults to the throttle-guard range (5000, 12000) when settings has no jitter keys', () => {
  assert.deepEqual(resolveJitterRange(undefined), { minMs: 5_000, maxMs: 12_000 });
  assert.deepEqual(resolveJitterRange({}), { minMs: 5_000, maxMs: 12_000 });
  assert.deepEqual(resolveJitterRange(null), { minMs: 5_000, maxMs: 12_000 });
});

test('resolveJitterRange: honors a configured valid range, including one-sided overrides', () => {
  assert.deepEqual(resolveJitterRange({ jitterMinMs: 500, jitterMaxMs: 1_500 }), {
    minMs: 500,
    maxMs: 1_500,
  });
  // Only jitterMinMs overridden — jitterMaxMs still defaults to 12000, and
  // 1000 <= 12000 so this is still a valid range.
  assert.deepEqual(resolveJitterRange({ jitterMinMs: 1_000 }), {
    minMs: 1_000,
    maxMs: 12_000,
  });
  // A zero-length range (both 0) is valid — the "no jitter" case.
  assert.deepEqual(resolveJitterRange({ jitterMinMs: 0, jitterMaxMs: 0 }), {
    minMs: 0,
    maxMs: 0,
  });
});

test('resolveJitterRange: fails LOUD (throws) when jitterMinMs > jitterMaxMs', () => {
  assert.throws(() => resolveJitterRange({ jitterMinMs: 5_000, jitterMaxMs: 2_000 }));
  // Same failure via the one-sided override: default jitterMinMs (5000)
  // now exceeds the configured jitterMaxMs.
  assert.throws(() => resolveJitterRange({ jitterMaxMs: 1_000 }));
});

test('resolveJitterRange: fails LOUD (throws) on a negative jitterMinMs or jitterMaxMs', () => {
  assert.throws(() => resolveJitterRange({ jitterMinMs: -1, jitterMaxMs: 5_000 }));
  assert.throws(() => resolveJitterRange({ jitterMinMs: 2_000, jitterMaxMs: -1 }));
});

test('resolveInterUrlDelayRange: defaults to (20000, 45000) when settings has no inter-url keys', () => {
  assert.deepEqual(resolveInterUrlDelayRange(undefined), {
    minMs: 20_000,
    maxMs: 45_000,
  });
  assert.deepEqual(resolveInterUrlDelayRange({}), { minMs: 20_000, maxMs: 45_000 });
  assert.deepEqual(resolveInterUrlDelayRange(null), { minMs: 20_000, maxMs: 45_000 });
});

test('resolveInterUrlDelayRange: honors a configured valid range and a zero-length one', () => {
  assert.deepEqual(
    resolveInterUrlDelayRange({ interUrlDelayMinMs: 1_000, interUrlDelayMaxMs: 2_000 }),
    { minMs: 1_000, maxMs: 2_000 },
  );
  assert.deepEqual(
    resolveInterUrlDelayRange({ interUrlDelayMinMs: 0, interUrlDelayMaxMs: 0 }),
    { minMs: 0, maxMs: 0 },
  );
});

test('resolveInterUrlDelayRange: fails LOUD on an inverted or negative range', () => {
  assert.throws(() =>
    resolveInterUrlDelayRange({ interUrlDelayMinMs: 45_000, interUrlDelayMaxMs: 20_000 }),
  );
  assert.throws(() => resolveInterUrlDelayRange({ interUrlDelayMinMs: -1 }));
});

test('both resolvers parse the SAME settings blob, so an invalid jitter range throws out of either entry point', () => {
  // Deliberate (D3): one schema validates both pairs, so a profile cannot
  // end up with a valid inter-url range quietly sitting next to an
  // inverted jitter one just because the caller only read the other pair.
  assert.throws(() =>
    resolveInterUrlDelayRange({ jitterMinMs: 9_000, jitterMaxMs: 1_000 }),
  );
});
```

Extend the import at `src/cli/wire.test.ts` line 16 to include the new resolver, e.g.:

```typescript
  resolveInterUrlDelayRange,
  resolveJitterRange,
```

- [ ] **Step 6: Run the wire tests and watch them fail**

```bash
node --test src/cli/wire.test.ts
```

Expected: FAIL — `does not provide an export named 'resolveInterUrlDelayRange'`.

- [ ] **Step 7: Implement the wire changes**

7a. Replace the jitter defaults block (`src/cli/wire.ts` lines 471–478) with:

```typescript
/** Live pacing defaults for the linkedin lane (throttle guard D2/D3,
 * 2026-07-28). Raised from the old v0-parity (2000, 5000) after LinkedIn
 * soft-throttled the shared `.chrome-debug` session under that cadence: 21
 * saved-search urls x 5 fires/day at ~1 navigation per 12s read as a burst.
 * Kept here (not just in the lane) so a profile with no `settings.linkedin`
 * pacing keys at all still gets a fully-populated, schema-validated range —
 * the lane's own defaults stay a no-op `(0, 0)` for tests. */
const DEFAULT_JITTER_MIN_MS = 5_000;
const DEFAULT_JITTER_MAX_MS = 12_000;

/** Pause between saved-search urls (D2). Together with the jitter above
 * this puts a 21-url fire at roughly 25 minutes against farm's unchanged
 * 90-minute ceiling — deliberately the moderate tier, since the
 * conservative one (~50 min) would eventually force raising that ceiling. */
const DEFAULT_INTER_URL_DELAY_MIN_MS = 20_000;
const DEFAULT_INTER_URL_DELAY_MAX_MS = 45_000;
```

7b. Replace the schema and resolver (`src/cli/wire.ts` lines 480–502) with:

```typescript
/** Unlike `resolveMaxCardsPerUrl`/`resolveInventoryMaxAgeDays` (silently
 * fall back to a default on any bad value), an operator-set pacing range
 * that doesn't make sense (min > max, or either negative) is a
 * config-authoring mistake, not "value absent" — fail LOUD (zod throws),
 * same posture as `NotionConnectorSettingsSchema.parse`/
 * `TelegramNotifierSettingsSchema.parse` above. Missing keys still default
 * quietly, only a present-but-invalid value throws.
 *
 * Both pacing pairs share one schema (D3): they are read from the same
 * `settings.linkedin` blob and validated together, so a profile cannot end
 * up with a valid inter-url range sitting next to an inverted jitter one. */
const LinkedinPacingSettingsSchema = z
  .object({
    jitterMinMs: z.number().min(0).default(DEFAULT_JITTER_MIN_MS),
    jitterMaxMs: z.number().min(0).default(DEFAULT_JITTER_MAX_MS),
    interUrlDelayMinMs: z.number().min(0).default(DEFAULT_INTER_URL_DELAY_MIN_MS),
    interUrlDelayMaxMs: z.number().min(0).default(DEFAULT_INTER_URL_DELAY_MAX_MS),
  })
  .refine((v) => v.jitterMinMs <= v.jitterMaxMs, {
    message: 'settings.linkedin.jitterMinMs must be <= settings.linkedin.jitterMaxMs',
  })
  .refine((v) => v.interUrlDelayMinMs <= v.interUrlDelayMaxMs, {
    message:
      'settings.linkedin.interUrlDelayMinMs must be <= settings.linkedin.interUrlDelayMaxMs',
  });

/** Parses `settings.linkedin`'s `jitterMinMs`/`jitterMaxMs` pair — throws
 * (fail loud) on a negative value or `jitterMinMs > jitterMaxMs`; missing
 * settings (`undefined`/`{}`) fall back to the throttle-guard defaults. */
export function resolveJitterRange(settings: unknown): { minMs: number; maxMs: number } {
  const parsed = LinkedinPacingSettingsSchema.parse(settings ?? {});
  return { minMs: parsed.jitterMinMs, maxMs: parsed.jitterMaxMs };
}

/** Parses `settings.linkedin`'s `interUrlDelayMinMs`/`interUrlDelayMaxMs`
 * pair — same fail-loud posture and same schema as `resolveJitterRange`. */
export function resolveInterUrlDelayRange(settings: unknown): {
  minMs: number;
  maxMs: number;
} {
  const parsed = LinkedinPacingSettingsSchema.parse(settings ?? {});
  return { minMs: parsed.interUrlDelayMinMs, maxMs: parsed.interUrlDelayMaxMs };
}
```

7c. Pass the new range through `buildLanes` (`src/cli/wire.ts` lines 366–372):

```typescript
      case 'linkedin':
        lanes.push(
          await buildLinkedInLane(
            deps,
            resolveMaxCardsPerUrl(config.settings.linkedin),
            resolveJitterRange(config.settings.linkedin),
            resolveInterUrlDelayRange(config.settings.linkedin),
          ),
        );
        break;
```

7d. Widen `buildLinkedInLane`'s signature (line 387) and its `new LinkedInLane(...)` call (lines 421–430):

```typescript
async function buildLinkedInLane(
  deps: LiveLaneDeps,
  maxCardsPerUrl: number,
  jitterRange: { minMs: number; maxMs: number },
  interUrlDelayRange: { minMs: number; maxMs: number },
): Promise<LinkedInLane> {
```

```typescript
  return new LinkedInLane(
    deps.browser,
    inventories,
    urls,
    deps.filterCfg,
    deps.profileStorage,
    maxCardsPerUrl,
    jitterRange.minMs,
    jitterRange.maxMs,
    undefined, // randomFn: real Math.random
    undefined, // sleepFn: real abort-aware core/async sleep
    interUrlDelayRange.minMs,
    interUrlDelayRange.maxMs,
  );
```

- [ ] **Step 8: Run the wire tests and watch them pass**

```bash
node --test src/cli/wire.test.ts
```

Expected: PASS.

- [ ] **Step 9: Update farm's timeout doc comment (comment only)**

In `src/pipeline/stages/farm.ts`, replace the `TIMEOUT_MS` doc comment (lines 12–19) with the text below. **`const TIMEOUT_MS = 5_400_000;` on line 20 stays exactly as it is** — raising it is an explicit spec non-goal (D2).

```typescript
/** 90-minute ceiling over a browser-driven farming run. LinkedIn navigation is
 * slower than API-only staging (source.ts's 300s). The LinkedIn lane adds 5–12s
 * jitter per JD open and per URL navigation, plus a 20–45s pause between
 * saved-search URLs (throttle guard, 2026-07-28 — LinkedIn soft-blocked the
 * shared session under the previous 2–5s cadence). That puts a typical 21-URL
 * fire at roughly 25 minutes, still ~3.5x inside this ceiling, so the value
 * below is deliberately UNCHANGED by that pacing work. Each FarmingLane owns its
 * own bounded per-URL/per-card timeouts internally (adapters/lanes/linkedin), so
 * this is a stage ceiling, not a per-URL budget. This is a ceiling, not typical
 * runtime: real card counts drop well below maxCardsPerUrl (40) via title/avoid
 * card-gating and Notion-cache skips. */
```

- [ ] **Step 10: Run the full gate**

```bash
npm run check
```

Expected: green.

- [ ] **Step 11: Commit**

```bash
git add src/adapters/lanes/linkedin/lane.ts src/adapters/lanes/linkedin/lane.test.ts src/cli/wire.ts src/cli/wire.test.ts src/pipeline/stages/farm.ts
git commit -m "feat(linkedin): pace a fire with 5-12s jitter and a 20-45s inter-url pause"
```

---

### Task 4: A skipped lane is not an outage

One change in `farm`, so that a lane which deliberately attempted nothing cannot trip the "every lane failed" rule (D10). Without this, Task 5's whole open-breaker path converts a healthy degradation into a run failure.

**Files:**
- Modify: `src/ports/lane.ts` (the `FarmingLane` interface, lines 14–22)
- Modify: `src/pipeline/stages/farm.ts` (the lane loop, lines 70–114)
- Test: `src/pipeline/stages/farm.test.ts`

**Interfaces:**
- Consumes: `makeFarmStage(farmingLanes: FarmingLane[]): StageDef<StagePayload, StagePayload>` (unchanged signature).
- Produces: `FarmingLane.source(ctx: RunContext)` now resolves to
  `{ jobs: JD[]; dropped: DroppedRecord[]; companiesSeen: string[]; skipped?: { reason: string } }`.
  The property is **optional**, so `adapters/lanes/greenhouse`, `adapters/lanes/keka`, and every existing fake stay valid without edits. Task 5 is the only producer of a non-`undefined` `skipped`.

- [ ] **Step 1: Write the failing farm tests**

In `src/pipeline/stages/farm.test.ts`, first let `fakeCtx` capture `info` logs the way it already captures `warn` (lines 28–44) — replace its `overrides` type and its `logger` literal:

```typescript
function fakeCtx(
  storage: ReturnType<typeof fakeStorage>,
  overrides?: {
    signal?: AbortSignal;
    warn?: (msg: string, data?: unknown) => void;
    info?: (msg: string, data?: unknown) => void;
  },
): StageContext {
  return {
    profile: 'rajni',
    signal: overrides?.signal ?? AbortSignal.timeout(30_000),
    logger: {
      debug() {},
      info: overrides?.info ?? (() => {}),
      warn: overrides?.warn ?? (() => {}),
      error() {},
    },
    beat() {},
    storage,
  };
}
```

Then extend `makeFakeLane`'s options (lines 70–89) so a fake can report a skip:

```typescript
function makeFakeLane(opts: {
  name: string;
  jobs?: ReturnType<typeof fakeJob>[];
  dropped?: ReturnType<typeof fakeDropped>[];
  companiesSeen?: string[];
  throwErr?: Error;
  skipped?: { reason: string };
}): FarmingLane {
  return {
    kind: 'farming',
    name: opts.name,
    async source() {
      if (opts.throwErr) throw opts.throwErr;
      return {
        jobs: (opts.jobs ?? []) as never,
        dropped: (opts.dropped ?? []) as never,
        companiesSeen: opts.companiesSeen ?? [],
        ...(opts.skipped ? { skipped: opts.skipped } : {}),
      };
    },
  };
}
```

Then append these tests to the end of the file:

```typescript
// --- skipped lanes (throttle guard D10, 2026-07-28) ---

test('the only lane skipping does NOT trip the total-outage throw — the stage completes and companies_seen is still written', async () => {
  const storage = fakeStorage();
  const infos: Array<{ msg: string; data?: unknown }> = [];
  const lane = makeFakeLane({
    name: 'linkedin',
    skipped: { reason: 'throttle cooldown until 2026-07-28T18:42:00.000Z' },
  });

  const stage = makeFarmStage([lane]);
  const ctx = fakeCtx(storage, {
    info: (msg, data) => {
      infos.push({ msg, data });
    },
  });

  const out = await stage.run(emptyPayload(), ctx);

  assert.deepEqual(out.jobs, []);
  assert.ok(infos.some((i) => i.msg === 'farming lane skipped'));
  assert.deepEqual(
    infos.find((i) => i.msg === 'farming lane skipped')?.data,
    {
      lane: 'linkedin',
      reason: 'throttle cooldown until 2026-07-28T18:42:00.000Z',
    },
  );
  // Written, and the skipped lane contributes no entry to it.
  assert.deepEqual(storage.store.get('registry/companies_seen.json'), {});
});

test('one lane skipped + one lane failing IS a total outage — every lane that attempted work failed', async () => {
  const storage = fakeStorage();
  const skippedLane = makeFakeLane({
    name: 'linkedin',
    skipped: { reason: 'throttle cooldown until 18:42' },
  });
  const brokenLane = makeFakeLane({
    name: 'linkedin-secondary',
    throwErr: new Error('all attempted URLs failed — logout shape'),
  });

  const stage = makeFarmStage([skippedLane, brokenLane]);

  await assert.rejects(
    () => stage.run(emptyPayload(), fakeCtx(storage)),
    /all 1 farming lane\(s\) failed/,
  );
  assert.equal(storage.store.has('registry/companies_seen.json'), false);
});

test('one lane skipped + one lane succeeding does not throw and keeps the healthy lane s results', async () => {
  const storage = fakeStorage();
  const skippedLane = makeFakeLane({
    name: 'linkedin',
    skipped: { reason: 'throttle cooldown until 18:42' },
  });
  const healthyLane = makeFakeLane({
    name: 'linkedin-secondary',
    jobs: [fakeJob('li-7', 'linkedin-secondary', 'Reliable Co')],
    companiesSeen: ['Reliable Co'],
  });

  const stage = makeFarmStage([skippedLane, healthyLane]);
  const out = await stage.run(emptyPayload(), fakeCtx(storage));

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['li-7'],
  );
  assert.deepEqual(storage.store.get('registry/companies_seen.json'), {
    'linkedin-secondary': ['Reliable Co'],
  });
});

test('every lane skipping does not throw — nothing attempted means nothing failed', async () => {
  const storage = fakeStorage();
  const stage = makeFarmStage([
    makeFakeLane({ name: 'linkedin', skipped: { reason: 'throttle cooldown' } }),
    makeFakeLane({ name: 'linkedin-secondary', skipped: { reason: 'throttle cooldown' } }),
  ]);

  const out = await stage.run(emptyPayload(), fakeCtx(storage));

  assert.deepEqual(out.jobs, []);
  assert.deepEqual(storage.store.get('registry/companies_seen.json'), {});
});

test('a skipped lane s own jobs/dropped/companiesSeen are ignored — skipped means it contributed nothing', async () => {
  const storage = fakeStorage();
  const lane = makeFakeLane({
    name: 'linkedin',
    jobs: [fakeJob('li-ghost', 'linkedin', 'Ghost Co')],
    dropped: [fakeDropped('li-ghost-dropped')],
    companiesSeen: ['Ghost Co'],
    skipped: { reason: 'throttle cooldown' },
  });

  const stage = makeFarmStage([lane]);
  const out = await stage.run(emptyPayload(), fakeCtx(storage));

  assert.deepEqual(out.jobs, []);
  assert.deepEqual(out.dropped, []);
  assert.deepEqual(storage.store.get('registry/companies_seen.json'), {});
});
```

- [ ] **Step 2: Run the farm tests and watch them fail**

```bash
node --test src/pipeline/stages/farm.test.ts
```

Expected: FAIL — the first new test rejects with `all 1 farming lane(s) failed` is not thrown but `farming lane skipped` was never logged; more precisely the first assertion to fail is `infos.some((i) => i.msg === 'farming lane skipped')`. `npm run typecheck` additionally errors on `skipped` not existing in `FarmingLane.source`'s return type.

- [ ] **Step 3: Extend the port**

Replace `src/ports/lane.ts`'s `FarmingLane` (lines 9–22) with:

```typescript
/** Browser-driven sourcing. The card gate (filter evaluateCard) runs
 * inside the lane BEFORE a JD is opened — token/browser economy, spec §4.
 * `dropped` carries every card-gate drop (identity-only JD + verdicts) so
 * the funnel can always answer "why did this job disappear?" — a lane
 * must never silently swallow them.
 *
 * `skipped` is how a lane says "I deliberately attempted nothing, and
 * here is why" (throttle guard D10, 2026-07-28). It is NOT a failure and
 * NOT an empty success: the `farm` stage excludes a skipped lane from its
 * every-attempted-lane-failed computation, so a deliberate skip cannot
 * convert a healthy degradation into a loud run failure. A lane that
 * skips must return empty `jobs`/`dropped`/`companiesSeen` alongside it —
 * the stage ignores those fields when `skipped` is set. */
export interface FarmingLane {
  readonly kind: 'farming';
  readonly name: string;
  source(ctx: RunContext): Promise<{
    jobs: JD[];
    dropped: DroppedRecord[];
    companiesSeen: string[];
    skipped?: { reason: string };
  }>;
}
```

- [ ] **Step 4: Implement the farm change**

In `src/pipeline/stages/farm.ts`, replace the lane loop and the aggregate guard (lines 71–114) with:

```typescript
      const farmedJobs: JD[] = [];
      const farmedDropped: DroppedRecord[] = [];
      const seen: Record<string, string[]> = {};
      let failedLanes = 0;
      let skippedLanes = 0;

      for (const lane of farmingLanes) {
        try {
          const result = await lane.source(ctx);
          if (result.skipped) {
            // Deliberately attempted nothing (e.g. the LinkedIn lane
            // sitting out a throttle cooldown). Not a failure, not an
            // empty success: it contributes no companies_seen entry and
            // is excluded from the outage denominator below.
            skippedLanes += 1;
            ctx.logger.info('farming lane skipped', {
              lane: lane.name,
              reason: result.skipped.reason,
            });
            continue;
          }
          farmedJobs.push(...result.jobs);
          farmedDropped.push(...result.dropped);
          seen[lane.name] = result.companiesSeen;
        } catch (err) {
          if (ctx.signal.aborted) throw err; // run-level abort: propagate, no side-write
          // Whole-lane outage: never let one lane's total failure stop the others.
          failedLanes += 1;
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn('farming lane failed entirely', {
            lane: lane.name,
            error: message,
          });
        }
      }

      // Every farming lane that ATTEMPTED work failed: not one broken lane,
      // a total outage — fail loud rather than a silently-green zero-job run
      // (mirrors linkedin/lane.ts's all-urls-failed guard, v0
      // checkAggregateFailure). Skipped lanes are excluded from the
      // denominator (D10): a lane that never touched the network cannot be
      // evidence of an outage, and counting it would turn a deliberate
      // throttle cooldown into a failed run — the exact opposite of the
      // graceful degradation the skip exists to provide.
      //
      // Known, accepted cost (2026-07-26 review): LinkedIn is currently
      // the ONLY farming lane, so this throw aborts the whole 10-stage run
      // at stage 2 and the healthy Greenhouse/Keka lanes never run that
      // day — an expired login pauses ATS sourcing until it's fixed.
      // Deliberately kept: the abort is what makes the outage loud (the
      // runner's failure digest fires), and downgrading it to a warn
      // inside a green run would bury the expired-login signal — exactly
      // what CLAUDE.md's fail-loud-on-total-outage invariant forbids.
      // Letting ATS lanes still run would need a real "degraded run"
      // status flowing through result.json into both digests — a feature,
      // not a tweak to this condition.
      const attemptedLanes = farmingLanes.length - skippedLanes;
      if (attemptedLanes > 0 && failedLanes === attemptedLanes) {
        throw new Error(
          `farm stage: all ${attemptedLanes} farming lane(s) failed this run — ` +
            'total outage, not one broken lane',
        );
      }
```

- [ ] **Step 5: Run the farm tests and watch them pass**

```bash
node --test src/pipeline/stages/farm.test.ts
```

Expected: PASS, including the pre-existing `'all lanes throwing: stage throws loud, no companies_seen write'` (2 lanes, 0 skipped ⇒ `attemptedLanes === 2`, so its `/all 2 farming lane\(s\) failed/` assertion still matches).

- [ ] **Step 6: Run the full gate**

```bash
npm run check
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/ports/lane.ts src/pipeline/stages/farm.ts src/pipeline/stages/farm.test.ts
git commit -m "feat(farm): exclude a skipped lane from the total-outage denominator"
```

---

### Task 5: Lane integration — open, half-open probe, and the mid-fire trip

Composes Tasks 1, 2 and 4 into the lane's `source()`. This is the task that actually stops pushing into a soft block.

**Files:**
- Modify: `src/adapters/lanes/linkedin/lane.ts`
- Modify: `src/adapters/lanes/linkedin/index.ts`
- Modify: `src/cli/wire.ts` (imports; `buildLinkedInLane`)
- Test: `src/adapters/lanes/linkedin/lane.test.ts`

**BOUNDARY CONSTRAINT — read before writing any import.** `DEFAULT_USER_DATA_DIR` lives in `src/adapters/browser/cdp-chrome/launcher.ts` (re-exported from that family's `index.ts`). `adapters/browser` and `adapters/lanes` are **different adapter families**, and `.dependency-cruiser.cjs`'s `adapters-no-cross-family` rule forbids `adapters/lanes/linkedin` importing it — `npm run boundaries` will fail if you try. `lane.ts` therefore takes the directory as a plain `string` and imports nothing from `adapters/browser/**`; `cli/wire.ts` (the one file allowed to import any adapter) reads the constant and passes it in. This is the same reason `core/async/sleep.ts` exists instead of the lane reusing the browser adapter's private backoff sleep.

**Interfaces:**
- Consumes:
  - Task 1: `buildJdRootPresenceScript(jdRootSelector: string): string` from `./jd_open.ts`; `type JdOutcome`, `THROTTLE_COOLDOWN_MS`, `ThrottleCounter` from `./throttle.ts`.
  - Task 2: `type LinkedinBreakerDeps`, `type LinkedinBreakerState`, `breakerPhase`, `closeBreaker`, `defaultLinkedinBreakerDeps`, `openBreaker`, `readBreaker`, `recordProbe` from `./breaker_store.ts`.
  - Task 3: the lane constructor's params 11/12 (`interUrlDelayMinMs`, `interUrlDelayMaxMs`) — the new breaker param goes **after** them.
  - Task 4: `FarmingLane.source()`'s optional `skipped?: { reason: string }`.
- Produces:
  - `export interface LinkedinBreakerConfig { userDataDir: string; deps: LinkedinBreakerDeps }` in `lane.ts`.
  - `LinkedInLane`'s constructor param 13: `breaker?: LinkedinBreakerConfig`. **Undefined disables the breaker entirely** — no read, no write, no classification, no extra `page.evaluate`. That keeps every one of the ~45 existing lane tests byte-identical in behavior and hermetic; only tests that opt in exercise the guard.
  - `src/adapters/lanes/linkedin/index.ts` re-exports `LinkedinBreakerConfig`, `LinkedinBreakerDeps`, `LinkedinBreakerState` and `defaultLinkedinBreakerDeps` so `wire.ts` can build the config through the module's public surface.

- [ ] **Step 1: Extend the lane test harness (fakes only, no assertions yet)**

In `src/adapters/lanes/linkedin/lane.test.ts`:

1a. Add to the imports at the top of the file:

```typescript
import type { LinkedinBreakerDeps, LinkedinBreakerState } from './breaker_store.ts';
```

1b. Add `jdShellUrls` to the `Script` interface (after `anchorOnlyUrls`, line ~131) and to `newScript()`:

```typescript
  /** JD urls where jdRoot IS present in the DOM but holds no text — the
   * server-withheld shell LinkedIn serves a soft-blocked session. Pair
   * with an absent `jdTextByUrl` entry so openJd fails AND the presence
   * probe reports '1'. */
  jdShellUrls: Set<string>;
```

```typescript
function newScript(): Script {
  return {
    gotoThrows: new Set(),
    waitForThrows: new Set(),
    harvestByUrl: new Map(),
    jdTextByUrl: new Map(),
    anchorOnlyUrls: new Set(),
    jdShellUrls: new Set(),
  };
}
```

1c. Route the presence script in `FakePage.evaluate` — insert this as the **first** branch of the method (before the `cardListSel` check, line ~163):

```typescript
    // buildJdRootPresenceScript's source carries a stable `jd-root-presence`
    // marker, the same routing trick the harvest branch below uses with
    // `cardListSel`. It answers "did jdRoot match anything", independent of
    // whether jdTextByUrl has text for this url.
    if (fn.includes('jd-root-presence')) {
      return (this.script.jdShellUrls.has(this.lastUrl) ? '1' : '') as unknown as T;
    }
```

1d. Add the fake breaker filesystem near the other fakes (e.g. just after `FakeBrowserProvider`, line ~262):

```typescript
const BREAKER_DIR = '/repo/.chrome-debug';

/** In-memory stand-in for the breaker file plus a frozen clock. The lane
 * only ever sees LinkedinBreakerDeps, so nothing here touches a real fs. */
function fakeBreakerFs(initial: LinkedinBreakerState | undefined, now: Date) {
  const disk: { raw: string | undefined } = {
    raw: initial === undefined ? undefined : JSON.stringify(initial),
  };
  const writes: string[] = [];
  const unlinks: string[] = [];
  const deps: LinkedinBreakerDeps = {
    existsSync: () => disk.raw !== undefined,
    readFileSync: () => {
      if (disk.raw === undefined) throw new Error('ENOENT: no breaker file');
      return disk.raw;
    },
    writeFileSync: (_path, data) => {
      disk.raw = data;
      writes.push(data);
    },
    mkdirSync: () => {},
    unlinkSync: (path) => {
      disk.raw = undefined;
      unlinks.push(path);
    },
    now: () => now,
  };
  const current = (): LinkedinBreakerState | undefined =>
    disk.raw === undefined ? undefined : (JSON.parse(disk.raw) as LinkedinBreakerState);
  return { deps, writes, unlinks, current };
}
```

- [ ] **Step 2: Write the failing breaker tests**

Append to `src/adapters/lanes/linkedin/lane.test.ts` (at the end of the file). These reuse helpers that already exist in the file — `singlePageInventory`, `newScript`, `seedHappyPathScript`, `FakeBrowserProvider`, `FakeStorage`, `fakeCtx`, `fixtureFilterConfig`, `spySleepFn`, `URL_1`, `URL_2`, `RESUME_STATE_PATH` — plus **`seedTrivialUrl`, which Task 3 added** to this same file, and `fakeBreakerFs`/`BREAKER_DIR` from Step 1d above. Do not redefine any of them.

```typescript
// ---------- throttle breaker (spec §4.5, D8/D9, 2026-07-28) ----------

const NOW = new Date('2026-07-28T12:00:00.000Z');
/** Opened 1h before NOW: inside the 4h cooldown ⇒ phase `open`. */
const OPENED_RECENTLY: LinkedinBreakerState = {
  openedAt: '2026-07-28T11:00:00.000Z',
  tripCount: 1,
};
/** Opened 6h before NOW: past the 4h cooldown ⇒ phase `half-open`. */
const OPENED_LONG_AGO: LinkedinBreakerState = {
  openedAt: '2026-07-28T06:00:00.000Z',
  tripCount: 1,
};

test('open breaker: the lane returns skipped with a reopen time and NEVER launches the browser (D9)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_RECENTLY, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.deepEqual(result.jobs, []);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.companiesSeen, []);
  assert.match(result.skipped?.reason ?? '', /throttle cooldown until/);
  // openedAt 11:00 + 4h cooldown = 15:00.
  assert.match(result.skipped?.reason ?? '', /2026-07-28T15:00:00\.000Z/);
  // The defining assertion of D9: a blocked fire leaves zero footprint.
  assert.equal(provider.handle, null);
  // And it changed nothing on "disk".
  assert.deepEqual(fs.writes, []);
  assert.deepEqual(fs.unlinks, []);
});

test('half-open: a probe returning real text deletes the breaker file and the fire proceeds normally', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.equal(result.skipped, undefined);
  assert.equal(fs.current(), undefined, 'breaker file must be deleted on recovery');
  assert.equal(fs.unlinks.length, 1);
  // The whole fire ran: the happy-path fixture's 4 JD-opens all landed.
  assert.equal(result.jobs.length, 4);
});

test('half-open: a probe returning a shell re-opens the breaker and ends the fire after ONE JD-open', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1's single card harvests fine, but its JD is a shell: no text
  // scripted, and jdRoot IS present.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/5001/',
    },
  ]);
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/5001/');
  seedTrivialUrl(script, URL_2, '5002');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.match(result.skipped?.reason ?? '', /still throttled/);
  assert.deepEqual(result.jobs, []);
  const state = fs.current();
  assert.equal(state?.openedAt, NOW.toISOString(), 'openedAt must be rewritten');
  assert.equal(state?.tripCount, 2);
  // ~2 requests spent: exactly one page was opened, and URL_2 was never
  // visited.
  assert.equal(provider.handle?.pages.length, 1);
  const gotos = provider.handle?.pages[0]?.gotoCalls ?? [];
  assert.equal(gotos.includes(URL_2), false);
});

test('half-open: a probe that THROWS leaves the breaker open with openedAt unchanged (spec §5)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // The probe url's navigation fails outright — inconclusive, not proof
  // that the block cleared.
  script.gotoThrows.add(URL_1);
  seedTrivialUrl(script, URL_2, '5102');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.match(result.skipped?.reason ?? '', /probe inconclusive/);
  const state = fs.current();
  assert.equal(state?.openedAt, OPENED_LONG_AGO.openedAt, 'openedAt must NOT move');
  assert.equal(state?.tripCount, 1, 'an inconclusive probe is not a trip');
  assert.equal(state?.lastProbeAt, NOW.toISOString());
  assert.deepEqual(fs.unlinks, [], 'a broken page must never close the breaker');
});

test('trip: 3 consecutive shells mid-fire open the breaker, stop the remaining urls, and KEEP prior captures (D6)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1: card 1 captures real text, cards 2-4 are shells. The third
  // shell trips the counter.
  script.harvestByUrl.set(URL_1, [
    { title: 'Frontend Engineer', company: 'Acme', location: 'Remote', href: '/jobs/view/6001/' },
    { title: 'Frontend Engineer', company: 'Globex', location: 'Remote', href: '/jobs/view/6002/' },
    { title: 'Frontend Engineer', company: 'Initech', location: 'Remote', href: '/jobs/view/6003/' },
    { title: 'Frontend Engineer', company: 'Umbrella', location: 'Remote', href: '/jobs/view/6004/' },
  ]);
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/6001/',
    'JD text — real, captured before the block',
  );
  for (const id of ['6002', '6003', '6004']) {
    script.jdShellUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '6100');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  // No file on disk ⇒ phase closed ⇒ the fire starts normally.
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  // Returns NORMALLY — it did attempt work (D6), so this is not `skipped`.
  assert.equal(result.skipped, undefined);
  assert.deepEqual(
    result.jobs.map((j) => j.identity.id),
    ['li-6001'],
  );
  const state = fs.current();
  assert.equal(state?.openedAt, NOW.toISOString());
  assert.equal(state?.tripCount, 1);
  // URL_2 was never visited: only ONE page was ever opened.
  assert.equal(provider.handle?.pages.length, 1);
  // The interrupted url is NOT marked done — the next fire must retry it.
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.equal(Object.hasOwn(persisted.done, URL_1), false);
});

test('trip: an ok between shells resets the streak — a mostly-healthy fire never trips', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    { title: 'Frontend Engineer', company: 'Acme', location: 'Remote', href: '/jobs/view/6201/' },
    { title: 'Frontend Engineer', company: 'Globex', location: 'Remote', href: '/jobs/view/6202/' },
    { title: 'Frontend Engineer', company: 'Initech', location: 'Remote', href: '/jobs/view/6203/' },
    { title: 'Frontend Engineer', company: 'Umbrella', location: 'Remote', href: '/jobs/view/6204/' },
  ]);
  // shell, shell, ok, shell -> longest streak 2, never trips.
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6201/');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6202/');
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/6203/', 'JD text — healthy');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6204/');
  seedTrivialUrl(script, URL_2, '6300');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.equal(fs.current(), undefined, 'breaker must stay closed');
  // Both urls were visited: 2 pages opened, and URL_2's job landed.
  assert.equal(provider.handle?.pages.length, 2);
  assert.ok(result.jobs.some((j) => j.identity.id === 'li-6300'));
});

test('no breaker configured: the lane never reads or writes breaker state (every legacy call site is unaffected)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    { title: 'Frontend Engineer', company: 'Acme', location: 'Remote', href: '/jobs/view/6401/' },
    { title: 'Frontend Engineer', company: 'Globex', location: 'Remote', href: '/jobs/view/6402/' },
    { title: 'Frontend Engineer', company: 'Initech', location: 'Remote', href: '/jobs/view/6403/' },
  ]);
  for (const id of ['6401', '6402', '6403']) {
    script.jdShellUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '6500');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  // 13th argument omitted entirely — the pre-throttle-guard call shape.
  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const result = await lane.source(fakeCtx());

  // Three shells in a row and yet URL_2 still got visited: with no breaker
  // configured there is no counter and no early stop.
  assert.equal(result.skipped, undefined);
  assert.equal(provider.handle?.pages.length, 2);
});
```

- [ ] **Step 3: Run the lane tests and watch them fail**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: FAIL — `npm run typecheck` reports `Expected 0-12 arguments, but got 13` for every new test, and at runtime the open-breaker test fails on `assert.match(result.skipped?.reason ?? '', /throttle cooldown until/)` because `skipped` is `undefined`.

- [ ] **Step 4: Wire the breaker into `lane.ts` — constructor and imports**

4a. Extend the imports at the top of `src/adapters/lanes/linkedin/lane.ts`. Note `BrowserHandle` is added to the existing browser-port import; **nothing from `adapters/browser/**` is imported.**

```typescript
import type {
  BrowserHandle,
  BrowserProvider,
  PageHandle,
} from '../../../ports/browser.ts';
```

```typescript
import type { LinkedinBreakerDeps, LinkedinBreakerState } from './breaker_store.ts';
import {
  breakerPhase,
  closeBreaker,
  openBreaker,
  readBreaker,
  recordProbe,
} from './breaker_store.ts';
import { openJd, buildJdRootPresenceScript } from './jd_open.ts';
import type { JdOutcome } from './throttle.ts';
import { THROTTLE_COOLDOWN_MS, ThrottleCounter } from './throttle.ts';
```

(The existing `import { openJd } from './jd_open.ts';` on line 18 is replaced by the combined form above; Biome will sort these on `npm run lint`.)

4b. Add the config type and the presence-probe timeout next to the other lane constants (after `DEFAULT_INTER_URL_DELAY_MAX_MS` from Task 3):

```typescript
/** Everything the lane needs to reach the session-scoped breaker file.
 *
 * `userDataDir` is a plain string, NOT an import of
 * `adapters/browser/cdp-chrome`'s `DEFAULT_USER_DATA_DIR`: those are two
 * different adapter families and `.dependency-cruiser.cjs`'s
 * `adapters-no-cross-family` rule forbids the cross-import. `cli/wire.ts`
 * — the one file allowed to import any adapter — reads the constant and
 * passes it in here.
 *
 * The whole config is OPTIONAL on the constructor: omitted, the lane has
 * no breaker at all (no read, no write, no jdRoot presence probe), which
 * is what every pre-existing direct `new LinkedInLane(...)` call site
 * relies on. Production supplies it in `cli/wire.ts`. */
export interface LinkedinBreakerConfig {
  userDataDir: string;
  deps: LinkedinBreakerDeps;
}

/** Deadline for the tiny in-page jdRoot presence read run after a failed
 * JD open. Short on purpose: it is a diagnostic, and a page too sick to
 * answer it in 5s is classified `missing` (never a trip). */
const JD_ROOT_PRESENCE_TIMEOUT_MS = 5_000;

/** What one half-open probe concluded (spec §4.5 step 3). `inconclusive`
 * deliberately carries its message so the skipped reason can name the real
 * failure instead of implying the session is still blocked. */
type ProbeOutcome =
  | { result: 'ok'; jd: JD; cardId: string }
  | { result: 'shell' }
  | { result: 'inconclusive'; message: string };
```

4c. Add the field and the 13th constructor parameter (after `interUrlDelayMaxMs` from Task 3):

```typescript
  private readonly breaker: LinkedinBreakerConfig | undefined;
```

```typescript
    interUrlDelayMaxMs: number = DEFAULT_INTER_URL_DELAY_MAX_MS,
    breaker?: LinkedinBreakerConfig,
  ) {
```

```typescript
    this.breaker = breaker;
```

- [ ] **Step 5: Add the two private helpers to `LinkedInLane`**

Insert both immediately after the `interUrlPause` method from Task 3.

```typescript
  /** Classifies a JD open that already FAILED: was jdRoot present but
   * empty (`shell` — the server withheld the content, D4) or absent
   * (`missing` — selector drift, explicitly not a throttle signal)?
   *
   * Never returns `ok`: a successful open is recorded directly at the call
   * site. Any failure of the probe itself (dead page, timeout) is
   * classified `missing`, the conservative answer — an unknown must never
   * push the counter toward opening the breaker. */
  private async classifyJdOutcome(
    page: PageHandle,
    inv: Inventory,
    ctx: RunContext,
  ): Promise<JdOutcome> {
    try {
      const present = await page.evaluate<string>(
        buildJdRootPresenceScript(inv.selectors.jdRoot),
        { timeoutMs: JD_ROOT_PRESENCE_TIMEOUT_MS },
      );
      return present === '1' ? 'shell' : 'missing';
    } catch (err) {
      ctx.logger.debug(
        'linkedin lane: jdRoot presence check failed — classifying as missing',
        { message: err instanceof Error ? err.message : String(err) },
      );
      return 'missing';
    }
  }

  /** Half-open probe (D8): first url of the first group, one harvest,
   * exactly ONE JD open. Never throws — every failure becomes an
   * `inconclusive` outcome, because a broken page must not be allowed to
   * close a breaker (spec §5). Deliberately unpaced: two requests are not
   * a burst, and a blocked fire should learn its fate quickly. */
  private async runProbe(handle: BrowserHandle, ctx: RunContext): Promise<ProbeOutcome> {
    const group = this.urls[0];
    const url = group?.urls[0];
    const inv = group
      ? this.inventories.find((candidate) => candidate.page === group.page)
      : undefined;
    if (!group || !url || !inv) {
      return { result: 'inconclusive', message: 'no url/inventory available to probe' };
    }

    let page: PageHandle | undefined;
    try {
      page = await handle.newPage();
      ctx.beat();
      await page.goto(url, { timeoutMs: DEFAULT_GOTO_TIMEOUT_MS });
      const cards = await harvestCards(page, inv, ctx);
      const { pass } = gateCards(cards, this.filterCfg);
      const card = pass[0];
      if (!card) {
        return {
          result: 'inconclusive',
          message: `no gate-passing card to probe on ${url}`,
        };
      }

      let text: string;
      try {
        text = (await openJd(page, card, inv, ctx)).text;
      } catch (err) {
        const outcome = await this.classifyJdOutcome(page, inv, ctx);
        if (outcome === 'shell') return { result: 'shell' };
        return {
          result: 'inconclusive',
          message: err instanceof Error ? err.message : String(err),
        };
      }

      // Built outside the inner try on purpose: a JDSchema rejection here
      // is an empty-title/company problem, not a throttle verdict, so it
      // must fall to the outer catch as `inconclusive` rather than be
      // classified as a shell.
      const jd = JDSchema.parse({
        identity: {
          id: card.id,
          lane: 'linkedin',
          url: card.url,
          company: card.company,
          title: card.title,
          scrapedAt: new Date().toISOString(),
          location: card.location,
        },
        content: { rawText: text },
      });
      return { result: 'ok', jd, cardId: card.id };
    } catch (err) {
      return {
        result: 'inconclusive',
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (page) await page.close();
    }
  }
```

- [ ] **Step 6: Add the open-breaker short-circuit at the top of `source()`**

Insert as the **very first statements** of `source()` (before `const resumeState = await ResumeState.load(...)`, line 288) — the point of D9 is that an open breaker costs nothing at all:

```typescript
    // Breaker read comes before ANY other work (spec §4.5 step 1): an open
    // breaker must leave zero footprint on the blocked session, and
    // LinkedIn is the only browser lane in farm, so this is also what stops
    // Chrome from being launched at all.
    const breakerState = this.breaker
      ? readBreaker(this.breaker.userDataDir, this.breaker.deps)
      : undefined;
    const phase = this.breaker
      ? breakerPhase(breakerState, this.breaker.deps.now(), THROTTLE_COOLDOWN_MS)
      : 'closed';

    if (phase === 'open' && breakerState) {
      const reopenAt = new Date(
        Date.parse(breakerState.openedAt) + THROTTLE_COOLDOWN_MS,
      ).toISOString();
      ctx.logger.warn(
        'linkedin lane: throttle breaker is open — skipping this fire without launching a browser',
        { reopenAt, tripCount: breakerState.tripCount },
      );
      return {
        jobs: [],
        dropped: [],
        companiesSeen: [],
        skipped: { reason: `throttle cooldown until ${reopenAt}` },
      };
    }
```

- [ ] **Step 7: Add the half-open probe branch and the trip counter**

> Every `lane.ts` line number in this step is from the file **as it was before Task 3** — Task 3 added roughly 25 lines above these anchors, so treat the quoted surrounding code as the real anchor and the numbers as a hint.

7a. Immediately after `const stats: UrlStat[] = [];` (line 350), add:

```typescript
    // Only armed when a breaker is configured: with no breaker there is
    // nothing to open, so the classification's extra page.evaluate per
    // failed JD would be pure cost. This is also what keeps every
    // pre-throttle-guard call site (and its tests) behaviorally identical.
    const throttle = this.breaker ? new ThrottleCounter() : undefined;
    let throttleTripped = false;
    // Shells seen this run, for the all-urls-failed evidence (D13).
    let shellJdFailures = 0;
```

7b. Immediately after `const handle = await this.browser.launch(ctx);` and the opening `try {` (lines 354–355), add the probe branch:

```typescript
      if (phase === 'half-open' && this.breaker && breakerState) {
        const probe = await this.runProbe(handle, ctx);
        const { userDataDir, deps } = this.breaker;
        if (probe.result === 'shell') {
          // Still blocked. Re-open for another full cooldown, keeping the
          // record that a probe ran. ~2 requests spent instead of a fire.
          openBreaker(userDataDir, deps, {
            ...breakerState,
            lastProbeAt: deps.now().toISOString(),
          });
          ctx.logger.warn(
            'linkedin lane: half-open probe still got a server-withheld shell — breaker re-opened, ending this fire',
            { tripCount: breakerState.tripCount + 1 },
          );
          return {
            jobs: [],
            dropped: [],
            companiesSeen: [],
            skipped: { reason: 'probe found the session still throttled' },
          };
        }
        if (probe.result === 'inconclusive') {
          // A broken page proves nothing (spec §5) — leave openedAt where
          // it is so the next fire past the window probes again.
          recordProbe(userDataDir, deps, breakerState);
          ctx.logger.warn(
            'linkedin lane: half-open probe was inconclusive — breaker left open, ending this fire',
            { message: probe.message },
          );
          return {
            jobs: [],
            dropped: [],
            companiesSeen: [],
            skipped: { reason: `probe inconclusive: ${probe.message}` },
          };
        }
        // Real text: the block cleared. Delete the file and carry on with
        // this same fire (D8) — the probe's own capture counts, and its
        // card id joins processedIds so the main loop does not re-open it.
        closeBreaker(userDataDir, deps);
        await captureStore.append(this.storage, probe.jd);
        processedIds.add(probe.cardId);
        ctx.logger.info(
          'linkedin lane: half-open probe returned real JD text — breaker closed, continuing this fire',
          { cardId: probe.cardId },
        );
      }
```

7c. Record a successful open. Immediately after `stat.captured += 1;` (line 526):

```typescript
                  throttle?.record('ok');
```

7d. Classify and possibly trip. Inside the per-card `catch` block, immediately after the existing `dropped.push({ ... })` call closes (line 572, just before the catch's closing brace):

```typescript
                  // Was this a server-withheld shell (throttle) or a
                  // missing jdRoot (selector drift)? They demand opposite
                  // responses, so ask the page rather than guess.
                  if (throttle && page) {
                    const outcome = await this.classifyJdOutcome(page, inv, ctx);
                    if (outcome === 'shell') shellJdFailures += 1;
                    throttle.record(outcome);
                    if (throttle.tripped && this.breaker) {
                      throttleTripped = true;
                      const wrote = openBreaker(
                        this.breaker.userDataDir,
                        this.breaker.deps,
                        breakerState,
                      );
                      ctx.logger.warn(
                        'linkedin lane: 3 consecutive server-withheld JD shells — the session is throttled; opening the breaker and stopping this fire, keeping every capture so far',
                        { url: card.url, breakerWritten: wrote },
                      );
                    }
                  }
```

7e. Stop the loops once tripped. Four edits, outermost last:

- At the very end of the per-card `for (const card of pass) {` body (after the try/catch closes, line 573):

```typescript
                if (throttleTripped) break;
```

- Immediately after that card loop closes (line 574), before the stop-condition block's comment:

```typescript
              if (throttleTripped) break;
```

- Inside the url loop, after `await resumeState.persist(this.storage);` (line 662):

```typescript
          if (throttleTripped) break;
```

- Immediately after the url loop closes (line 663):

```typescript
        if (throttleTripped) break;
```

7f. Do not mark an interrupted url done. Replace the `markDone` guard (lines 656–658):

```typescript
          // markDone only on success — a url whose goto/harvest/newPage
          // threw must be retried on the next fire, not skipped as done.
          // A url cut short by a throttle trip is likewise unfinished: its
          // remaining cards were never attempted, so it must not be
          // recorded as complete.
          if (!stat.failed && !throttleTripped) {
            resumeState.markDone(url, stat.captured);
          }
```

- [ ] **Step 8: Run the lane tests and watch them pass**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: PASS — the seven new breaker tests plus every pre-existing test in the file.

- [ ] **Step 9: Export the new surface and wire it in production**

9a. Add to `src/adapters/lanes/linkedin/index.ts` (Biome sorts exports on lint). Keep this to exactly what `wire.ts` needs — `throttle.ts` and the rest of `breaker_store.ts` are module internals, and the colocated tests import them by relative path, which is allowed inside the module:

```typescript
export { defaultLinkedinBreakerDeps } from './breaker_store.ts';
export type { LinkedinBreakerConfig, SearchUrlGroup } from './lane.ts';
```

(The existing `export type { SearchUrlGroup } from './lane.ts';` line is replaced by the combined form above.)

9b. In `src/cli/wire.ts`, add `DEFAULT_USER_DATA_DIR` to the existing `adapters/browser/cdp-chrome/index.ts` import (it already imports `CdpChromeProvider`, `cdpReachableCheck`, `DEFAULT_CDP_PORT`, `defaultCdpReachable` from there, lines 52–58) and `defaultLinkedinBreakerDeps` to the existing `adapters/lanes/linkedin/index.ts` import (lines 68–73):

```typescript
import {
  CdpChromeProvider,
  cdpReachableCheck,
  DEFAULT_CDP_PORT,
  DEFAULT_USER_DATA_DIR,
  defaultCdpReachable,
} from '../adapters/browser/cdp-chrome/index.ts';
```

```typescript
import {
  defaultLinkedinBreakerDeps,
  inventoryFreshnessCheck,
  LinkedInLane,
  loadInventory,
  parseSearchUrls,
} from '../adapters/lanes/linkedin/index.ts';
```

9c. Pass the breaker config as the 13th argument in `buildLinkedInLane`'s `new LinkedInLane(...)` call:

```typescript
    interUrlDelayRange.minMs,
    interUrlDelayRange.maxMs,
    // Session-scoped, shared by every profile (D11): the throttle belongs
    // to the `.chrome-debug` Chrome profile whose cookies every profile
    // farms through, not to any one profile's data dir. Passed as a plain
    // string because `adapters-no-cross-family` forbids the lane importing
    // `adapters/browser/**` itself.
    { userDataDir: DEFAULT_USER_DATA_DIR, deps: defaultLinkedinBreakerDeps() },
  );
```

- [ ] **Step 10: Run the full gate**

```bash
npm run check
```

Expected: green. `boundaries` in particular must pass — if it reports `adapters-no-cross-family`, something in `lane.ts` is importing `adapters/browser/**`; remove it rather than relaxing the rule.

- [ ] **Step 11: Commit**

```bash
git add src/adapters/lanes/linkedin/lane.ts src/adapters/lanes/linkedin/lane.test.ts src/adapters/lanes/linkedin/index.ts src/cli/wire.ts
git commit -m "feat(linkedin): skip a throttled fire, probe for recovery, stop on a trip"
```

---

### Task 6: Stop the outage message misdiagnosing a throttle, and record the design

D13. The lane's own error text sent the 2026-07-28 investigation toward `/page-analyse` when the answer was rate-limiting; it must stop asserting a cause it cannot know.

**Files:**
- Modify: `src/adapters/lanes/linkedin/lane.ts` (the `field-validation` and `jd-open` evidence branches, lines 718–737)
- Test: `src/adapters/lanes/linkedin/lane.test.ts` (update one existing test, add one)
- Modify: `CLAUDE.md`
- Modify: `.claude/agents/explainer.md`

**Interfaces:**
- Consumes: Task 5's `shellJdFailures` counter (a `number` local in `source()`, incremented whenever `classifyJdOutcome` returns `'shell'`) and its `breaker?: LinkedinBreakerConfig` constructor param (position 13) — without a breaker configured no classification runs, so `shellJdFailures` stays 0 and the message falls back to its generic jd-open wording. The new test also reuses Task 5's `fakeBreakerFs`, `BREAKER_DIR` and `NOW` test helpers plus the `Script.jdShellUrls` field, and the file's pre-existing `singlePageInventory`, `newScript`, `FakeBrowserProvider`, `FakeStorage`, `fakeCtx`, `fixtureFilterConfig`, `spySleepFn`, `URL_1`.
- Produces: no new exports. Only the thrown message's text changes.

- [ ] **Step 1: Update the existing field-validation test and write the new shell test**

1a. In `src/adapters/lanes/linkedin/lane.test.ts`, in the existing test `'every attempted url failing with cards found but empty title/company reports a field-extraction message and does NOT claim the session expired'` (~line 892), replace the line

```typescript
  assert.match(message, /NOT a session problem/);
```

with

```typescript
  // D13: the message may name drifted sub-selectors as A candidate, but it
  // must no longer ASSERT that the session is fine — that claim sent the
  // 2026-07-28 throttle investigation to /page-analyse for two days.
  assert.doesNotMatch(message, /NOT a session problem/);
  assert.match(message, /one candidate/i);
```

1b. Append this test at the end of the file:

```typescript
test('all-urls-failed evidence: shell JD failures are reported as server-withheld content, not as an inventory problem (D13)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Two cards, both shells: jdRoot present, no text. Two is below the
  // 3-shell trip threshold, so the fire runs to completion and the
  // all-urls-failed guard produces the message under test.
  script.harvestByUrl.set(URL_1, [
    { title: 'Frontend Engineer', company: 'Acme', location: 'Remote', href: '/jobs/view/7001/' },
    { title: 'Frontend Engineer', company: 'Globex', location: 'Remote', href: '/jobs/view/7002/' },
  ]);
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/7001/');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/7002/');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  let message = '';
  await assert.rejects(
    () => lane.source(fakeCtx()),
    (err: Error) => {
      message = err.message;
      return true;
    },
  );

  assert.match(message, /server withheld the JD content/);
  assert.match(message, /rate-limit|soft-block/);
  assert.match(message, /cooldown/);
  // The defining assertion: a throttle must NOT send anyone to the page
  // inventory or /page-analyse.
  assert.doesNotMatch(message, /page_inventory/);
  assert.doesNotMatch(message, /page-analyse/);
});
```

- [ ] **Step 2: Run the lane tests and watch them fail**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: FAIL — the updated field-validation test fails on `assert.doesNotMatch(message, /NOT a session problem/)`, and the new test fails on `assert.match(message, /server withheld the JD content/)`.

- [ ] **Step 3: Rewrite the two evidence branches**

In `src/adapters/lanes/linkedin/lane.ts`, replace the `field-validation` branch (lines 718–728) and the `jd-open` branch (lines 729–737) with:

```typescript
      const fieldValidation = countOf('field-validation');
      if (fieldValidation > 0) {
        const sample = sampleOf('field-validation');
        evidence.push(
          `${fieldValidation} card(s) had empty/invalid title or company after ` +
            `extraction${sample ? ` (e.g. "${sample}")` : ''} ` +
            '— cards WERE found in the DOM, but field extraction failed schema validation; ' +
            'one candidate is drifted title/company sub-selectors in ' +
            'src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json ' +
            '(regenerate via /page-analyse). This signal on its own does not rule out a ' +
            'degraded/throttled session, so do not treat the inventory as proven guilty.',
        );
      }
      const jdOpen = countOf('jd-open');
      if (jdOpen > 0) {
        const sample = sampleOf('jd-open');
        if (shellJdFailures > 0) {
          // The 2026-07-28 signature: jdRoot present, textContent empty,
          // hydration request 503 while everything else on the page
          // returned 200 — the same job rendered fine to a logged-out
          // guest. Pointing at the inventory here is exactly the
          // misdiagnosis D13 exists to end.
          evidence.push(
            `${shellJdFailures} of ${jdOpen} JD-open failure(s) found the jdRoot element ` +
              'PRESENT but empty — the server withheld the JD content while serving the ' +
              'rest of the page normally. That is a rate-limit/soft-block on the shared ' +
              '.chrome-debug session, not DOM drift: the page inventory is not implicated ' +
              'and regenerating it will not help. Wait out the throttle breaker cooldown ' +
              '(.chrome-debug/.jobbunny-linkedin-breaker.json) — the next fire past it ' +
              'probes automatically.',
          );
        } else {
          evidence.push(
            `${jdOpen} card(s) were found and extracted, but JD-open failed for ` +
              `them${sample ? ` (e.g. "${sample}")` : ''} — a different ` +
              'failure mode from the above two; check the jdRoot selector or JD-pane load timing.',
          );
        }
      }
```

- [ ] **Step 4: Run the lane tests and watch them pass**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update `CLAUDE.md`**

In the **Hard rules** section, insert this bullet immediately after the `AbortSignal` bullet:

```markdown
- **The LinkedIn lane paces itself and trips a throttle breaker.** 5–12s jitter per navigation plus a 20–45s pause between saved-search URLs (`settings.linkedin.jitterMinMs/jitterMaxMs/interUrlDelayMinMs/interUrlDelayMaxMs`, defaults in `cli/wire.ts`). Three **consecutive** server-withheld JD shells (`jdRoot` present, text empty — a soft-block, never selector drift) open a 4-hour circuit breaker persisted at `.chrome-debug/.jobbunny-linkedin-breaker.json` — session-scoped, shared by every profile, thresholds are lane constants. An open breaker makes the lane return a **skipped** result without launching Chrome; `farm` excludes skipped lanes from its total-outage denominator, so the rest of the pipeline still runs.
```

- [ ] **Step 6: Update `.claude/agents/explainer.md`**

6a. In the stage table's **farm** row (line 65), replace `**Every** lane failing = loud throw.` with:

```
**Every lane that ATTEMPTED work** failing = loud throw; a lane returning `skipped` (LinkedIn on a throttle cooldown) is excluded from that denominator and contributes no `companies_seen` entry.
```

6b. Append to the `lanes/linkedin` adapter row (line 147), at the end of the cell:

```
Throttle guard (2026-07-28): pacing is 5–12s jitter per navigation + a 20–45s pause between saved-search urls (`cli/wire.ts` defaults, `settings.linkedin.*`; the lane's own defaults stay `0` so tests never really sleep), targeting ~25 min per fire inside farm's unchanged 90-min ceiling. `throttle.ts` is a pure consecutive-shell counter (`shell` = jdRoot present with empty text = a server-withheld skeleton; `missing` = jdRoot absent = selector drift, never a trip signal; 3 consecutive shells trip). `breaker_store.ts` persists `{ openedAt, tripCount, lastProbeAt }` to `.chrome-debug/.jobbunny-linkedin-breaker.json` behind injectable fs deps + injected `now` (mirrors `cdp-chrome/ownership/pidfile.ts`; session-scoped, shared by every profile, since the block belongs to the Chrome profile not to a job-search profile). Phases derive from the file: absent/corrupt ⇒ closed, `now < openedAt + 4h` ⇒ open (lane returns `skipped` and never launches the browser), else ⇒ half-open (one url, one JD-open probe: real text ⇒ delete the file and continue that same fire including the probe's capture; shell ⇒ re-open; probe error ⇒ leave as-is and skip). A mid-fire trip opens the breaker, stops the remaining urls, keeps every capture, and returns normally. The path constant `DEFAULT_USER_DATA_DIR` is passed in by `cli/wire.ts` as a plain string — `adapters-no-cross-family` forbids the lane importing `adapters/browser/**`.
```

- [ ] **Step 7: Run the full gate**

```bash
npm run check
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/lanes/linkedin/lane.ts src/adapters/lanes/linkedin/lane.test.ts CLAUDE.md .claude/agents/explainer.md
git commit -m "fix(linkedin): stop the outage message blaming selectors for a throttle"
```

---

## Landing the change

- [ ] **Step 1: Confirm the gate is green on the full branch**

```bash
npm run check
```

- [ ] **Step 2: Sanity-check the wiring against the fixture profile only**

```bash
node src/cli/main.ts doctor --profile rajni
```

`profiles/rajni/` is the committed synthetic fixture. **Never** run this or any stage against `profiles/harish/` — it holds real user data. `doctor` exercises `wire()`, which is what proves the new constructor arguments and settings schema compose; it does not farm.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "LinkedIn throttle guard: pacing + circuit breaker" --body "$(cat <<'EOF'
## What

Implements `docs/superpowers/specs/2026-07-28-linkedin-throttle-guard-design.md` (D1–D13).

- **Pacing (D2):** per-navigation jitter 2–5s → 5–12s, plus a new 20–45s pause between saved-search URLs. `settings.linkedin` gains `interUrlDelayMinMs`/`interUrlDelayMaxMs`; `farm.timeoutMs` is unchanged (a 21-URL fire lands around 25 min against a 90-min ceiling).
- **Detection (D4/D5):** a new in-page presence check separates "jdRoot present but empty" (server-withheld shell — a throttle) from "jdRoot absent" (selector drift). Three consecutive shells trip.
- **Breaker (D7/D8/D9/D11/D12):** `.chrome-debug/.jobbunny-linkedin-breaker.json`, session-scoped, 4-hour cooldown, half-open probe that costs ~2 requests and closes the breaker on real text. Corrupt state reads as closed; failed writes are warnings.
- **Skipped ≠ outage (D10):** `FarmingLane.source()` gains an optional `skipped`, and `farm` excludes skipped lanes from its every-attempted-lane-failed computation.
- **Message fix (D13):** the all-urls-failed evidence stops asserting "NOT a session problem" and names a shell-shaped failure as a rate-limit, not an inventory problem.

## Why

On 2026-07-28 three fires in five hours pushed into a LinkedIn soft-block. Live inspection showed the JD hydration request returning 503 while everything else on the page returned 200, `jdRoot` present with zero-length text, and the same job rendering fine to a logged-out guest. Card selectors re-verified at 100% across 50 live cards: the page inventory was never wrong. The lane had no backoff and its own error text pointed the investigation at `/page-analyse`.

## Testing

Hermetic throughout — no real browser, network, filesystem, or clock. Classifier table tests; store tests on fake fs deps with a fixed `now`; pacing tests on a spy `sleepFn`; open/half-open/trip paths and the skipped-lane stage cases on the existing fakes. `npm run check` green.

## Not in this PR

- URL rotation (spec §2 non-goal).
- Surfacing the skip reason in `result.json`/the Telegram digest — see the plan's deferred follow-ups.
EOF
)"
```

- [ ] **Step 4: Confirm the check is green**

```bash
gh pr checks --watch
```

Expected: the `test` check passes. `main` is protected; do not merge on a red check.

---

## Deferred follow-ups

Not part of this plan.

1. **Surface the skip reason in the run digest.** Spec §4.6 wants `LinkedIn skipped — throttle cooldown until 18:42` in the Telegram digest so a low-yield day explains itself. Task 4 gets the reason as far as `run.log`'s `farming lane skipped` info line; carrying it into `result.json` (which the runner builds both digests from) means adding a field to the stage payload or run result, which touches the runner's result schema and both notifier paths. That is a feature with its own review surface, not a tweak to the `farm` loop.
2. **Split the linkedin lane folder.** It holds eight implementation files after this plan (six of them pre-existing). A `linkedin/throttle/` subfolder holding `throttle.ts` + `breaker_store.ts` behind an `index.ts` would bring it back toward the two-pair rule, but it is a pure move and belongs in its own commit.
3. **Probe accounting.** A successful half-open probe's capture is appended to `CaptureStore` and its card id joins `processedIds`, but it is deliberately not folded into any `UrlStat` — so the probed URL's own `captured` count in the failure evidence excludes it, and the main loop re-navigates that URL once. Both are cosmetic; revisit only if the evidence numbers start misleading someone.
4. **Consider a `doctor` check for a long-open breaker.** A breaker that has re-opened many times (`tripCount` climbing across days) means pacing is still too aggressive. Today that is only visible by reading the file.
