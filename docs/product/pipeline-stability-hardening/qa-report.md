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

---
---

# QA Report — Pipeline Stability Hardening, **Phase 1**

Author: product-qa, 2026-08-14 · Round: **1**
Verdict: **RED — 7 open bugs** (4 major, 3 minor). PR not raised.

---

## P1.1 Scope Digest

| Item | Value |
|---|---|
| Repo / worktree | `/Users/harishamutha/jb-wt-stable` |
| Branch | `feat/pipeline-stability-phase1` (34 commits ahead of `main-stable`) |
| HEAD verified | `d4951ac` — *"fix: whole-plan fix wave — daemon catch-up dedup, notify-storm guards, migration golden fixtures"* |
| Artifacts | `spec.md`, `ux-notes.md`, `mockup.html`, `blueprint-be.md` (steps 1.0–1.18), `blueprint.md` (steps 1.1–1.9) |
| Scope verified | **Phase 1** = v7→v8 migration, D1 gate, D1b catch-up, D3 dedup, D3b deferred visibility |
| Phase 0 | spot-checked only: `src/ops/daemon/alert/` and `DaemonDegradedBanner.tsx` are **untouched** by this branch; its 3 QA rounds stand |
| Live drive | board from the worktree on port **1995**, `JOBBUNNY_HOME=/Users/harishamutha/jb-rehearsal` (real-data throwaway, v8, 30 runs). Server stopped after the drive. `~/.jobbunny/`, `/Users/harishamutha/Job-bunny` and the live daemon were never touched. |
| Daemon drives | the **real** `createDaemon` tick loop with instrumented `DaemonDeps` — `<scratch>/sweep1.mts`, `sweep2.mts`, `sweep3.mts` |

`LATEST_SCHEMA_VERSION` = **8** (`migrations.ts:16`). Migration **idempotent**: three consecutive
`openJobsDb` calls against the already-v8 582MB rehearsal DB leave `user_version` at 8, no error,
<1ms each. `deferred_slots` carries `UNIQUE(run_date, slot)`; `runs.catchup_slots_json` present.

---

## P1.2 Gate Results

| Gate | Result | Exit | Counts |
|---|---|---|---|
| `npm run check` | **PASS** | 0 | tests **1979**, pass 1979, fail 0 (9 suites, 8.33s) |
| `npm run ui:check` | **PASS** | 0 | 77 files, **743** tests passed (8.72s) |
| `npm run ui:build` | **PASS** | 0 | built in 260ms (chunk-size warning only) |
| `npm run ui:e2e` | **PASS** | 0 | **74** passed (11.0s) |

All four green **while all seven bugs were open.** The gates decided nothing; the artifacts and the
driven behaviour did.

Logs: `<scratch>/gate-check.log`, `gate-ui-check.log`, `gate-ui-build.log`, `gate-ui-e2e.log`.

---

## P1.3 The class sweep — every per-tick branch, driven

The class: *a fix that silently reproduces the failure it was built to eliminate* — an unbounded
per-tick repeat, or a signal that goes nowhere. Every branch below was **driven** over ≥5 real ticks
with counted side effects, never read.

| # | Branch | Reached when | Side effects / tick | Bounded by | Driven result |
|---|---|---|---|---|---|
| **B0** | steady state | nothing owed, nothing expired | heartbeat write only | by design | 6 ticks → probe 0, notify 0, recordDeferral 0, spawn 0 |
| **B1** | gate: suspend decline | tick gap > 120s, slot owed | 1 log + 1 pidfile write per owed entry | the gap itself — next tick's gap is 30s | 6 ticks → `gate-declined` **1**, then spawns normally |
| **B2** | gate: unreachable decline | probe false, slot owed in grace | 1 log + 1 pidfile write per owed entry + 1 DNS probe | the 90-min grace window (≤180/slot) | 190 ticks → **190** logs, **190** probes, ledger **0** |
| **B3** | AC4 recovery | decline then probe passes | — | one tick | decline → 0 spawn / 0 ledger; next tick → 1 spawn, 1 ledger |
| **B4** | deferred sweep `recordDeferral` | any expired-unserved candidate | 1 sqlite open + `INSERT OR IGNORE` per candidate | **nothing** — re-derived every tick all day | 8 ticks/1 slot → **8 calls, 1 row**; 60 ticks/5 slots → **300 calls, 5 rows** (≈14,400 calls/day) |
| **B5** | T4 send, delivery OK | first tick with candidates | 1 notify + 1 `markNotified` | `deferred_slots.notifiedAt` | 11 ticks → notify **1**, then inert |
| **B6** | **T4 send, delivery FAILING** | notify resolves false | **1 Telegram call per tick** | **NOTHING** | 12 ticks → **12 notify calls** (≈2,880/day) — **BUG 2** |
| **B7** | `deferred-rows-missing` | `recordDeferral` write fails | **1 warn log per tick per profile** | **NOTHING** | 10 ticks → **10 warns**, notify **0** all day — **BUG 6** |
| **B8** | catch-up spawn | candidates, gate clear, unledgered | 1 pidfile write + 1 spawn | ledger + `hasCatchupRun` | 11 ticks → spawnCatchup **1** |
| **B9** | catch-up gate-declined | candidates + gate declined | **1 log per tick** | **NOTHING** (not grace-bounded) | 240 ticks → **240** logs (≈2,880/day) — **BUG 7**; ledger stays **0**, spawns on clear |
| **B10** | catch-up already fired | ledgered or `hasCatchupRun` | none — `continue` | ledger + `runs` table | 12 ticks post-catch-up → 0 notify, 0 spawn |
| **B11** | retrospective, delivery OK | past date, rows unnotified | 1 notify + 1 `markNotified` per date | `notifiedAt` | 6 ticks → notify **1**, then inert |
| **B12** | **retrospective, delivery FAILING** | notify resolves false | **1 Telegram call per stale date per tick** | **NOTHING** | 3 dates × 12 ticks → **36 notify calls** — **BUG 2** |
| **B13** | retrospective, catch-up ran | `hasCatchupRun(pastDate)` | `markNotified` only | one-shot | 5 ticks → notify **0**, rows marked |

**Verdict of the sweep: the class recurred — three times (B6/B12, B7, B9).** B6/B12 is the exact
shape Phase 0 closed as its own Bug 7 with a 1-hour retry interval; no equivalent bound exists here.

**Correctly unbounded, recorded so a future reviewer does not misfile them:** B2's per-decline log
(R7 asks for it, and the grace window caps it at ~180/slot) and the per-tick heartbeat (D22, its
purpose is to repeat).

---

## P1.4 The two opposite ledger rules — both levels, driven

