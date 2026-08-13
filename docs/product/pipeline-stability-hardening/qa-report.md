# QA Report — Pipeline Stability Hardening, **Phase 0 only**

Author: product-qa, 2026-08-13
Rounds: **3** — round 1 at `d7a23ee`, round 2 at `5e46faf`, round 3 at `82e3e70`
Verdict: **GREEN — zero open bugs.** All seven bugs found across three rounds are closed and
independently re-verified. PR raising is **blocked on one decision** the user must make — see §12.

---

## 1. Scope Digest

| Item | Value |
|---|---|
| Repo / worktree | `/Users/harishamutha/jb-wt-stable` |
| Branch | `feat/daemon-schema-selfheal` |
| HEAD verified (round 3) | `82e3e70` — *"fix(daemon): latch the failed-send branch and pin the pidfile round-trip"* |
| Prior HEADs verified | round 2 `5e46faf`; round 1 `d7a23ee` |
| Artifacts | `spec.md`, `ux-notes.md`, `mockup.html`, `blueprint-be.md`, `blueprint.md` (committed in `6e1ec14`) |
| Scope verified | **Phase 0 = defect D2 only.** R12–R16; AC14, AC15, AC21; mockup **S4 — Daemon degraded** (both placements). |
| Scope NOT verified | Phase 1 (D1 gate, D1b catch-up, D3 dedup, D3b deferred visibility). Absent **by design**, never scored as failed. |
| Live drive | board run from the worktree on port **1995**, `JOBBUNNY_HOME` pointed at a scratch copy of `profiles/rajni/`. Server stopped after each round. `~/.jobbunny/`, the committed `profiles/rajni/`, the live daemon (pid 77885) and the sibling worktrees were never touched. |

**Phase 0's defining constraint — re-checked at `82e3e70`, still holds.**
`LATEST_SCHEMA_VERSION` is **7** (`migrations.ts:16`), `MIGRATIONS` holds exactly **7** entries, and
`migrations.ts` appears in neither `git diff --stat main-stable...HEAD` nor any of the three fix
commits. Phase 0 is migration-free, per `blueprint-be.md` §2.

---

## 2. Gate Results

### Round 3 — at `82e3e70`. All four **PASS**.

| Gate | Result | Exit | Counts |
|---|---|---|---|
| `npm run check` | PASS | 0 | **1828** tests, 1828 pass, 0 fail (9 suites) |
| `npm run ui:check` | PASS | 0 | 74 test files, **712** tests passed |
| `npm run ui:build` | PASS | 0 | built in 268ms |
| `npm run ui:e2e` | PASS | 0 | **70** passed (9.8s) |

Across rounds: 1826 → 1827 → **1828** node tests; 709 → 712 → **712** vitest; 68 → 70 → **70** e2e.

Logs: `<scratch>/r3-gate-*.log` (and `r2-`/unprefixed for the earlier rounds).

**All three rounds were fully green while bugs were open** — five in round 1, two in round 2. The
gates never decided a verdict; the artifacts and the driven behaviour did.

---

## 3. Round 3 — the bug-class sweep

The class: *a per-tick code path in the schema-drift flow that repeats a side effect — a log line, a
network call, a pidfile write — without a latch or interval bound.* D2 exists because the daemon
repeated one log line 75 times and kept ticking; any unbounded per-tick repeat in the fix is that
failure in a new hat. Rounds 1 and 2 produced two instances of it (Bugs 5 and 7), the second found
only by varying the walk. So round 3 asked: **is there a third?**

Every branch reachable per tick in `src/ops/daemon/alert/schema_drift.ts` and the drift path in
`daemon.ts` was **driven**, not read, with `DaemonPidfileDeps` instrumented to count committed
pidfile writes (`renameSync`), reads, `notify()` calls and `hasNotifierConfigured()` calls, over
≥5 ticks each (`<scratch>/sweep.mts`, `<scratch>/sweep2.mts`).

