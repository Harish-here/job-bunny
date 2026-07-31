# LinkedIn Outage-Guard Sample Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a single failed JD-open from failing an entire scheduled run, by giving the LinkedIn lane's all-urls-failed guard a minimum-sample floor so it stops preempting the lane-wide guard that already knows how to preserve earlier same-day captures.

**Architecture:** `src/adapters/lanes/linkedin/lane.ts` has two aggregate failure guards. Guard A (`lane.ts:705`, `failedUrls === attemptedUrls`) throws unconditionally. Guard B (`lane.ts:769`, `totalCardsAttempted > 0 && totalCaptured === 0`) throws only when there are no captures preserved from an earlier same-day fire — otherwise it logs loudly and returns those captures. Guard A fires first and is sample-size blind, so it skips Guard B's escape hatch entirely. The fix adds one exemption to Guard A: when *every* recorded failure is a `jd-open` failure **and** fewer than 3 cards were attempted **and** the run was not aborted, Guard A logs instead of throwing and lets Guard B decide. No new escape hatch is added to Guard A — that would risk papering over a genuinely expired session.

**Tech Stack:** TypeScript 7 (strict, erasable-syntax-only), ESM, `node:test` + `node:assert/strict`, zod, Biome. Node ≥ 24, no build step.

## Global Constraints

- Node ≥ 24 required (native type-stripping). `.nvmrc` pins it; plain `node`/`npm` work.
- THE gate is `npm run check` (typecheck + lint + boundaries + tests). CI's `test` check is exactly this. It must be green before the PR.
- `main` is protected — land via PR.
- Runtime deps stay at three: `@notionhq/client`, `playwright`, `zod`. **Add no dependency.**
- Colocated tests: `foo.ts` pairs with `foo.test.ts`.
- Adapters may import only `ports` + `core` (`.dependency-cruiser.cjs` `adapters-only-ports-core`). **Do not add an import to `pipeline/**` in `lane.ts`.**
- Architecture docs are code: `.claude/agents/explainer.md` and `CLAUDE.md` must be updated in the same change that alters behavior.
- Do **not** hand-edit `CHANGELOG.md` or `package.json` version — those are owned by `npm run release`.
- Never run pipeline stages against `profiles/harish/` (real user data). The fixture profile is `profiles/rajni/`.

## Background: the incident this fixes

2026-07-27, the 16:30 scheduled run for profile `harish` failed at the `farm` stage. Sequence:

1. The 09:00 fire marked 20 of 21 search URLs done (`lane.ts:372`), so the 16:30 fire attempted exactly **1** URL.
2. That URL harvested **80** cards successfully — proof the session and card selectors were healthy.
3. The Notion cache-skip (`lane.ts:462`) filtered 79 already-captured cards, leaving **1** genuinely-new card.
4. That one card (`https://www.linkedin.com/jobs/view/4444858900/`) returned empty text from both `jdRoot` and the anchor fallback (`jd_open.ts:193`) → one `jd-open` SoftError.
5. `attemptedUrls === 1`, `failedUrls === 1` → Guard A threw → `farm` failed → run dead.

Guard B would have returned the 10 JDs the 09:00 fire had already captured. It never ran. This shape recurs on every later-in-day fire and is not a scraper bug.

**Out of scope for this plan** (tracked separately, do not attempt here):

- The `structure` stage failing in headless scheduled runs (09:00 today, and 2026-07-25). Undiagnosed — needs its own investigation before a plan can be written.
- Whether commit `1531045`'s `jdRoot` value (`[componentkey^="JobDetails_AboutTheJob"]`) is correct. Exactly one live observation exists and it failed; n=1 settles nothing, and this plan does not depend on the answer.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/adapters/lanes/linkedin/lane.ts` | Modify | Add `MIN_OUTAGE_SAMPLE_CARDS` constant near the other lane defaults; compute the exemption and apply it to Guard A. |
| `src/adapters/lanes/linkedin/lane.test.ts` | Modify | Three new guard tests (Task 1) + one incident regression test (Task 2). Append near the existing aggregate-guard tests. |
| `.claude/agents/explainer.md` | Modify | Record the two-guard ordering and the sample floor in the lane/farm failure-semantics section. |
| `CLAUDE.md` | Modify | Tighten the existing fail-loud invariant line to state the sample floor. |

No new files. No new modules — the change is ~15 lines of implementation in an existing function.