| Level | Rule | Driven |
|---|---|---|
| Owed slot (R3/AC3) | gate decline leaves **NO** ledger entry, slot stays owed | 6 declined ticks → `attempts` **empty**; next passing tick → 1 entry + 1 spawn |
| Catch-up (R8a) | success leaves **ONE** ledger entry, so it cannot re-trigger | after spawn → `attempts: [{slot:'catchup'}]`; +10 ticks → spawnCatchup stays **1** |
| Catch-up **gate** (task 12's inversion fix) | a gated catch-up leaves **NO** entry | 6 gate-declined ticks → ledger **0**, spawnCatchup **0**; gate clears → spawnCatchup **1** |
| AC13 failed catch-up | not retried | spawnCatchup → exit 1, then 12 ticks → spawnCatchup stays **1** |

All four hold. The inversion task 12 caught has not regressed.

---

## P1.5 Traceability Matrix

### D1 — the gate

| Req | MoSCoW | Verdict | Evidence |
|---|---|---|---|
| R1 suspend detected from `lastTickAt` | Must | **delivered** | `wasHostSuspended(gap > 120s)`; B1 driven |
| R2 bounded reachability probe before spawn | Must | **delivered** | `probe.ts` `Promise.race` @2500ms; B2 driven; also covers the catch-up-only tick |
| R3 gate before the ledger append | Must | **delivered** | P1.4 row 1 |
| R4 `node:` builtins only | Must | **delivered** | `node:dns/promises` only; `dependencies` unchanged (4) |
| R5 no darwin-only API | Must | **delivered** | pure arithmetic + `node:dns`; 3-OS matrix is CI |
| R6 no change to `src/pipeline/runner/` | Must | **delivered** | only `run.test.ts` +3 (a fake-store `hasRunOfKind` stub); no production runner file touched |
| R7 each gate decision logged | Should | **delivered** | `gate-declined` with `reasonCode`; 190/190 ticks |

### D1b — catch-up

| Req | Verdict | Evidence |
|---|---|---|
| R8 one per day, fires when ANY slot deferred | **delivered** | AC9 + AC10 driven |
| R8a ledgered once | **delivered** | P1.4 |
| R8b failed catch-up not retried | **delivered** | AC13 driven |
| R9 never a burst | **delivered** | 5 candidates → spawnCatchup **1** |
| R10 identifiable in board + digest | **delivered** | live: badge `Catch-up`, `Stood in for 5 slots`, `Covered slots: 09:00, 11:30, 14:00, 16:30, 19:00`; T5 label line in `formatDigest` |
| R11 stop from the board | **cut — approved** | `catchup-banner-stop` absent; variant 2b ships; 4 unit tests pin the absence |

### D3 — dedup

| Req | Verdict | Evidence |
|---|---|---|
| R17 first failure notifies immediately | **delivered** | driven: `send` at t0 |
| R18 same signature suppressed, 1 reminder/day with count | **delivered** | driven 0/1/2/3/6/12/23h → suppress; 24h → `remind` count 8; 48h → `remind` |
| R19 different signature always breaks through | **delivered** | the six real `farm` incident texts collapse to ONE signature (elapsed-ms → `<N>`); a DNS-failure `farm` text → `send` immediately. A stage-only signature would have merged them |
| R20 success digests never suppressed | **delivered** | `run.ts:310-320` — `passed` takes the plain-digest branch, never `sendFailureDigest` |
| R21 deferred slots do not page individually | **delivered** | one T4 for 5 slots |

### D3b — deferred visibility

| Req | Verdict | Evidence |
|---|---|---|
| R22 non-failure status, never a failure | **delivered** | dashed chroma-free group, no badge; day line reads `0 failed` |
| R23 required human-readable reason | **DRIFTED** | reason text present, but the canonical scenario emits `daemon-unavailable` / *"the scheduler was not running"* instead of the spec's own `host asleep` — **BUG 1** |
| R24 one entry per slot, not one per tick | **delivered** | B4: 300 calls → 5 rows |
| R25 gated-then-succeeded shows only the run | **delivered** | 10 declined ticks then a run → spawn 1, deferred rows **0** |

### Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC1 suspend gap, owed slot → no spawn | delivered | B1 |
| AC2 reachable, no gap → spawns | delivered | B0/B1 tail |
| AC3 gated slot leaves no ledger entry | delivered | P1.4 |
| AC4 decline then pass costs one tick | delivered | B3 |
| AC5 unreachable on an awake host → network reason | delivered | driven: `network-unreachable` recorded |
| AC6 `node:` only, deps unchanged | delivered | `['@notionhq/client','dotenv','playwright','zod']` |
| AC7 no darwin-only call | delivered | 3-OS matrix is CI-only — see Residual Risk |
| AC8 no `src/pipeline/runner/` file touched | delivered (with note) | only a test fake's conformance stub |
| AC9 five missed → exactly 1 catch-up | delivered | 11 ticks → 1 |
| AC10 partial day → exactly 1 catch-up | delivered | 09:00+11:30 served, 3 deferred → 1 |
| AC11 catch-up distinguishable + states the count | delivered | board + T5 |
| AC12 no second catch-up all day | delivered | +10 ticks → 1 |
| AC13 failed catch-up not retried | delivered | 12 ticks → 1 |
| AC14/AC15 (Phase 0) | out of scope | untouched by this branch |
| AC16 N identical failures → exactly 2 msgs/24h | delivered | 10 failures/48h → send + remind + remind |
| AC17 different signature sends immediately | delivered | R19 above |
| AC18 success sent while a signature is suppressed | delivered | R20 above |
| AC19 five entries, reason text, zero `failed` | **drifted** | five entries render, each non-empty — but with the wrong reason (BUG 1) and the wrong text form (BUG 4) |
| AC20 gated ×10 then ran → one entry, the run | delivered | R25 above |
| AC21 `npm run check` green incl. boundaries | delivered | exit 0, 1979/1979 |

### Mockup state inventory (Phase 1 states only)

| State | Shipped | Pinned by |
|---|---|---|
| `runs-day-reassurance` | yes | `RunsPage.test.tsx:464,479` |
| `run-row-catchup` (+badge, subline) | yes | `RunsList.test.tsx:409,426` (positive **and** negative) |
| `deferred-group` (+header/reason/toggle) | yes, **misplaced** (BUG 3) | `DeferredGroup.test.tsx` ×7; `pipeline-stability.spec.ts:28` |
| `deferred-slot-entry/-time/-reason` 1–5 | yes, **wrong text form** (BUG 4) | `DeferredGroup.test.tsx:35,51`; e2e |
| deferred group — loading (1 skeleton, never 5) | yes | `RunsPage.test.tsx:520` |
| deferred group — error (scoped retry) | yes | `RunsPage.test.tsx:533` |
| `catchup-banner` + `-label`/`-standin`/`-why`/`-progress` | yes | `LiveRunHeader.test.tsx`; `pipeline-stability.spec.ts:152` |
| `catchup-banner-eta` (estimate present) | yes | e2e `:152`; `RunsPage.test.tsx:572` |
| `catchup-banner-eta` (null → elapsed-only) | yes | e2e `:175`; `RunsPage.test.tsx:598` |
| `catchup-banner-stop-unavailable` (2b) | yes | `RunsPage.test.tsx:594,636` |
| `catchup-banner-stop` (2a) | **deliberately absent** | 4 negative assertions in `LiveRunHeader.test.tsx` |
| `run-detail-catchup-badge` / `-covered-slots` | yes | `RunDetailView.test.tsx:358-389`; e2e `:214` |
| T1–T6 message shapes | yes (pure composers) | `deferred_day.test.ts`, `failure_notice.test.ts`, `digest.test.ts` |

**No Phase 1 mockup state is unpinned.** `data-qa` is **additive everywhere** — no `data-testid` was
removed or replaced by this branch (`git diff main-stable...HEAD -- ui/src` shows no removed
`data-testid`).

---

## P1.6 Live drive — extraction first

App (`127.0.0.1:1995/#/runs`, `rajni`, 5 seeded deferred rows + a catch-up run) vs mockup, both at
1440×900. Computed-style diff over 18 properties × 8 paired regions:

| Region | Matched | Residual diffs |
|---|---|---|
| `deferred-group` | 16/18 | inherited `fontSize`/`lineHeight` on the container (children set their own) |
| `deferred-group-header` | 14/18 | same inherited pair + Tailwind preflight `border-style: solid` at 0 width |
| `deferred-group-reason` | 16/18 | preflight border only |
| `deferred-slot-entry-1` | 13/18 | preflight border + `gap` (mockup uses flex, app uses inline spans) |
| `deferred-slot-time-1` | 16/18 | preflight border only |
| `deferred-slot-reason-1` | 16/18 | preflight border only — **but the TEXT differs, BUG 4** |
| `deferred-group-toggle` | 9/18 | shadcn `AccordionTrigger` padding/radius — blueprint §6 divergence 2, approved |
| `runs-day-reassurance` | 13/18 | container padding + preflight border; **text matches the mockup format exactly** |

No computed-style row resolves to unintended visual drift. Aria snapshot of the group matches the
mockup node-for-node except: the app's `CirclePause` is `aria-hidden` (ux-notes §9 requires this —
the app is *more* correct than the mockup) and Radix wraps the trigger in an `h3`.

Screenshots read: `<scratch>/app-runs.png`, `app-deferred-group.png`, `mockup-deferred-group.png`,
`app-catchup-banner.png`, `app-run-row-catchup.png`, `app-deferred-collapsed.png`.

**Catch-up banner, live:** `Catch-up run — starting…` / `Standing in for 5 missed slots (09:00,
11:30, 14:00, 16:30, 19:00)` / `Chrome is open because Job Bunny is catching up on today's missed
slots.` / `~21 min left` / `Runs to completion — about 21 min left.` — line-for-line ux-notes §5 S2.
ETA source: `estimateRunDuration()` median of ≤10 eligible runs, `null` below 3 samples; live API
returned `estimatedDurationMs: 1715943`. Overdue case (95 min elapsed vs 28 min estimate) renders
`~0 min left` — clamped, never negative.