| # | Branch | Reached when | Side effects | Bounded by | Driven result |
|---|---|---|---|---|---|
| **B0** | early return | `schemaDrift.size === 0` (no drift, and the drift-clears transition) | **none** | no drift — nothing runs | 5 ticks → writes 0, logs 0, sends 0, reads 0 |
| **B1** | degraded append | a drifted profile not yet in `pidfile.degraded` | 1 pidfile write **per newly-degraded profile** | the `alreadyDegraded` set | 2nd profile joins mid-episode, 6 ticks → **writes 1**, logs 0, sends 0 |
| **B2** | already-notified return | `schemaDriftNotifiedAt !== null` | 2 pidfile **reads** only | `schemaDriftNotifiedAt` (stamped, never cleared) | 8 ticks → **writes 0, logs 0, sends 0, notifierChecks 0** |
| **B3** | no-notifier skip log | no sender, latch `null` | 1 warn log + 1 pidfile write | `schemaDriftNoNotifierWarnedAt` | 6 ticks → **logs 1** |
| **B4** | no-notifier, latched | no sender, latch set | reads + notifier checks only | same latch | next 6 ticks → **writes 0, logs 0** |
| **B5** | latch clear | sender found, no-notifier latch set | 1 pidfile write | one-shot — the field becomes `null` | 5 ticks → 1 clear, latch `null` after |
| **B6** | retry throttle return | sender found, `schemaDriftNotifyFailedAt` within window | reads + notifier checks only | `SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS` (1h) | 6 ticks → **sends 1, logs 1** |
| **B7** | send attempt, failed | sender found, past window or field `null` | 1 `notify()` + 1 warn log + 1 pidfile write | the interval stamp | boundary driven — see §5 |
| **B8** | send succeeded | `notify()` → `true` | 1 info log + 1 pidfile write (stamps `schemaDriftNotifiedAt`, clears `…FailedAt`) | `schemaDriftNotifiedAt` → B2 forever | 1 send, then 8 inert ticks |
| **D1** | `daemon.ts` `checkSchemaDrift` | every tick | read-only `PRAGMA user_version` per scheduled profile | **by design** — it is the detector and the spawn filter; read-only, no accumulation | 6/6 invocations over 6 ticks |
| **D2** | `daemon.ts` spawn exclusion | profile present in the drift map | **none** — filtered out of `activeSchedules` before `isRunOwed`; emits no log line | the filter itself | degraded `alpha` spawned **0** times over 6 ticks; healthy `beta` spawned **1** |

**Real-daemon confirmation** (`createDaemon`, 6 ticks, one degraded + one healthy profile): total log
events were `schema-drift-notify-sent` ×1, `spawn` ×1, `child-exit` ×1. **No event repeated per
tick**; no `tick-failed`. The degraded profile never spawned; the healthy one spawned normally, so
the guard does not suppress normal operation.

### Verdict of the sweep: **no third instance. Every branch is bounded, and the bounding field is named for each.**

Two per-tick repeats exist and are **correctly** unbounded, recorded here so a future reviewer does
not mistake them for the class:

- **`hasNotifierConfigured()` runs every tick in B4 and B6** (a readonly config-store open + parse per
  scheduled profile). A *read*, not a side effect, and the daemon already performs a per-tick
  `scanProfileSchedules` config read for every profile by design. Same posture, no accumulation.
- **`checkSchemaDrift` (D1) and the `lastTickAt` heartbeat write run every tick.** Both are the
  intended per-tick mechanisms (the heartbeat is D22 by name); repeating is their purpose.

---

## 4. Traceability Matrix (at `82e3e70`)

### Phase 0 requirements (D2)

| Req | MoSCoW | Verdict | Evidence |
|---|---|---|---|
| **R12** — detects DB schema newer than build; daemon-level fault, not a per-tick log line | Must | **delivered** | `readSchemaVersionReadonly` (non-throwing); `wireDaemonSchemaGuard`; pidfile `degraded[]`. Round-3 drive: guard invoked 6/6 ticks, drifted profile recorded once. |
| **R13** — notifies **once**, not once per tick | Must | **delivered** | `trackSchemaDriftAndNotify` + `schemaDriftNotifiedAt`. Driven: 1 send, then 8 fully inert ticks (B2). |
| **R14** — board daemon status shows degraded with reason **and** remedy | Must | **delivered** | Both placements verified live at 1440×900 (round 2). Settings: `Degraded — schema v8 > daemon build v7`; banner: `Cause: …` + `Fix: restart the daemon —` + command block. |
| **R15** — stops repeat-logging the same fault; holds an explicit degraded state | Must | **delivered** | Spawn exclusion driven through the real tick loop (degraded profile: 0 spawns / 6 ticks, no log line). Every log path now latched or interval-bounded — §3. |
| **R16** — `jobbunny doctor` reports degraded state | Should | **delivered** | Live-verified rounds 1 and 2; round-2 output byte-identical to round 1. |