---

### Task 1: Sample-size floor on the all-urls-failed guard

**Files:**
- Modify: `src/adapters/lanes/linkedin/lane.ts` (constant near line 41; guard at lines 705–751)
- Modify: `.claude/agents/explainer.md`
- Modify: `CLAUDE.md`
- Test: `src/adapters/lanes/linkedin/lane.test.ts`

**Interfaces:**
- Consumes: existing in-scope locals in `LinkedInLane.source()` — `attemptedUrls`, `failedUrls`, `totalCardsAttempted`, `failures` (type `Array<{ kind: FailureKind; message: string }>`), `ctx` (type `RunContext`, has `.signal` and `.logger`). `FailureKind` is `'zero-cards' | 'field-validation' | 'jd-open' | 'other'` (`lane.ts:197`).
- Produces: module-private `const MIN_OUTAGE_SAMPLE_CARDS = 3`. Nothing exported; no signature changes. `source()` keeps returning `{ jobs, dropped, companiesSeen }`.

- [ ] **Step 1: Write the three failing tests**

Append these to `src/adapters/lanes/linkedin/lane.test.ts`, immediately after the existing test named `'every attempted url failing with cards found but empty title/company reports a field-extraction message and does NOT claim the session expired'` (starts ~line 895). All helpers used below (`singlePageInventory`, `newScript`, `FakeBrowserProvider`, `FakeStorage`, `fakeCtx`, `fixtureFilterConfig`, `URL_1`, `LinkedInLane`) already exist in this file — do not redefine them.

```typescript
test('all-urls-failed guard does not fire on a sub-threshold sample of jd-open-only failures — the lane-wide guard reports instead (2026-07-27 incident)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // One url, one gate-passing card, and NO scripted JD text for it: openJd
  // extracts '' and raises a SoftError, recorded as a 'jd-open' failure.
  // attemptedUrls === failedUrls === 1 and totalCardsAttempted === 1.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/1001/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
  );

  await assert.rejects(
    () => lane.source(ctx),
    (err: Error) => {
      // A 1-card sample must no longer be reported as the all-urls-failed
      // outage...
      assert.doesNotMatch(err.message, /attempted url\(s\) failed this run/);
      // ...it falls through to the lane-wide "no JD ever opened" guard,
      // which is the guard that owns the prior-captures escape hatch.
      assert.match(err.message, /zero JDs were captured/);
      return true;
    },
  );
});

test('all-urls-failed guard still fires at the sample threshold — 3 attempted cards all failing JD-open is a real outage', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Three gate-passing cards, none with scripted JD text -> three
  // 'jd-open' failures, totalCardsAttempted === 3, which is NOT below
  // MIN_OUTAGE_SAMPLE_CARDS. The guard must behave exactly as before.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/1001/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/1003/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/1004/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
  );

  await assert.rejects(
    () => lane.source(ctx),
    /all 1 attempted url\(s\) failed this run.*3 card\(s\) were found and extracted, but JD-open failed/s,
  );
});

test('a sub-threshold sample is never exempt when the failures are not jd-open — one zero-cards url still fails loud (authwall shape)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Zero cards harvested -> harvestCards' own min-count guard throws, a
  // 'zero-cards' failure with cardsAttempted === 0. That is below the
  // sample floor, but it is exactly the authwall/selector-drift signal the
  // guard exists to catch, so the exemption must NOT apply to it.
  script.harvestByUrl.set(URL_1, []);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
  );

  await assert.rejects(
    () => lane.source(ctx),
    /all 1 attempted url\(s\) failed this run.*zero \(or too few\) cards in the DOM/s,
  );
});
```

- [ ] **Step 2: Run the new tests to verify they fail correctly**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: the **first** new test FAILS — its `assert.doesNotMatch(err.message, /attempted url\(s\) failed this run/)` trips, because Guard A currently throws on a 1-card sample. The **second and third** new tests PASS already (they pin behavior that must not change). Every pre-existing test still passes.

If the first test passes at this step, stop — the bug is not reproduced and the rest of the plan is built on a false premise.

- [ ] **Step 3: Add the constant**

In `src/adapters/lanes/linkedin/lane.ts`, immediately after the `DEFAULT_MAX_CARDS_PER_URL` declaration (~line 41) and before the `DEFAULT_JITTER_MIN_MS` block, insert:

```typescript
/** Minimum attempted-card count before a 100% JD-open failure rate counts
 * as a lane outage. Below this, a single expired/removed posting produces
 * an "every attempted url failed" signal that means nothing: a later
 * same-day fire attempts only the urls the morning fire left unmarked, and
 * the Notion cache-skip filters those down to a handful of genuinely-new
 * cards (2026-07-27 incident: 80 cards harvested, 79 cache hits, 1
 * attempted, 1 failed -> the whole run failed). Applies ONLY when every
 * recorded failure is a 'jd-open' failure — cards were found AND their
 * fields validated, so the session and the card selectors are
 * demonstrably alive. 'zero-cards' / 'field-validation' / 'other'
 * failures still throw at any sample size: those are the authwall and
 * selector-drift signals this guard exists to catch. */
const MIN_OUTAGE_SAMPLE_CARDS = 3;
```

- [ ] **Step 4: Apply the exemption to Guard A**

In `src/adapters/lanes/linkedin/lane.ts`, find this line (currently line 705):

```typescript
    if (attemptedUrls > 0 && failedUrls === attemptedUrls) {
```

Insert the following block immediately **before** it, and change the `if` condition to include `&& !tooSmallToCall`:

```typescript
    // See MIN_OUTAGE_SAMPLE_CARDS. Only a jd-open-only failure set is
    // eligible: any other failure kind is real structural evidence at any
    // sample size. An aborted run is never exempt either — a cancelled
    // fire must keep failing loud rather than being re-read as a small
    // sample. When exempt, fall through to the lane-wide guard below,
    // which owns the prior-same-day-captures escape hatch.
    const jdOpenOnly =
      failures.length > 0 && failures.every((f) => f.kind === 'jd-open');
    const tooSmallToCall =
      jdOpenOnly &&
      totalCardsAttempted < MIN_OUTAGE_SAMPLE_CARDS &&
      !ctx.signal.aborted;
    if (tooSmallToCall) {
      ctx.logger.warn(
        'linkedin lane: every attempted url failed, but too few cards were attempted to call it an outage — deferring to the lane-wide guard',
        {
          attemptedUrls,
          totalCardsAttempted,
          minSample: MIN_OUTAGE_SAMPLE_CARDS,
        },
      );
    }

    if (attemptedUrls > 0 && failedUrls === attemptedUrls && !tooSmallToCall) {
```

Do not change anything inside the guard body (the evidence-building and the `throw`). Do not touch the lane-wide guard at ~line 769.

- [ ] **Step 5: Run the lane tests to verify they pass**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: PASS — all three new tests and **all 40+ pre-existing tests** in the file.

Pay specific attention to these pre-existing tests, which pin behavior the exemption must not weaken. If any of them fails, the exemption is too broad — stop and report rather than loosening the test:

- `'every attempted url failing is a loud aggregate failure (finding 3) — goto failures report as "other reasons", NOT an asserted expired session'` — failures are kind `'other'`, so `jdOpenOnly` is false.
- `'every attempted url failing with zero cards harvested reports a DOM/authwall-shaped message…'` — kind `'zero-cards'`.
- `'every attempted url failing with cards found but empty title/company…'` — kind `'field-validation'`.
- `'jitter: an already-aborted ctx.signal makes the (real, default) jitter reject immediately…'` — asserts `/all 2 attempted url\(s\) failed/`; protected by the `!ctx.signal.aborted` clause.
- `'lane-wide "no JD ever opened" guard: url A attempts 2 cards and fails both, url B has zero cards survive gating…'` — `failedUrls (1) !== attemptedUrls (2)`, so Guard A never fired here to begin with.

- [ ] **Step 6: Run the full gate**

```bash
npm run check
```

Expected: PASS (typecheck, lint, boundaries, all tests).

- [ ] **Step 7: Update the architecture docs**