---

## P1.7 Interaction sweep

| Element | Observable effect | Verdict |
|---|---|---|
| `deferred-group-toggle` (mouse) | visible entries 5 → 0 → 5; `qa` node count 24 → 9 | **DELTA** |
| `deferred-group-toggle` (**keyboard**, Enter) | entries restored to 5 | **DELTA** |
| `run-row-catchup` | selects the run; detail pane renders `Catch-up` badge + `Covered slots: …` | **DELTA** (NO-DELTA on the first click only because it is already the default selection) |
| another `run-row` | detail pane switches run | **DELTA** |
| `catchup-banner-stop` | not present — **correct**, R11 cut | n/a |
| `Refresh` | refetches; identical data ⇒ identical DOM (pre-existing element, not Phase 1) | see NOTES |

**Nothing inert on any Phase 1 surface.**

Exploratory (time-boxed, weighted to the riskiest assumption and the deferred/catch-up surfaces):
6 rapid `#/settings`↔`#/runs` round trips → exactly 1 deferred group, 5 entries, 0 page errors;
10 rapid toggle clicks in 400ms → consistent state, 1 group; deferred-slots API fuzzed with
`not-a-date`, empty, `2026-13-45`, `'--`, `../../etc/passwd`, duplicate params → **400 with a clean
validation body**, unknown profile → 404, zero 500s, zero crashes.

---

## P1.8 Bug List

### BUG 1 — the canonical lid-closed day reports the wrong reason · **major** · route-to: **be**