### Phase 0 acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| **AC14** — exactly one notification; does not repeat the same log line on every subsequent tick | **delivered** | Both halves now hold. Notification: 1 send then inert. Log: every branch latched (`schemaDriftNoNotifierWarnedAt`) or interval-bounded (`schemaDriftNotifyFailedAt`, 1h) — driven over ≥5 ticks each. |
| **AC15** — board's daemon status reads degraded, names cause, names remedy | **delivered** | Settings line leads with the status word `Degraded`; banner's cause line leads with `Cause:`. |
| **AC21** — `npm run check` passes, including `boundaries` | **delivered** | Exit 0, 1828/1828. |
| AC8 (adjacent guard) — no file under `src/pipeline/runner/` touched | **delivered** | Absent from the branch diff and all three fix commits. |

### Mockup state inventory — S4 Daemon degraded

All 11 states delivered, **all 11 pinned by a test**.

| # | State | Pinned by |
|---|---|---|
| 1 | `daemon-degraded-banner`, degraded | `shell.spec.ts`; `DaemonDegradedBanner.test.tsx`; `Shell.test.tsx` |
| 2 | banner absent when not degraded / entry missing | `DaemonDegradedBanner.test.tsx` ×2; live (count 0) |
| 3 | `daemon-degraded-cause` | `shell.spec.ts`; unit test asserts text **equals** the fixture reason |
| 4 | `daemon-degraded-remedy` | no direct assertion; the command block **is** asserted — NOTES |
| 5 | `daemon-degraded-command` | `shell.spec.ts` |
| 6 | `daemon-degraded-copy-button` | `shell.spec.ts` (label flips — the effect); unit test; live-verified by mouse **and** keyboard |
| 7 | dismiss button (`mockup.html:694`) | **deliberately not built** — `DaemonDegradedBanner.test.tsx` "has no dismiss control"; `Shell.test.tsx`. Approved divergence, see §10 |
| 8 | `schedule-daemon-status-healthy` | `settings.spec.ts`; `ScheduleSection.test.tsx:181` |
| 9 | `schedule-daemon-status-degraded` | `settings.spec.ts`; `ScheduleSection.test.tsx:232` |
| 10 | `schedule-daemon-status-loading` | `ScheduleSection.test.tsx:269`; `settings.spec.ts:300` |
| 11 | `schedule-daemon-status-error` | `ScheduleSection.test.tsx:282`; `settings.spec.ts:270` (asserts the degraded≠unreachable distinction) |

Every shipped Phase 0 element carries **both** `data-qa` and `data-testid`; no `data-testid` was
removed by any of the three fix commits.

### Out of scope — Phase 1, correctly absent

Re-verified at `82e3e70`: a grep for `deferred_slots|catchup_slots_json|DeferredGroup|catchup-banner|
deferred-group` across `src/`, `ui/src/`, `ui/e2e/` returns nothing; `src/ops/daemon/` has no
`reachability/` and `src/core/schedule/` no `suspend.ts`. **No Phase 1 row is scored as failed.**

---

## 5. Bug 7 — the 1h retry interval, verified

`SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS = 60 * 60_000`.

| Check | Driven result |
|---|---|
| 6 ticks inside the window, sender found, delivery failing | **1** `schema-drift-notify-failed` log, **1** `notify()` attempt |
| tick at **exactly** `t0 + 1h` | writes 0, logs 0, sends 0 → **skipped** |
| tick at `t0 + 1h + 1ms` | writes 1, logs 1, sends 1 → **retried** |
| malformed `schemaDriftNotifyFailedAt` (`'not-a-date'`) | attempt **allowed** (`sends 1`), and the field is rewritten to a valid `2026-08-13T10:00:30.000Z` |
| 5 ticks after that self-heal | writes 0, logs 0, sends 0 |

**Boundary confirmed as `>`, not `>=`** — the guard is `elapsed <= INTERVAL → return`, so a retry
requires `elapsed` strictly greater than the interval. At exactly one hour there is no retry.