In `.claude/agents/explainer.md`, locate the section describing the LinkedIn lane's or the `farm` stage's failure semantics (per `CLAUDE.md`, that is §2.1's per-stage failure semantics). Add:

```markdown
The LinkedIn lane has two aggregate failure guards, and their ORDER is
load-bearing. Guard A (`lane.ts`, `failedUrls === attemptedUrls`) throws.
Guard B (`lane.ts`, `totalCardsAttempted > 0 && totalCaptured === 0`)
throws only when no captures were preserved from an earlier same-day fire;
otherwise it logs loudly and returns those captures. Because A runs first,
anything A throws on never reaches B's escape hatch. A is therefore
exempted, via `MIN_OUTAGE_SAMPLE_CARDS`, when fewer than 3 cards were
attempted AND every failure was a `jd-open` failure AND the run was not
aborted — the 2026-07-27 shape, where a later same-day fire attempts one
url whose cards are nearly all Notion cache hits, so one expired posting
produced a 100% failure rate over a sample of one. Guard A deliberately
does NOT get its own prior-captures escape hatch: an expired session
producing `zero-cards` failures must keep failing loud rather than
silently re-returning the morning's data every day.
```

In `CLAUDE.md`, find this line under **Key invariants**:

```markdown
- **Fail-soft where breadth matters, fail-loud on total outage.** One broken URL/card/probe/fetch is a `SoftError` — recorded, run continues. A stage that attempted work and captured **nothing** throws loud (e.g. the LinkedIn lane when every attempted URL yields zero JDs — shaped like an expired login).
```

Replace it with:

```markdown
- **Fail-soft where breadth matters, fail-loud on total outage — above a minimum sample.** One broken URL/card/probe/fetch is a `SoftError` — recorded, run continues. A stage that attempted work and captured **nothing** throws loud (e.g. the LinkedIn lane when every attempted URL yields zero JDs — shaped like an expired login). But a 100% failure rate over fewer than `MIN_OUTAGE_SAMPLE_CARDS` attempted cards, where every failure is a JD-open failure, is not an outage — later same-day fires legitimately attempt a handful of cards, so the lane defers to its prior-captures guard instead of failing the run.
```

- [ ] **Step 8: Re-run the gate after the doc edits**

```bash
npm run check
```

Expected: PASS. (Doc edits should not affect it; this confirms nothing was disturbed.)

- [ ] **Step 9: Commit**

```bash
git add src/adapters/lanes/linkedin/lane.ts src/adapters/lanes/linkedin/lane.test.ts .claude/agents/explainer.md CLAUDE.md
git commit -m "fix(linkedin): require a minimum card sample before calling an outage"
```

---

### Task 2: End-to-end regression test for the 16:30 incident

**Files:**
- Test: `src/adapters/lanes/linkedin/lane.test.ts`

**Interfaces:**
- Consumes: `MIN_OUTAGE_SAMPLE_CARDS` behavior from Task 1 (not the symbol — it is module-private and must stay that way; this test exercises it through `lane.source()`). Also uses `CAPTURE_PATH` and `fakeCapturedJD(id, company)`, both already imported/defined in `lane.test.ts`.
- Produces: nothing consumed by later tasks.

Task 1's tests prove the guard no longer *throws* on a small sample. This task proves the end-to-end outcome the incident actually needed: the run **survives** and returns the morning fire's work. It is a separate task because a reviewer could reasonably accept Task 1's guard change while rejecting this test's framing, or vice versa.

- [ ] **Step 1: Write the failing test**

Append to `src/adapters/lanes/linkedin/lane.test.ts`, immediately after the three tests added in Task 1:

```typescript
test('2026-07-27 incident: a later same-day fire whose single new card fails JD-open returns the captures from the morning fire instead of failing the run', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // The 16:30 shape: exactly one url still unmarked, and after the Notion
  // cache-skip exactly one genuinely-new card on it — whose JD-open fails
  // (no scripted JD text). Guard A must stand down; Guard B must find the
  // morning fire's flushed captures and return them.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/1001/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  storage.set(CAPTURE_PATH, [
    fakeCapturedJD('li-9001', 'EarlierCo'),
    fakeCapturedJD('li-9002', 'OtherCo'),
  ]);
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  assert.deepEqual(
    jobs.map((jd) => jd.identity.id).sort(),
    ['li-9001', 'li-9002'],
    "the morning fire's captures must survive one new card failing to open",
  );
  // Both guards must still have said something — a survived run is not a
  // silent run.
  assert.ok(
    warnings.some((w) =>
      /too few cards were attempted/.test((w as { msg: string }).msg),
    ),
    'the sub-threshold exemption must be logged, not silent',
  );
  assert.ok(
    warnings.some((w) => /every JD-open failed/.test((w as { msg: string }).msg)),
    'the lane-wide guard must still surface the JD-open outage loudly',
  );
});
```

- [ ] **Step 2: Run it to verify it passes**

```bash
node --test src/adapters/lanes/linkedin/lane.test.ts
```

Expected: PASS.

This test is written after the implementation exists, so it passes immediately — that is intentional. To confirm it actually guards the fix rather than passing vacuously, verify it fails without the fix:

```bash
git stash push src/adapters/lanes/linkedin/lane.ts && node --test src/adapters/lanes/linkedin/lane.test.ts; git stash pop
```

Expected: with `lane.ts` reverted, this test FAILS (`lane.source()` rejects with `all 1 attempted url(s) failed this run`). Then `git stash pop` restores the fix. Re-run the tests once more after the pop and confirm PASS before continuing.

- [ ] **Step 3: Run the full gate**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/lanes/linkedin/lane.test.ts
git commit -m "test(linkedin): pin the 2026-07-27 single-card outage regression"
```

---

### Task 3: Land the change

**Files:**
- No source changes. Verification and PR only.

**Interfaces:**
- Consumes: the commits from Tasks 1 and 2.
- Produces: a PR against `main` with the `test` check green.

- [ ] **Step 1: Confirm the working tree is clean and the commits are the expected ones**

```bash
git status --short && git log --oneline -3
```

Expected: no unstaged or uncommitted changes to `src/`, `.claude/`, or `CLAUDE.md`; the two commits from Tasks 1 and 2 on top.

If `docs/superpowers/specs/2026-07-27-cross-platform-daemon-design.md` shows as modified, leave it alone — it belongs to unrelated in-flight work and must not be swept into this PR.

- [ ] **Step 2: Run the gate one final time**

```bash
npm run check
```

Expected: PASS. Do not open the PR on a red gate.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
```

```bash
gh pr create --base main --title "fix(linkedin): require a minimum card sample before calling an outage" --body "$(cat <<'EOF'
## What

Adds `MIN_OUTAGE_SAMPLE_CARDS` (3) to the LinkedIn lane's all-urls-failed guard. When every recorded failure is a `jd-open` failure, fewer than 3 cards were attempted, and the run was not aborted, the guard logs instead of throwing and defers to the lane-wide "no JD ever opened" guard.

## Why

The 2026-07-27 16:30 scheduled run failed at `farm`. It harvested 80 cards successfully; the Notion cache-skip left 1 genuinely-new card; that card's JD-open failed. `failedUrls === attemptedUrls === 1`, so the all-urls-failed guard threw — preempting the lane-wide guard, which would have returned the 10 JDs the 09:00 fire had already captured.

This recurs on every later-in-day fire, since the morning fire marks nearly every URL done and the cache-skip filters the rest.

The lane-wide guard deliberately keeps sole ownership of the prior-captures escape hatch: a genuinely expired session produces `zero-cards` failures, which stay loud at any sample size.

## Testing

- Three new guard tests: sub-threshold jd-open-only exemption, the threshold boundary at 3 cards, and non-`jd-open` failure kinds never being exempt.
- One end-to-end regression test reproducing the 16:30 shape.
- `npm run check` green.

## Not in this PR

- The `structure` stage failing in headless scheduled runs (also broke today's 09:00 run, and 2026-07-25) — undiagnosed, separate fix.
- Whether commit 1531045's `jdRoot` selector is correct — one live observation, insufficient to conclude.
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

Not part of this plan. Each needs its own diagnosis before a plan can be written:

1. **`structure` stage fails in headless scheduled runs.** Today's 09:00 run failed there after 2 attempts (~10.8 min); 2026-07-25 failed there too. `run.log` shows `structure: starting` emitted twice with identical payloads 18ms apart. Hypothesis to test: commit `f65c77c` ("skip claude CLI auto-discovery in headless runs") leaves the stage with no LLM path at all under launchd. Until this is fixed, no scheduled run can complete even with the present plan applied.
2. **Validate `jdRoot`.** Re-check job `4444858900` against a live logged-in session to determine whether `[componentkey^="JobDetails_AboutTheJob"]` is sound or whether that posting was simply expired. If the selector is wrong, the fix is to regenerate the inventory via `/page-analyse`, never to edit lane code.
3. **Consider surfacing the deferred-outage warning in the run digest.** With this plan applied, a run that trips the exemption succeeds with a `warn` line. The runner is the single notifier and builds digests from `result.json`; a repeated exemption is a signal worth seeing without reading `run.log`.