**Violates** `spec.md` §9 Completion moment (*"one message saying Job Bunny deferred today's slots
**because the host was asleep** … five `deferred — host asleep` rows"*), R23's own reason vocabulary,
and `mockup.html`'s `tg-deferred-day` + `deferred-group` copy.

**Repro (driven, `<scratch>/sweep3.mts` H2 — the spec's own worked example):** lid closed before
09:00, five slots `09:00/11:30/14:00/16:30/19:00`, grace 90, host wakes at **20:12**.
**Observed:** every deferred row is `daemon-unavailable`; T4 reads *"Job Bunny declined to start 5
runs because the scheduler was not running during today's scheduled window."*
**Expected:** `host-asleep` / *"because the host was asleep and could not reach the network."*

**Mechanism:** `runDeferredSweepAndCatchup` attributes the reason from the **stale pidfile
`lastGateDecline`**, gated on `declineAt <= graceEndAt` (`deferred_sweep.ts:85-98`) — but a decline
for a slot that is already a deferral candidate necessarily lands *after* that slot's grace closed,
so the window test can never pass in the lid-closed case. The **live `gate` decision is already a
parameter of this function** and is used only for the spawn guard, never for attribution.
`<scratch>/sweep3.mts` H1 shows `host-asleep` is reachable only via a narrow
wake-inside-grace-then-sleep-again path.

**Why it matters:** *"the scheduler was not running"* is the operator-facing description of **D2**.
The feature exists so the operator's first hypothesis is right; this makes it wrong in the opposite
direction.

### BUG 2 — unbounded per-tick T4 / retrospective notify retry · **major** · route-to: **be**

**Violates** `spec.md` §1 Goal (b) (*"never … receive a storm of identical alerts"*) and §13
(*"At most 2 notifications per 24h for any single ongoing failure"*). This is the ninth-through-tenth
instance of the package's own defect class; Phase 0 closed the identical shape with
`SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS` (1h).

**Repro:** `<scratch>/sweep1.mts` G9 — 5 expired slots, `notify` resolves `false`, 12 ticks →
**12 Telegram calls**. `<scratch>/sweep2.mts` R6 — 3 unnotified past dates, 12 ticks → **36 calls**.
At the 30s tick that is **~2,880 attempts/day/date**, with no latch and no interval bound
(`deferred_sweep.ts:153-154` and `:242-252`).

**Why it is not an edge case:** T4 fires precisely when the gate declined for
`network-unreachable` — the send failing is the *expected* co-morbid state, not a rare one.
**Escalation path:** `markNotified` is fail-soft and swallows its errors, so a notify that *succeeds*
while the DB write fails delivers ~2,880 **real** messages/day.

### BUG 3 — the deferred group renders below the entire runs list · **major** · route-to: **ui**

**Violates** `blueprint.md` §2 item 5's own stated order (*"matching S1's documented order: catch-up
row, then deferred group, then older runs"*), `ux-notes.md` §5 S1 items 3–5, and `mockup.html`'s S1
DOM order (`:451` reassurance → `:454` catch-up row → `:464` deferred group).

**Repro:** `#/runs` with 30 runs and 5 deferred slots. **Observed** (`<scratch>/app-runs.png`): the
group sits after **all 29 older run rows**, off-screen on first paint. **Expected:** immediately
below the catch-up row.

`RunsPage.tsx:245-268` renders `<RunsList/>` then `<DeferredGroup/>` as a following sibling.
The blueprint's claim that this is *"functionally identical vertical order"* is false whenever more
than one run exists — which is every real day. It defeats ux-notes callout 6 (the catch-up row and
the deferred group must read as one adjacent unit) and the spec's completion moment.

### BUG 4 — each deferred entry renders the full sentence, not the short label · **major** · route-to: **ui**

**Violates** `ux-notes.md` §5 S1 (*"each `09:00 · host asleep`"*) and `mockup.html`'s own
`deferred-slot-reason-N` content (`host asleep`).

**Repro / evidence** — computed-style extraction, same viewport:
`TEXT-APP | deferred-slot-reason-1 | Job Bunny declined to start this run because the host was asleep.`
`TEXT-MOCKUP | deferred-slot-reason-1 | host asleep`
Visual: `<scratch>/app-deferred-group.png` (five **two-line** sentences) vs
`<scratch>/mockup-deferred-group.png` (five **one-line** labels).

`DeferredGroup.tsx:142` renders `row.reason`; the short label already exists in the same file as
`REASON_CODE_WORD` and is used for the header. The result repeats the group's own reason sentence
five times — precisely the "five alarms" scan ux-notes callouts 2 and 3 say the grouping exists to
kill. **Doc conflict:** `blueprint.md:117` prescribed the `reason` string; the mockup and ux-notes
win.

### BUG 5 — multiple T4 messages per day, later ones falsely promising a catch-up · **minor** · route-to: **be**

**Violates** `ux-notes.md` §4 T4 (*"Fires **once**"*), §7 (*"Notifications received … Designed: 2"*),
`spec.md` §13.

**Repro:** `<scratch>/sweep2.mts` R4 — intermittent connectivity: 09:00 defers, network returns,
T4 #1 sent and the day's one catch-up spawns; 14:00 later defers unserved → its new row has
`notifiedAt` null → `t4AlreadySentToday` flips false → **T4 #2**. Observed `notify=2, catchup=1`.
T4 #2 closes with *"Catch-up run starting now — digest to follow."* although
`alreadyLedgeredToday`/`hasCatchupRun` guarantee no further catch-up that day.

`catchupFired: true` is hard-coded at `deferred_sweep.ts:145` rather than derived from whether a
catch-up will actually spawn — and the `tg-deferred-day-no-catchup` variant, which exists for exactly
this case, is never used on the same-day path.

### BUG 6 — a deferred-write failure logs every tick and loses the day silently · **minor** · route-to: **be**

**Violates** the D2 principle the package exists to enforce (`spec.md` R13/R15: *"not a per-tick log
line"*) and `blueprint-be.md` step 1.11a's own rationale (*"that day produces no message at all — a
silently lost day, exactly the failure mode this entire feature exists to eliminate"*).

**Repro:** `<scratch>/sweep1.mts` G10 — `recordDeferral` no-ops (the fail-soft store's documented
degraded mode), 10 ticks → **10 `deferred-rows-missing` warns** (≈2,880/day, unlatched), **notify 0**
for the entire day, and `spawnCatchup` fires with `standingInFor: []`. The retrospective backstop
cannot recover it, because it keys on rows that were never written.

### BUG 7 — the catch-up's `gate-declined` log has no bound · **minor** · route-to: **be**

**Violates** the same D2 principle. Unlike the owed-entry decline (capped at ~180/slot by the 90-min
grace), this one is bounded only by the gate clearing or the day ending.

**Repro:** `<scratch>/sweep3.mts` H3 — awake host, network unreachable, 240 ticks after grace closed
→ **240 `gate-declined` lines and 240 DNS probes** (≈2,880 each per day). Baseline for the original
D2 defect was 75 lines in 2 hours. The probe retry is necessary; the unlatched log line is not.

---

## P1.9 Doc corrections (stale artifacts — not code bugs)

| Artifact | Stale | Correct state |
|---|---|---|
| `mockup.html:694` | dismiss button on the degraded banner | deliberately unimplemented (Phase 0) — remove |
| `ux-notes.md` §5 S4 | *"dismissible-per-session only"* | contradicts §6/§7/§10 of the same doc — strike |
| `blueprint.md` §1 vs §4 step 0.5 | contradict on the Schedule degraded line | §1 + mockup won |
| `ux-notes.md` §2 / mockup variant 2a | `catchup-banner-stop` | **R11 is out of scope** — routing a daemon-spawned run through `run_intents` is not built. Variant 2b ships. Mark 2a as cut, not missing. |
| `blueprint.md` §2 item 5 | *"functionally identical vertical order"* | false with >1 run — see BUG 3 |
| `blueprint.md:117` | maps `deferred-slot-reason-{n}` to the `reason` string | contradicts the mockup's short label — see BUG 4 |
| `blueprint-be.md` step 1.11.4 | pseudocode calls `markNotified` unconditionally | shipped code gates it on `sent` (deliberate, better) — but neither form is bounded; see BUG 2 |

---

## P1.10 Deferred

**None.** No bug was deferred; only the USER may defer one.

---

## P1.11 Residual Risk

Green would have meant "no known bugs"; this round is red, and even a later green will not mean "no
bugs".

1. **The riskiest assumption in the spec remains unverified.** §9: *"that the suspend-gap detector
   and the reachability probe **together** catch the DarkWake case."* Every drive here used a
   synthetic `lastTickAt` gap and an injected probe. **No real lid-closed cycle has been observed**,
   and BUG 1 is direct evidence that the synthetic and real paths diverge in what they record.
2. **No daemon process has ever executed this code.** `serve start`'s wiring is pinned by unit tests;
   the tick loop was driven in-process with fakes. The rehearsal DB proved the migration, not the
   daemon.
3. **No Telegram message has ever actually been sent** — `notify` was a fake in every drive. BUG 2
   governs a branch no one has exercised against a real endpoint.
4. **Single profile, single OS.** `rajni` on darwin; the 3-OS matrix is CI-only (AC7).
5. **The sweep covers the Phase 1 daemon paths**, not pre-existing per-tick paths (intents, owed-slot
   spawning) — unchanged by Phase 1 and not audited here.
6. **`SUSPECTED_SUSPEND_GAP_MS = 120_000` is a judgment call**, flagged as tunable by
   `blueprint-be.md` §9 and untested against a real DarkWake gap.
7. **Alternating failure signatures defeat dedup by design.** An A/B/A/B flap sends on every run
   (driven: send → suppress → send → suppress → send), because `decideNotification` keeps exactly one
   signature. R19 demands the break-through, so this is spec-compliant — and still a plausible route
   back to a noisy phone.

---

## P1.12 Verdict

**RED — 7 open bugs** (BUG 1–4 major, BUG 5–7 minor). No severity was downgraded and nothing was
deferred. **PR not raised**, per the zero-open-bugs bar.

The four gates were green throughout. All seven bugs were found by driving the artifacts against the
running system — three of them are fresh instances of the package's own recurring defect class.

---

# QA Report — Phase 1, **Round 2** (re-verification at `fc385bd`)

Author: product-qa, 2026-08-14 · Round: **2**
Verdict: **RED — 3 open bugs** (1 critical, 1 major, 1 minor). PR not raised.
Fix commits under test: `e35cfb3` (backend 1/2/5/6/7), `fc385bd` (UI 3/4).

Round 1's seven are **five fixed, one partially fixed, one fixed-but-regressing**. The re-sweep found
the **eleventh instance of the package's defect class** — this time not an unbounded repeat but its
mirror image: a bound applied to the wrong thing.

---

## R2.1 Gate Results (at `fc385bd`)

| Gate | Result | Exit | Counts |
|---|---|---|---|
| `npm run check` | **PASS** | 0 | tests **2003**, pass 2003, fail 0 (9 suites, 8.33s) |
| `npm run ui:check` | **PASS** | 0 | 77 files, **744** tests passed (8.26s) |
| `npm run ui:build` | **PASS** | 0 | built in 244ms |
| `npm run ui:e2e` | **PASS** | 0 | **74** passed (10.8s) |

Round 1 → 2: 1979 → **2003** node tests (+24), 743 → **744** vitest, 74 → 74 e2e.
**All four green while a critical bug was open.** Logs: `<scratch>/r2-gate-*.log`.

---

## R2.2 Class re-sweep — the NEW per-tick state

| # | Branch | Round 1 | Round 2 | Bounded by | Verdict |
|---|---|---|---|---|---|
| N1 | T4 notify, permanently failing | 12 calls / 12 ticks | **2 calls / 200 ticks (100 min)** | `deferredNotifyAttempts` + 1h interval | **closed** |
| N2 | notify OK + `markNotified` silently fails | would be 20/20 | **1 message / 20 ticks**; 2 after +65 min | interval only, deliberately not cleared on send-success | **closed** |
| N3 | `deferred-rows-missing` warn | 10 / 10 ticks | **2 / 200 ticks**, and the day now **emits a message** rebuilt from in-memory candidates | same 1h throttle | **closed** |
| N4 | catch-up `gate-declined` log | 240 / 240 ticks | **2 / 240 ticks** | `CatchupGateCache` + `fresh` flag | **closed** |
| N5 | DNS probes on catch-up-only ticks | 240 / 240 ticks | **2 / 240 ticks** | same cache | **closed — but see BUG 8** |
| N6 | daemon restart mid-throttle | n/a | probes **+1**, `gate-declined` **+1**, exactly once | cache is in-process, not persisted | **correct** |
| N7 | `slotGateDeclines` growth | new | **5 entries, flat across 30 days** | `.filter(d => d.date === date)` on every write | **pruned** |
| N8 | `deferredNotifyAttempts` growth | new | **1 → 22 entries over 30 days, never pruned by date** | only exact `(profile,date)` de-dup | **BUG 9** |
| N9 | `recordDeferral` per tick | 240 / 240 | **240 / 240** (unchanged, rows still 1) | idempotent `INSERT OR IGNORE` — R24 holds | by design |

**The class recurred (BUG 8).** Bug 7's fix throttles the *observation* (log + probe) and the
*action* (may the catch-up spawn?) with one cached value. Suppressing a log line for an hour is
correct; suppressing the day's recovery run for an hour is the defect this feature exists to prevent.

---

## R2.3 Verdicts on all seven round-1 bugs

| # | Round-1 defect | Verdict | Evidence |
|---|---|---|---|
| **1** | canonical day reported `daemon-unavailable` | **FIXED** | R2.4 below — both paths |
| **2** | unbounded T4 / retrospective notify retry | **FIXED** | N1, N2 |
| **3** | deferred group below the whole runs list | **PARTIALLY FIXED — STILL OPEN** | R2.6 |
| **4** | entries rendered the full sentence | **FIXED** | R2.6 |
| **5** | multi-T4 falsely promising a catch-up | **FIXED** | `hasCatchupRun=false` → *"Catch-up run starting now…"*; `=true` → *"Next scheduled slot: …"* |
| **6** | write-failure warn storm + silently lost day | **FIXED** | N3 |
| **7** | unbounded catch-up `gate-declined` log | **FIXED (goal)** — **introduced BUG 8** | N4, N5, N6 |

---

## R2.4 BUG 1 — verified on both paths

**Path A — the spec's own 20:12 worked example**, driven end to end (lid closed from 08:30, wake at
20:12). Rows: `09:00=host-asleep, 11:30=host-asleep, 14:00=host-asleep, 16:30=host-asleep`.
Actual T4:

```
⏸️ Job Bunny — alpha (2026-07-27)
────────────────
Today's runs were deferred. Nothing failed.

Job Bunny declined to start 4 runs because the host
was asleep and could not reach the network.

  • 09:00 — deferred (host asleep)
  • 11:30 — deferred (host asleep)
  • 14:00 — deferred (host asleep)
  • 16:30 — deferred (host asleep)

No job data was scraped today.
Catch-up run starting now — digest to follow.
```

Byte-identical in shape to `mockup.html`'s `tg-deferred-day`. `spec.md` §9's completion moment now
holds.

**Path B — awake + offline** still reads `network-unreachable` (per-slot record wins over the live
gate).

**Path C — the retrospective past-day sweep never consults the live gate.** Driven: a
`host-asleep` row dated 2026-07-26, then a **healthy** 2026-07-27 (gate open, nothing declined).
The past-day summary still reports `• 09:00 — deferred (host asleep)` and closes with the
no-catchup variant. Structurally guaranteed too: `runRetrospectiveDeferredSweep` composes from the
stored `r.reasonCode` and never calls `attributeReason`, and `deriveExpiredUnserved` only ever emits
today's candidates, so `attributeReason`'s live-gate fallback can only apply to same-tick slots.

---

## R2.5 BUG 8 — the catch-up gate cache blocks the catch-up itself · **critical** · route-to: **be**

**Violates** `spec.md` R8 / **AC9** (*"exactly one catch-up run is started after wake — asserted as a
count of 1"*), **AC4** (*"a transient decline costs ~30 seconds, not the slot"*), and the feature's own
goal (a) (*"never lose a day of job data without knowing why"*).

`computeCatchupOnlyGate` (`gate/reachability_gate.ts:58-86`) caches a **declined** decision for
`CATCHUP_GATE_RETRY_INTERVAL_MS = 1h` and returns `gate: { declined: true }` on a cache hit.
`deferred_sweep.ts`'s `if (gate.declined) … continue;` then blocks the spawn for that whole hour.
The `fresh` flag already suppresses the log line correctly — the cached *decision* is the part that
should not have been reused.

**Worst case: the cache is populated by the suspend-gap branch**, a condition that is by definition
already over on the next tick (the host is awake — that is why the tick fired).

| Driven scenario | Round 1 (`d4951ac`) | Round 2 (`fc385bd`) |
|---|---|---|
| **R-A** lid closed all day, wake 20:45 | catch-up spawns at **20:45:30** (one tick) | catch-up spawns at **21:46 — 61 minutes late** |
| **R-C** lid closed all day, wake **23:30** | catch-up spawns at 23:30:30 | **catch-up NEVER runs — count 0.** The 1h cache expires at 00:30, by which time the calendar day has rolled over; `deriveExpiredUnserved` only evaluates `today`, so the day's slots are no longer candidates |
| **R-D** transient probe failure, network back 30s later | spawns on the next tick | **still blocked at +15 min**, and no further probe is issued for an hour |
| **R-E** cache vs a next-day owed tick | n/a | mixed ticks bypass the cache but never clear it; a >24h-old cache does expire by interval |

**R-C is the whole defect, reinstated.** T4 has already said *"Catch-up run starting now — digest to
follow."*, `markNotified` has stamped the rows, so `listUnnotifiedDatesBefore` never returns that
date and the retrospective backstop is disarmed too. The day is lost, silently, after a message that
promised otherwise — face 2 of the class.

The regression is invisible to the suite: `npm run check` is 2003/2003 green, and the sweep's own
AC9/AC10 regression rows dropped from `spawnCatchup=1` to `spawnCatchup=0` without a single test
noticing. **AC9 and AC10 have no test asserting the spawn count under a suspend-declined first tick.**

---

## R2.6 BUG 3 — still open: the order is now inverted the other way · **major** · route-to: **ui**

The reported half is fixed: the group is no longer below 29 rows; it renders at **y = 93**, above
the fold on first paint. But it is now placed above **everything**, including the catch-up row.

Driven DOM order with 30 runs present:

```
observed : runs-day-reassurance, deferred-group, run-row-catchup, run-row, run-row …
required : runs-day-reassurance, run-row-catchup, deferred-group, older runs …
```

**Violates** `ux-notes.md` §5 S1's numbered order (3 = catch-up row, 4 = deferred group),
`mockup.html`'s S1 DOM order (`:451` → `:454` → `:464`), and `blueprint.md` §2 item 5's own stated
order. It also inverts **ux-notes callout 6** — the one callout that says it *"changed the whole
screen's hierarchy"*: *"On a lid-closed day the one visually distinct element must **not** be the
deferrals. It is the catch-up run that succeeded… the deferred group reads as the footnote."*
Evidence `<scratch>/r2-app-runs-top.png`: the eye lands on **"5 slots deferred · host asleep"**, and
the green *"Stood in for 5 slots"* row sits below it.

A correct fix inserts the group **after the first row**, which needs `RunsList` to accept a slot /
render-prop — the blast radius `blueprint.md` §2 item 5 tried to avoid.

**BUG 4 — FIXED.** Entries now read `09:00 · host asleep`, byte-identical to the mockup
(`deferred-slot-reason-1`: app `host asleep`, mockup `host asleep`; 10/11 computed properties match,
the eleventh being Tailwind preflight `border-style: solid` at 0 width). All **five** entries render,
none empty — AC19 holds. Interaction re-swept with a **varied** walk (keyboard first): `Space` → 0
visible, `Enter` → 5, mouse → 0, mouse → 5; group count stays 1 after scrolling the column to the
bottom; zero console errors, zero page errors.

---

## R2.7 BUG 9 — `deferredNotifyAttempts` is never pruned · **minor** · route-to: **be**

**Violates** the pidfile's own documented self-pruning discipline (`daemon.ts`'s A9 rule: *"prune to
only today's entries on every write … the pidfile itself never accumulates yesterday's entries"*),
which `slotGateDeclines`' own doc comment cites and follows.

`stampNotifyAttempt` (`deferred_sweep.ts:110-121`) filters only
`!(a.profile === profile && a.date === date)` — an exact-pair de-dup, not a date prune. Driven over
**30 simulated calendar days** (weekday schedule, deferrals every day):

```
day  1 | slotGateDeclines=5  deferredNotifyAttempts=1
day 10 | slotGateDeclines=5  deferredNotifyAttempts=8
day 20 | slotGateDeclines=5  deferredNotifyAttempts=14
day 30 | slotGateDeclines=5  deferredNotifyAttempts=22
pidfile JSON after 30 days = 2,977 bytes — read and rewritten on every 30s tick
```

`slotGateDeclines` is correctly flat at 5. `deferredNotifyAttempts` grows one entry per
(profile, day-with-deferrals) forever — ~260 entries/profile/year on a daily-deferral pattern,
cleared only by `serve start`.

**The obvious fix is wrong:** pruning to `date === today` would destroy the retrospective sweep's own
throttle for **past** dates and reopen BUG 2 on that path. The correct prune is by **`at` age**
(drop entries older than the retry interval by a margin), not by `date`.

---

## R2.8 Judgment requested — `catchupFired: true` while the catch-up is gate-declined

**Ruling: acceptable as originally scoped — and currently a defect only because BUG 8 broke the
premise it was priced on.** Not filed as a separate bug.

`blueprint-be.md` §9 already resolved this explicitly: *"the operator already received T4's 'Catch-up
run starting now' line even though the actual spawn may be delayed by a few ticks. This mirrors AC4's
own 'transient decline costs ~30s, not the slot' tolerance and is judged acceptable — flagged, not
silently smoothed over."* An artifact-level acceptance at **~30 seconds** is a reasonable one: no
operator distinguishes "now" from "half a minute from now", and inventing new copy for a state the
mockup never designed would be scope creep.

**But that acceptance is priced in ticks, not hours.** Driven under BUG 8 the same line precedes a
**61-minute** wait (R-A) or a catch-up that **never happens** (R-C). *"Starting now"* followed by an
hour of nothing is a different claim from the one the blueprint accepted.

**Therefore:** no change needed here *provided BUG 8's fix restores a ~one-tick delay*. If the fix
leaves any multi-tick gap between T4 and the spawn, this must be reopened — the honest options then
are to send T4 **after** the spawn decision, or to add the missing copy variant.

---

## R2.9 Doc corrections — recorded so they are not re-litigated

| Artifact | Clause | Correction |
|---|---|---|
| `blueprint.md` §2 item 5 | *"functionally identical vertical order"* for `<RunsList/>` + `<DeferredGroup/>` as siblings | **False** with more than one run — proven twice now (below-everything, then above-everything). The required order is `catch-up row → deferred group → older runs`; achieving it needs `RunsList` to expose an insertion slot. Caused BUG 3. |
| `blueprint.md:117` | maps `deferred-slot-reason-{1..5}` to *"`reason` string, or `"reason unavailable"` fallback"* | **Wrong.** Entries render `REASON_CODE_WORD[reasonCode]` (`host asleep` / `network unreachable` / `daemon unavailable`), never the raw `reason` sentence — per `ux-notes.md` §5 S1 and the mockup. Caused BUG 4. |
| `blueprint.md:117` / `ux-notes.md` §11 item 4 | R23's per-entry `"reason unavailable"` fallback | **Moot.** `reasonCode` is a required three-value enum (`ports/deferred_slots.ts`), so the label can never be blank; the fallback is unreachable for the entry label. Keep it only if a raw-`reason` display is ever reintroduced. |
| `mockup.html:694` | dismiss button on the degraded banner | deliberately unimplemented (Phase 0) — remove |
| `ux-notes.md` §5 S4 | *"dismissible-per-session only"* | stale; contradicts §6/§7/§10 of the same doc — strike |
| `blueprint.md` §1 vs §4 step 0.5 | contradict on the Schedule degraded line | §1 + mockup won |
| `ux-notes.md` §2 / mockup variant 2a | `catchup-banner-stop` | R11 out of scope — variant 2b ships; mark 2a **cut**, not missing |
| `blueprint-be.md` §9 | *"delayed by a few ticks … judged acceptable"* | Still the ruling — but state the bound explicitly (**≤ 2 ticks**), so a future cache/throttle cannot silently widen it. See R2.8. |

---

## R2.10 Residual Risk (round 2)

1. **The riskiest assumption is still unverified** — no real lid-closed cycle has been observed. BUG 8
   is the second time in two rounds that the canonical scenario behaved differently from what the
   code read like.
2. **No daemon process has executed this code, and no Telegram message has been sent** — `notify` was
   a fake in every drive.
3. **AC9/AC10 have no test that asserts the spawn count under a suspend-declined first tick** — the
   exact hole BUG 8 slipped through, with 2003 green tests. Any fix must add that assertion.
4. **`CATCHUP_GATE_RETRY_INTERVAL_MS` and `DEFERRED_NOTIFY_RETRY_INTERVAL_MS` are both 1h judgment
   calls**, untested against real conditions; BUG 8 shows an interval chosen for one purpose being
   load-bearing for another.
5. Single profile, single OS (darwin); the 3-OS matrix is CI-only. Alternating failure signatures
   still defeat dedup by design (R19 demands it).

---

## R2.11 Verdict

**RED — 3 open bugs.** BUG 8 (critical, be), BUG 3 (major, ui, partially fixed), BUG 9 (minor, be).
Five of round 1's seven are closed and independently re-driven. No severity was downgraded; nothing
was deferred. **PR not raised.**

---

# QA Report — Phase 1, **Round 3** (re-verification at `c6b2298`)

Author: product-qa, 2026-08-14 · Round: **3**
Verdict: **RED — 1 open bug** (major). PR not raised.
Fix commit under test: `c6b2298` *"fix: throttle the log, never the catch-up itself"* (bugs 8, 3, 9).

Round 2's three are **all fixed and independently re-driven**. One new defect was found by the
targeted accessibility probe — the twelfth instance of this package's signature shape: **a fix that
is correct on every axis a gate can measure, and wrong on the one it cannot.**

---

## R3.1 Gate Results (at `c6b2298`)

| Gate | Result | Exit | Counts |
|---|---|---|---|
| `npm run check` | **PASS** | 0 | tests **2015**, pass 2015, fail 0 (9 suites, 8.28s) |
| `npm run ui:check` | **PASS** | 0 | 77 files, **745** tests passed (8.68s) |
| `npm run ui:build` | **PASS** | 0 | built in 307ms |
| `npm run ui:e2e` | **PASS** | 0 | **74** passed (11.2s) |

Across rounds: 1979 → 2003 → **2015** node; 743 → 744 → **745** vitest; 74 → 74 → 74 e2e.
Logs: `<scratch>/r3-gate-*.log`.

---

## R3.2 BUG 8 — the three defining scenarios, spawn and log asserted **separately**

The coupling *was* the bug, so each is now measured independently.

| Scenario | Round 2 (`fc385bd`) | Round 3 (`c6b2298`) | Verdict |
|---|---|---|---|
| **S1** lid closed all day, wake **20:45** | catch-up at **21:46** (61 min late) | decline logged at 20:45 (`spawn=0, logs=1`), **catch-up spawns at 20:45:30**; +6 further ticks keep `spawn=1` | **FIXED**, AC9 = 1 |
| **S2** lid closed all day, wake **23:30** | **spawn 0 — day lost** | `spawn=0, logs=1` at 23:30; **catch-up spawns at 23:30:30**; still 1 the next day | **FIXED**, day covered |
| **S3** 30-second probe blip | still blocked at +15 min, no re-probe for an hour | offline tick `spawn=0, logs=1, probes=1`; **+30s online → `spawn=1`, `logs=1`, `probes=2`** | **FIXED**, AC4 met |

**Independence proven** (item 1a): 240 catch-up-only ticks over 2h, permanently offline →
**DNS probes = 240** (the decision is recomputed every single tick, `probes == ticks`) while
**`gate-declined` logs = 2** (~1/hour). The observation is throttled; the action never is.

**Item 1b — a changed `reasonCode` resets the log immediately.** 10 ticks of
`network-unreachable` → 1 log; then a `host-asleep` tick **inside** the same 1h window → logs
**2** (+1), not suppressed as a duplicate.

**Item 1c — the cache clears the instant the gate reopens.** 5 offline ticks → 1 log; one healthy
tick; 3 more offline ticks → logs back to 1 for the new episode.

---

## R3.3 BUG 9 — age prune, including the failure mode QA warned about

`DEFERRED_NOTIFY_ATTEMPT_MAX_AGE_MS = 24h`, pruned by the entry's own `at`, never by `date`.

| Check | Result |
|---|---|
| 40h-old entry (`2026-07-10`) | **pruned** |
| 12h-old entry (`2026-07-20`) | kept |
| **30-min-old PAST-date entry** (`2026-07-26`) | **kept, and not restamped** — the retrospective throttle for that date stayed armed and its notify was correctly skipped this tick |
| Growth over **30 simulated days** | `deferredNotifyAttempts` **22 → 2**; `slotGateDeclines` still flat at 5 |
| Pidfile JSON after 30 days | **2,977 → 1,537 bytes** |

The failure mode this report warned about when rejecting a date-based prune — destroying the
retrospective throttle for past dates and reopening BUG 2 there — **does not occur**.

---

## R3.4 BUG 3 — order, both cases

**With a catch-up run (30 runs present):** DOM order is
`runs-day-reassurance → run-row-catchup → deferred-group → older runs (28 more)`, asserted by index,
not by eye. Group at **y = 206**, above the fold. Five individually-rendered entries (AC19).
Row identity is resolved by `catchupSlots != null && date === today`, never positionally.

**No catch-up that day (fallback):** 0 catch-up rows; order is
`runs-day-reassurance → deferred-group → run-row …`; the group renders **outside** the listbox and
the listbox has **0 non-option children**. Five entries, short labels.

**BUG 4 holds:** entries read `09:00 · host asleep` … `19:00 · host asleep` in both cases.

**Order is correct. See BUG 10 for the cost of how it was achieved.**

---

## R3.5 BUG 10 — the deferred group is a non-`option` child of `role="listbox"` · **major** · route-to: **ui**

**Violates `ux-notes.md` §9 verbatim:**

> *"the deferred group is a single focusable disclosure (`accordion`), not five `role="option"`
> entries — **it must not enter the runs listbox**, or arrow-key navigation would step through
> non-runs."*

`RunsList.tsx:289` renders `{insertAfterId === row.id && insertContent}` **inside**
`<div role="listbox" aria-label="Runs">` (`:199`), between `role="option"` rows.

**Driven evidence.** The listbox has **31 children: 30 `role="option"` + 1 role-less `<div>`.**
The computed accessibility tree of the listbox:

```
- listbox "Runs":
  - option "15 Aug 2026 2:15 AM … Catch-up Stood in for 5 slots …" [selected]
  - text: 5 slots deferred host asleep —
  - paragraph: Job Bunny declined to start these runs because the host was asleep.
  - region "Details": 09:00 · host asleep 11:30 · host asleep …
  - heading "Details" [level=3]:
    - button "Details" [expanded]
  - option "Yesterday 7:00 PM …"
  …
```

`text`, `paragraph`, `region` and `heading` are not permitted owned elements of `listbox`
(ARIA 1.2 requires `option`, or `group` containing `option`). Consequences: any AT computing set
size announces a 31-item "Runs" list that contains 30 runs; AT that prunes disallowed children
instead drops the deferred group from the virtual cursor entirely — **the day's explanation becomes
invisible to a screen-reader user**, which is this package's own "signal that goes nowhere" shape.
A `heading level=3` is now emitted inside a list widget, so heading navigation lands mid-listbox,
and a focusable `BUTTON[deferred-group-toggle]` is an interactive descendant of a composite widget.

**Stated honestly — what is NOT broken.** Driven: tab order stays linear and sane
(`option[run-row-catchup] → BUTTON[deferred-group-toggle] → option[run 29] → option[run 28] …`);
the group is fully reachable and operable by keyboard (`Enter` toggles entries 5 → 0 → 5); zero
console errors. The specific harm ux-notes predicted — *"arrow-key navigation would step through
non-runs"* — **does not manifest**, because this list implements no arrow-key navigation at all
(rows are `tabIndex={0}` with Enter/Space handlers only; driven: `ArrowDown` leaves focus unchanged).
The clause is still violated, and the ARIA-tree damage is real and independent of the rationale
ux-notes happened to give for it.

**Why this is filed rather than noted.** The artifact says X ("must not enter the runs listbox"); the
app does Y. The same commit's own **fallback path proves the group can render outside the listbox
with zero ARIA damage** (0 non-option children, order still correct) — so satisfying both the visual
order and §9 is achievable, not a forced trade. No gate here can see it: 2015 + 745 + 74 tests are
green over an invalid accessibility tree.

**Note for the fix:** the previous placement satisfied §9 and broke visual order; this one satisfies
visual order and breaks §9. A correct fix satisfies both — e.g. two adjacent listboxes (rows before
the insertion point, rows after) with the group between them, or keeping the group a sibling and
achieving the order without nesting it inside the composite widget. That is a design call, which is
why it routes to **ui** rather than being prescribed here.

---

## R3.6 Item 5 — my round-2 judgment, measured

I accepted `catchupFired: true` while the catch-up is gate-declined **conditional on BUG 8's fix
restoring a ~one-tick delay**, with a proposed bound of **≤ 2 ticks**.

**Measured, S1 (canonical wake):** T4 sent at `20:45:00`, catch-up spawned at `20:45:30` —
**one tick, 30 seconds.** S2 (23:30 wake) and S3 (probe blip) also spawn on the very next tick.

**The condition is met. My judgment stands: not a defect.** `blueprint-be.md` §9's acceptance
("delayed by a few ticks … mirrors AC4's own 'transient decline costs ~30s' tolerance") is priced
correctly again. The proposed **≤ 2-tick** bound is recorded in R2.9 so a future throttle cannot
silently widen it.

---

## R3.7 Regression — nothing else moved

| Check | Result |
|---|---|
| BUG 1 path A (20:12 example) | all rows `host-asleep`; T4: *"…because the host was asleep and could not reach the network."* |
| BUG 1 path B (awake+offline) | `network-unreachable` |
| BUG 1 path C (retrospective, healthy today) | still `• 09:00 — deferred (host asleep)` — never borrows today's gate |
| BUG 2 (notify always fails, 200 ticks) | **2** calls |
| BUG 2 escalation (send OK, `markNotified` fails, 20 ticks) | **1** real message — non-clearing holds |
| BUG 5 | `hasCatchupRun=false` → *"Catch-up run starting now…"*; `=true` → *"Next scheduled slot: …"* |
| BUG 6 (write fails, 200 ticks) | **2** warns, **2** notifies — the day still speaks |
| R3/AC3 ledger while gated | **0**; slot still owed |
| R8a catch-up ledger | exactly one `{slot:'catchup'}` entry |
| AC9 / AC10 / AC12 / AC13 | spawnCatchup **1** in every case, incl. 30 ticks after the catch-up |
| AC20 / R25 | gated ×10 then ran → spawn 1, deferred rows `[]` |
| Migration idempotency | 3× `openJobsDb` on the v8 rehearsal DB → `user_version` 8, no error, ≤1ms |
| `LATEST_SCHEMA_VERSION` | **8** |
| AC6 runtime deps | `['@notionhq/client','dotenv','playwright','zod']` — unchanged |
| AC8 `src/pipeline/runner/` | only `run.test.ts` +3 (fake-store conformance stub) |

---

## R3.8 Class sweep — the standing across all three rounds

| Face of the class | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| Unbounded per-tick repeat | 3 found (BUG 2, 6, 7) | all closed; throttles measured at 2/200 and 2/240 ticks | still closed |
| A bound applied to the wrong thing | — | **BUG 8** (log throttle also gated the spawn) | closed; probes 240/240 vs logs 2/240 proves separation |
| A signal that goes nowhere | BUG 1 (wrong reason), BUG 6 (silent day) | closed | **BUG 10** — the deferred group may be pruned from the AT tree entirely |
| Unbounded persistent state | — | **BUG 9** (`deferredNotifyAttempts`) | closed; 22 → 2 entries over 30 days |

**Twelve instances across the package. Every single one was green on every gate when found.**

---

## R3.9 Residual Risk

1. **The riskiest assumption is still unverified** — no real lid-closed cycle, no real daemon
   process, no real Telegram send. Three rounds of synthetic drives.
2. **No gate in this repo checks ARIA.** BUG 10 was found only because it was looked for by hand;
   there is no axe/a11y assertion in `ui:check` or `ui:e2e`, so the next structural violation will be
   just as invisible. Recommend an a11y assertion on the runs listbox as part of BUG 10's fix.
3. **AC9/AC10 still have no test asserting the spawn count under a suspend-declined first tick** —
   the hole BUG 8 slipped through. `daemon_gate.test.ts` gained 134 lines this round; the assertion
   should be confirmed present before the next fix wave.
4. Single profile, single OS (darwin); the 3-OS matrix is CI-only. Both 1h intervals remain
   judgment calls. Alternating failure signatures still defeat dedup by design (R19 demands it).

---

## R3.10 Verdict

**RED — 1 open bug.** BUG 10 (major, route-to: **ui**). Round 2's BUG 8, BUG 3 and BUG 9 are closed
and independently re-driven; nine of the ten defects found across three rounds are fixed. No severity
was downgraded; nothing was deferred. **PR not raised.**

---

# QA Report — Phase 1, **Round 4 / FINAL** (re-verification at `3baeea3`)

Author: product-qa, 2026-08-14 · Round: **4**
Verdict: **GREEN — zero open bugs.** PR raised.
Fix commit under test: `3baeea3` *"fix(ui): keep the deferred group out of the runs listbox"* (bug 10).

---

## R4.1 Gate Results (at `3baeea3`)

| Gate | Result | Exit | Counts |
|---|---|---|---|
| `npm run check` | **PASS** | 0 | tests **2015**, pass 2015, fail 0 (9 suites, 8.24s) |
| `npm run ui:check` | **PASS** | 0 | 78 files, **754** tests passed (8.54s) |
| `npm run ui:build` | **PASS** | 0 | built in 244ms |
| `npm run ui:e2e` | **PASS** | 0 | **74** passed (11.0s) |

Across four rounds: 1979 → 2003 → 2015 → **2015** node; 743 → 744 → 745 → **754** vitest; 74 e2e throughout.

---

## R4.2 BUG 10 — FIXED, and what the split introduced: nothing

`RunsList` now splits into two sibling listboxes around the insertion point. Driven live, both branches:

**Branch A — catch-up ran today (30 runs):**

| Listbox | Children | `role="option"` | non-option children | focusable non-option descendants |
|---|---|---|---|---|
| `"Runs"` | 1 | 1 | **0** | **0** |
| `"Earlier runs"` | 29 | 29 | **0** | **0** |

`deferredGroupIsListboxDescendant: false` — the group is outside both, not merely not-a-direct-child.
Total `role="option"` on the page: **30** (unchanged). Round 3's invalid tree is gone: no `text`,
`paragraph`, `region`, `heading` or `button` inside any listbox.

**Branch B — no catch-up (degrade path):** collapses to **exactly one** listbox `"Runs"`, 30
children / 30 options / **0** non-option, group outside it, no orphaned content, 0 catch-up rows.

**Set size and position.** No `aria-setsize`/`aria-posinset` is authored anywhere, so each listbox's
size is computed from its own contents — a screen reader meets *"Runs, 1 item"*, then the deferred
group as ordinary content, then *"Earlier runs, 29 items"*. Each announcement is **accurate for the
list it describes**; nothing claims a size it does not have. The cost is one extra list boundary to
traverse, which is what buys the valid tree.

**Naming.** `"Runs"` / `"Earlier runs"` reads sensibly and does not mislead: the split point is the
matched catch-up row, so everything in the second list is genuinely earlier. Minor observation
recorded in NOTES, not a defect — `"Runs"` on a list that currently holds one row is momentarily
thin, and `"Today's runs"` would read better; no artifact constrains either label.

**Selection integrity across the split** — the failure a two-listbox split most plausibly introduces.
Driven: clicking a row in `"Earlier runs"` swaps the detail pane; clicking the catch-up row swaps it
back; **`aria-selected="true"` count across both listboxes is exactly 1** at all times.

**Everything else held.** Order `reassurance → run-row-catchup → deferred-group → 28 older runs`
(asserted by index); five entries, all `HH:MM · host asleep`; toggle keyboard-operable in both
branches (Enter: 5 → 0 → 5); tab order sane
(`option[run-row-catchup] → BUTTON[deferred-group-toggle] → option[run 29] → …`); zero console and
zero page errors in either branch.

**The fix also closed part of R3.9's residual risk.** It shipped **standing-guard tests** —
`RunsList.test.tsx` now pins *"every `role="listbox"` contains ONLY `role="option"` children"* for the
inserted, plain and **no-matching-`insertAfterId`** cases, plus not-a-descendant, distinct non-empty
accessible names, and document order; `RunsPage.a11y.test.tsx` (new) pins both branches end to end.
The invariant BUG 10 violated is now mechanically enforced, not just fixed.

---

## R4.3 Final regression — all ten prior bugs, re-driven at `3baeea3`

| Check | Result |
|---|---|
| BUG 1 path A (20:12 example) | all rows `host-asleep`; T4: *"…because the host was asleep and could not reach the network."* |
| BUG 1 path B (awake + offline) | `network-unreachable` |
| BUG 1 path C (retrospective, healthy today) | still `• 09:00 — deferred (host asleep)` |
| BUG 2 (notify fails, 200 ticks) | **2** calls |
| BUG 2 escalation (send OK, `markNotified` fails, 20 ticks) | **1** real message — non-clearing holds |
| BUG 3 order | `reassurance → catch-up → deferred group → older runs` |
| BUG 4 entry labels | `09:00 · host asleep` … ×5 |
| BUG 5 | `hasCatchupRun=false` → *"Catch-up run starting now…"*; `=true` → *"Next scheduled slot: …"* |
| BUG 6 (write fails, 200 ticks) | **2** warns, **2** notifies — the day still speaks |
| BUG 7 / BUG 8 | 240 ticks → **240 probes, 2 logs**; wake 20:45 → spawn at 20:45:30; wake 23:30 → spawn at 23:30:30; 30s blip → spawn next tick |
| BUG 9 | 40h entry pruned, 30-min past-date entry kept; 30 days → **2** entries, 1,537 bytes |
| BUG 10 | R4.2 |
| R3/AC3 ledger while gated | **0** — slot stays owed |
| R8a catch-up ledger | exactly one `{slot:'catchup'}` |
| AC9 / AC10 / AC12 / AC13 | `spawnCatchup` = **1** in every case, incl. 30 ticks after |
| AC20 / R25 | gated ×10 then ran → spawn 1, deferred rows `[]` |
| Dedup, both directions | six identical `farm` failures (varying elapsed-ms) → one signature, `send` then `suppress`; a genuinely different `farm` failure → `send` immediately; `+24h` → `remind` |
| Migration idempotency | 3× `openJobsDb` on the v8 rehearsal DB → `user_version` 8, no error |
| `LATEST_SCHEMA_VERSION` | **8** |
| AC6 runtime deps | `['@notionhq/client','dotenv','playwright','zod']` — unchanged |
| AC8 `src/pipeline/runner/` | only `run.test.ts` +3 (fake-store conformance stub) |
| `data-qa` additive | **zero** `data-testid` attributes removed anywhere in `ui/src` across the whole branch |
| Nothing inert | every Phase 1 control produces an observable delta (R2.6, R4.2) |

---

## R4.4 Class sweep — final standing across four rounds

| Face of the class | R1 | R2 | R3 | R4 |
|---|---|---|---|---|
| Unbounded per-tick repeat | 3 found | closed | closed | closed |
| A bound applied to the wrong thing | — | 1 found | closed | closed |
| A signal that goes nowhere | 2 found | closed | 1 found | closed |
| Unbounded persistent state | — | 1 found | closed | closed |
| Structural/ARIA invariant | — | — | 1 found | closed |

**Twelve instances across the package. Every single one was green on every gate at the moment it was
found.** That is the most transferable result of this run: in this codebase the gates establish that
the code does what it was written to do, and never that it does what the artifacts asked for.

---

## R4.5 Residual Risk

Green means "no known bugs", never "no bugs". Four rounds found ten defects; the last three rounds
each found a defect introduced by the previous round's fix.

1. **The riskiest assumption in the spec is still unverified.** §9: *"that the suspend-gap detector
   and the reachability probe together catch the DarkWake case."* Every drive used a synthetic
   `lastTickAt` gap and an injected probe. **No real lid-closed cycle has been observed.**
2. **No daemon process has ever executed this code**, and **no Telegram message has ever been sent** —
   `notify` was a fake in every harness across all four rounds. Alert *text* and *dispatch logic* are
   pinned; *delivery* is not verified end to end.
3. **The v7→v8 migration has been proven idempotent against a real-shaped v8 DB, never run forward
   from a real v7 DB by a real daemon.** This is why the post-merge restart in the PR body is
   mandatory, not advisory.
4. **Single profile, single OS.** `rajni` on darwin; the 3-OS matrix is CI-only (AC7).
5. **Both 1-hour intervals** (`DEFERRED_NOTIFY_RETRY_INTERVAL_MS`, `CATCHUP_GATE_RETRY_INTERVAL_MS`)
   and `SUSPECTED_SUSPEND_GAP_MS = 120s` remain judgment calls, untested against real conditions.
   BUG 8 was an interval chosen for one purpose becoming load-bearing for another.
6. **Alternating failure signatures still defeat dedup by design** — A/B/A/B sends every time, because
   `decideNotification` keeps exactly one signature. R19 demands the break-through, so this is
   spec-compliant and still a plausible route back to a noisy phone.
7. **Accessibility is now guarded only where it was broken.** The new standing guards cover the runs
   listbox; no other surface has an ARIA assertion, and no gate runs an a11y linter.

---

## R4.6 Deferred

**None.** No bug was deferred at any point across four rounds; all ten were fixed. No severity was
downgraded to reach green.

---

## R4.7 Verdict

**GREEN — zero open bugs.** Ten defects found across four rounds, ten closed and independently
re-driven against the artifacts. PR raised from `feat/pipeline-stability-phase1` into `main-stable`.
Merging is the user's decision.