**Fail-toward-availability confirmed as behaviour, not just intent.** A malformed timestamp does not
block the alerting path forever: `Number.isFinite(elapsed)` is false, the throttle is skipped, the
attempt proceeds, and the failed attempt immediately overwrites the malformed value with a valid one
— so the "unbounded" window lasts exactly one tick and then self-heals into the normal 1h throttle.

Worst case bounded at ~24 retries/day while still landing the alert within an hour of the underlying
problem (a revoked token, say) being fixed.

---

## 6. Bug 6 — pidfile round-trip coverage, verified

All **four** fields now have direct assertions in `src/ops/daemon/pidfile.test.ts`:

| Field | Round-trip (`:282`) | Absent-key ⇒ default (`:225`) | Malformed ⇒ dropped |
|---|---|---|---|
| `degraded` | `:304` | `:237` (`[]`) | `:266` (missing required field ⇒ dropped) |
| `schemaDriftNotifiedAt` | `:312` | `:238` (`null`) | — |
| `schemaDriftNoNotifierWarnedAt` | `:319` | `:244` (`null`) | `:248` (`12345` ⇒ `null`) |
| `schemaDriftNotifyFailedAt` | `:320` | `:245` (`null`) | `:248` (`{not:'a string'}` ⇒ `null`) |

The round-trip test asserts the **values survive**, which is what makes it bite against
`parsePidfile`'s explicit field list. Independently re-proven at runtime in round 2's harness for the
first three fields and in round 3's sweep for the fourth (B7 stamps and B6 reads it back).

---

## 7. Round 1 & 2 bugs — all seven CLOSED

| # | Sev | Route | Fix | Verification |
|---|---|---|---|---|
| 1 | major | ui | `shortDegradedLabel()` | Live: `Degraded — schema v8 > daemon build v7`, `font-weight: 500`, 14px, `rgb(160,74,6)` = `--attention-strong`. Matches `mockup.html:717`. |
| 2 | minor | ui | `Cause:` label, JSX only | Live text correct; `jobbunny doctor` line **byte-identical** to round 1 — the shared string untouched. |
| 3 | minor | ui | `role="status"` | Live: `getByRole('status')` resolves to the banner element. |
| 4 | major | ui | loading + error pinned, unit + e2e | 4 new tests; error test asserts the degraded≠unreachable distinction. |
| 5 | minor | be | `schemaDriftNoNotifierWarnedAt` latch | Driven: 3 ticks → 1 log; latch clears on sender-found; a genuine second episode logs again; independent of `schemaDriftNotifiedAt`. |
| 6 | minor | be | round-trip + defaults tests for both new fields | §6. |
| 7 | minor | be | `SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS` (1h) | §5. |

---

## 8. Live Drive & Interaction Sweep (cumulative)

Nothing inert was found on any Phase 0 surface across three rounds.

| Element | Observable effect |
|---|---|
| `daemon-degraded-copy-button` (mouse, round 1) | clipboard = `jobbunny serve stop && jobbunny serve start`; `Copy` → `Copied` → reverts after 2s; banner survives |
| `daemon-degraded-copy-button` (**keyboard**, round 2) | focus lands on it; `Enter` produces the same effect |
| `schedule-daemon-status-error` Retry | `/api/daemon` request count **2 → 4** across the click |
| dismiss control | **not present** — correct |

**Exploratory findings across rounds, all handled gracefully (zero crashes, zero unhandled errors):**
dead-pid + stale degraded entry; malformed `degraded` entries; a degraded entry naming a nonexistent
profile; a 900-character `degradedReason` (no horizontal scroll, `scrollHeight === innerHeight`);
rapid 150ms navigation across five routes (banner count stays exactly 1); four `degradedReason`
shapes the `shortDegradedLabel()` regex does not anticipate (fallback holds, 0 page errors).

---

## 9. Computed-style & accessibility diff (round 1, unchanged since)

41 computed-property rows differed between mockup and app across the 7 paired regions; **all 41
resolve to mockup scaffolding**, none to implementation drift — system-ui vs `Geist Variable`, hex vs
Tailwind v4 oklab for the same tokens, the mockup attaching `schedule-daemon-status` to its whole
demo panel, and an off-scale 6px inline radius where the app uses the declared `rounded-md`. The
accessibility tree matched node for node apart from the deliberately-absent dismiss button and the
`role="status"` gap that became Bug 3 and is now closed.

---

## 10. Required Doc Corrections (stale artifacts — will mislead Phase 1 if left)

These are **not** code bugs. The code is correct; the documents are stale.

| Artifact | What is stale | Correct state |
|---|---|---|
| `mockup.html:694` | Renders a dismiss `<button aria-label="Dismiss for this session">` on the degraded banner | The banner is **undismissible** (`d7a23ee`). The schema-drift alert fires once per daemon lifetime, so a dismissible banner plus an already-consumed notification leaves a degraded daemon invisible — the exact silent outage D2 exists to remove. Remove the button from the mockup. |
| `ux-notes.md` §5 S4 | The phrase *"Persistent, dismissible-per-session only"* | Contradicts this same document's §6 state table (*"banner clears itself, no manual dismiss"*), §7 Cuts (*"the condition is not dismissible"*) and §10 scorecard (*"degraded is undismissible"*). Strike the single stale phrase. |
| `blueprint.md` §1 wired-action note | Specifies a dismiss target (local `dismissed` `useState`, `getByRole('button', { name: 'Dismiss for this session' })`) | Followed the stale mockup. Remove the note. |
| `blueprint.md` §1 vs §4 step 0.5 | §1's table says `schedule-daemon-status-degraded` renders `"Degraded — schema vN > vM"`; §4 step 0.5 says render `entry.degradedReason` **verbatim** | Self-contradiction; it produced Bug 1. **§1 and the mockup won.** Correct §4 step 0.5's done-condition to the shipped `shortDegradedLabel()` form. |

---

## 11. Deferred

None. No bug was deferred at any point; all seven were fixed.

---

## 12. Residual Risk

Green means "no known bugs", never "no bugs". Round 2 found a bug adjacent to round 1's fix, and
round 3 was commissioned to look for a third — it found none, but that is evidence of a bounded
sweep, not of correctness.

1. **The real end-to-end D2 event has never been observed.** Every degraded-state verification across
   all three rounds used a **synthetic pidfile**, a stubbed `/api/daemon`, or a directly-driven
   function. No daemon process has detected a real v8 database and written that entry itself, because
   Phase 0 ships no migration that could produce one. **This remains the riskiest unverified
   assumption**, and `blueprint-be.md` §2 already names its resolution: Phase 1's own v7→v8 migration
   is the first live proof. It is also precisely why the post-merge restart in §13 is mandatory.
2. **The T6 Telegram alert has never actually been sent.** `notify` was a fake in every test and every
   harness. Alert *text* and *dispatch logic* are pinned; *delivery* is not verified end to end. The
   1h retry throttle (Bug 7's fix) governs a branch no one has exercised against a real endpoint.
3. **Single profile, single OS for the UI.** The live board drive used `rajni` on darwin only.
   Multi-profile sender selection is driven but synthetic; the 3-OS matrix is CI-only.
4. **`serve start`'s real wiring is unrehearsed.** `buildDaemonDeps` forwarding is pinned by
   `serve.test.ts:385/400`, but no daemon was started — correctly, per the workspace constraints.
5. **The sweep covers the schema-drift flow, not the whole daemon.** Pre-existing per-tick paths
   outside that flow (intents, owed-slot spawning, the heartbeat) were not audited for this bug class;
   they are unchanged by Phase 0.

---

## 13. Verdict

**GREEN — zero open bugs.** Seven bugs found across three rounds, seven closed and re-verified. No
severity was downgraded to reach this; no bug was deferred.

**PR not yet raised — blocked on one decision, not on quality.** The base branch `main-stable` exists
only locally; `git ls-remote --heads origin` shows `main`, `main-db`, `main-everything-db`,
`main-ui-cli`, `main-v2` — no `main-stable`. It carries 2 commits not on `origin/main` (`6e1ec14`
product artifacts, `c91d705` a CLAUDE.md carve-out correction). Opening a PR with base `main-stable`
therefore requires first creating that branch on the shared remote — a branching-topology decision
with branch-protection consequences (CLAUDE.md makes `main` the protected landing target), and one
that would push two never-reviewed commits to a new remote branch. That is the user's call, not QA's.
See the return message for the exact command awaiting approval.

**Post-merge requirement (`blueprint-be.md` step 0.10), non-optional:**

> After merge, run `jobbunny serve stop && jobbunny serve start` at least once before Phase 1 (the
> schema migration) is merged. Phase 1's own step 1.0 will not proceed without this.
</content>
