# Pipeline Stability Hardening — Product Spec

Slug: `pipeline-stability-hardening`
Status: ready for UX
Author: product-pm, 2026-08-13
Classification: **change-to-existing** (mature repo, settled stack — no stack question)

---

## 1. Problem & Goal

**The ask, restated as a problem.** On 2026-08-12 six consecutive pipeline runs failed with an
identical signature. The operator's first hypothesis was a bad merge. It was not: the laptop lid
was closed, the host was asleep, and the daemon kept starting runs during 2-second `DarkWake`
maintenance ticks into a machine whose network had not reassociated.

**Five whys, kept proportional to the ask:**

1. Why did the runs fail? Chrome could not resolve DNS and the stall watchdog aborted.
2. Why was Chrome running at all? The daemon's 30s tick saw a still-owed slot and spawned.
3. Why did it think the slot was runnable? `owed.ts:51` compares wall-clock times only — it has
   no concept of a host that was absent between ticks.
4. Why does that matter? Because every deadline in the system (`guard.ts:90` stall watchdog,
   `run.ts:43` run cap, per-stage `timeoutMs`) is wall-clock, and wall-clock keeps counting while
   the process is suspended.
5. **Root problem:** the pipeline uses wall-clock time as a proxy for progress. On a host that
   suspends, those two decouple — so **a run started on a suspended host cannot succeed.** That
   is deterministic, not flaky.

**The problem is not "the pipeline broke."** It is that the operator cannot distinguish
*"Job Bunny had a bad day"* from *"Job Bunny was never given a chance to run"* — and the system's
three ways of telling them the truth all failed at once: it started doomed runs (D1), it went
silently deaf after a schema bump (D2), and it reported the wreckage six times to a phone (D3).

**Goal.** The operator should never (a) lose a day of job data without knowing why, (b) receive a
storm of identical alerts, or (c) suffer a silent daemon outage after a schema change.

---

## 2. Persona & JTBD

Persona: **P1 "The Operator-Owner"** — see `docs/product/personas.md` v1.2. Sole user and sole
developer of a personal job-search tool. Two hats; the operator hat is worn only under duress and
always as an interruption.

Confirmed this run: **the Telegram digest is the primary discovery channel; the board is the
drill-down surface opened afterwards.** Two consequences bind this spec — alert quality is
load-bearing rather than cosmetic, and the board is optimised for arriving-from-an-alert, not for
at-a-glance monitoring.

**Canonical job statement (JTBD):**

> When my laptop has been closed through the day's schedule, I want to find out from one message
> whether Job Bunny actually ran and why not — so that a lost day costs me a glance at my phone
> instead of an evening in the logs.

Directly served: **JTBD-3** ("when a run fails or comes back empty, I want to know what broke and
what to do about it without opening a terminal"). The incident is JTBD-3's worst case: six alerts
that were all wrong about the cause, and a board that showed five red failures for a day in which
nothing was ever actually attempted.

---

## 3. Industry Research

One research pass, reused downstream by product-ux. Findings that changed this spec:

| Pattern | Finding | Source |
|---|---|---|
| Missed-slot policy is first-class | systemd `Persistent=true` records the last trigger and re-fires once if a slot was missed during downtime; `WakeSystem=true` resumes the host to run it | [systemd.timer(5)](https://manpages.ubuntu.com/manpages/bionic/man5/systemd.timer.5.html) |
| Coalescing is the norm, not bursting | launchd `StartCalendarInterval` runs on wake and **coalesces** multiple missed slots into one execution | [Apple, Scheduling Jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html) |
| Catch-up is a deliberate choice | Quartz exposes `MISFIRE_INSTRUCTION_FIRE_NOW` (once, immediately) vs `IGNORE_MISFIRE_POLICY` (all missed instances) vs `RESCHEDULE_NEXT_*` (skip) | [Quartz misfire instructions](https://nurkiewicz.com/2012/04/quartz-scheduler-misfire-instructions.html) |
| Grace windows are standard | APScheduler `misfire_grace_time` + `coalesce=true` — Job Bunny's `graceMinutes: 90` is the same idea, but with no policy for what happens when it expires | [APScheduler](https://apscheduler.readthedocs.io/en/3.x/userguide.html) |
| Suspend detection is a timer gap | Compare wall-clock delta to monotonic delta; a large gap means the host slept. Node has no built-in monotonic clock API, so the heartbeat-gap pattern is the standard userspace workaround | [node-posix-clock](https://github.com/avz/node-posix-clock), [emscripten#16453](https://github.com/emscripten-core/emscripten/issues/16453) |
| Readiness ≠ liveness | k8s separates "process alive" from "safe to send work to"; typical probe timeout 2–3s, cheapest check that answers the question | [Kubernetes probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/) |
| Storm control = dedup + reminder | Alertmanager deduplicates by fingerprint and re-notifies on `repeat_interval` (default 4h) so a still-firing alert never goes permanently quiet | [Prometheus alerting config](https://prometheus.io/docs/alerting/latest/configuration/) |
| "Did not run" is named everywhere | GitHub Actions `skipped`; Airflow `skipped` / `deferred` / `up_for_reschedule`; Jenkins `NOT_BUILT` | [GitHub](https://docs.github.com/en/pull-requests/reference/status-checks), [Airflow](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html) |

**Synthesis.** Every mature scheduler treats *"the slot passed while we were down"* as a named
state with an explicit policy. Job Bunny already has the grace window but has **no misfire policy
and no vocabulary for the outcome** — the slot simply evaporates or, worse, produces a doomed run.
That absence is precisely what D1 and D3 jointly describe. Note that catch-up behaviour is
genuinely contested across the industry (launchd coalesces, systemd fires once, Quartz makes you
choose), so there was no default to inherit — hence it was asked, not assumed.

---

## 4. Classification

**Change to existing.** Evidence: an existing daemon with its own supervision state
(`src/ops/daemon/pidfile.ts:30-36`), an existing schedule core (`src/core/schedule/owed.ts`), an
existing notifier port (`src/ports/notifier.ts:7-10`), an existing board with runs and schedule
surfaces. Stack is settled and out of scope for discussion.

---

## 5. Current State

| Area | How it behaves today | Evidence |
|---|---|---|
| Slot eligibility | Pure wall-clock comparison; no concept of host absence | `src/core/schedule/owed.ts:51` |
| Daemon tick | Every 30s; writes `lastTickAt` heartbeat first, before anything else | `src/ops/daemon/daemon.ts:39`, `:271-276` |
| Pre-spawn guards | Two exist and both `continue` without spawning: grace revalidation (`slot-expired-skipped`) and ledger-failure | `src/ops/daemon/daemon.ts:216-226`, `:249-259` |
| Attempts ledger | Appended **before** spawn, deliberately, so a crash still counts the slot as attempted | `src/ops/daemon/daemon.ts:228-242` |
| Connectivity checks | None anywhere in the run path. The only probe is CDP-on-localhost, and it runs *after* the daemon already spawned | `src/adapters/browser/cdp-chrome/provider.ts:210-212` |
| Failure recovery | `farm` sets `retries: 0`; `--resume` is opt-in, so a failed scheduled run never auto-resumes | `src/pipeline/stages/farm.ts:71`, `src/cli/commands/run.ts:236` |
| Notification | Digest sent unconditionally, once per run, on both outcomes. No dedup, no rate limit, no last-sent state | `src/cli/commands/run.ts:308-312` |
| Run status vocabulary | `'running' \| 'passed' \| 'failed' \| 'crashed'` — nothing meaning "not attempted" | `src/ports/run_store.ts:7` |
| Schema drift | Fail-loud error, re-thrown, **no degrade path** — the daemon logged it 75 times in 2 hours and kept ticking uselessly | `src/adapters/db/sqlite/store/migrations.ts:155-178` |

**Assets this feature can lean on.** `lastTickAt` is already a deliberate heartbeat by design
(`pidfile.ts:1-13`: *"a heartbeat (lastTickAt, D22) instead of an age check"*), so reading its gap
as a suspend detector is a use the design anticipated. And the daemon already owns skip vocabulary
and a pre-spawn guard-clause shape — the new gate is an insertion into an existing pattern, not
new machinery.

---

## 6. Gaps

- **G1 — The daemon starts runs the host cannot finish.** No suspend awareness, no reachability
  check before spawn. Deterministic failure, not intermittent.
- **G2 — A slot that never ran is indistinguishable from a slot that ran and failed.** Today it
  shows as red `failed`. There is no status for "not attempted".
- **G3 — A day can be lost entirely with nothing to show for it.** All five slots can expire their
  90-minute grace while asleep; nothing runs and nothing records that.
- **G4 — Identical failures page identically and without limit.** Six pages in one night.
- **G5 — A schema bump silently disables the daemon.** Detection exists (the error is correct and
  safe), but there is no alert, no visible state, and no self-heal. **This recurs on every future
  schema bump** — it is the one defect here that is a genuine software fault independent of the lid.

---

## 7. Relevance Verdict

### The strongest case against building this (stated first)

The root cause is a **host power-management condition, not a software defect.** The lid closed;
macOS slept; everything downstream behaved exactly as designed. The condition is fully mitigated,
for free and today, by one operator action — leave the lid open during slots, or `pmset repeat
wake`. Against that, this feature proposes adding gates, a probe, a new run state, a catch-up
policy, and persistent notification state to **the daemon — the least-supervised, hardest-to-debug
component in the repo, and the one whose own failure is hardest to notice.** The evidence base is
a single day (N=1), and D3's harm was six phone notifications: annoying, not damaging. A
disciplined YAGNI reading says fix the lid and ship nothing.

### Why I still recommend building

1. **The failure is deterministic, and the triggering condition is normal laptop behaviour.** Not
   a freak event — closing a laptop lid. It will recur exactly as often as the lid closes during a
   slot, and it will fail identically every time.
2. **The host-side mitigation is unverifiable by the software and silently degrades.** Amphetamine
   *was* running and holding `PreventUserIdleSystemSleep` for 70+ hours. It did nothing, because
   that assertion does not override clamshell sleep. An invisible mitigation that fails silently is
   exactly the class of thing the operator cannot be asked to rely on.
3. **G5 is not about the lid at all.** It is a real defect, it recurs on every schema bump, and it
   caused a two-hour total scheduling outage discoverable only by reading a log file.
4. **The core fix is small and shaped like code that already exists** — a pre-spawn guard clause
   next to two others, reading a heartbeat the daemon already writes.

### Verdict: **BUILD** — with one reshape

Build D1, D2 and D3 as one coherent slice, with a reshape on the catch-up element: ship it under
the smallest defensible rule (**exactly one coalesced run per calendar day, one attempt, pass or
fail**) rather than as general misfire recovery. Catch-up is the only part that changes the
scheduler contract and the only part with no incident evidence behind it — so the bound that
matters is the *one run per day* cap, which is what protects the throttle breaker.

*Decomposition note, if the slice must shrink:* **D2 is independently shippable** (it shares no
code with the others), and **D1's gate alone is the smallest viable slice** — it is the change that
prevents the incident. D3 without D1 would make the alerts quieter but still wrong.

This is a recommendation. The orchestrator decides whether to proceed.

---

## 8. Resolved Q&A

| # | Question | Answer |
|---|---|---|
| Q1 | What does the board show for a declined slot? | **A visible row with a distinct non-failure status and a required human-readable reason** ("host asleep", "network unreachable"). The operator explicitly preferred five `deferred / host asleep` rows over today's five red `failed` rows. Outcome is specified here; the mechanism is left to the backend blueprint given the `runs`-table pipeline/runner-only invariant. |
| Q2 | What reaches Telegram on N identical failures? | **First failure immediately, then once per day while still failing.** Dedup keyed on failure signature. A *different* failure must always break through immediately. |
| Q2b | Telegram-first or board-first discovery? | **Telegram first.** The digest is the primary signal; the board is the drill-down surface. Recorded in `personas.md` v1.2. |
| Q3 | Should missed slots be made up? | **Yes — exactly one coalesced catch-up**, never a burst, bounded to the same calendar day. Full catch-up was rejected **because five back-to-back scrapes risk tripping the LinkedIn throttle breaker** — so coalescing is a hard requirement protecting a real invariant, not a preference. |
| Q3b | Does an earlier success that day suppress the catch-up? | **No.** Put to the operator as the partial-day case (09:00 and 11:30 pass, lid closes at noon, three slots defer, lid opens 20:12) and they chose to fire the catch-up. Breaker protection comes from coalescing (R9), not from this condition; suppressing here would leave ~21 hours of staleness on a day the operator was back at the machine. See the rationale under D1b. |
| D (pre-decided) | Make the stall watchdog suspend-aware? | **No.** A forgiving watchdog would not have rescued these runs (network down, CDP socket dead); it would convert a 16-minute failure into a run hanging across sleep cycles until the run cap. Highest blast radius in the repo for negative benefit. `src/pipeline/runner/` is not touched. |
| D (pre-decided) | Host-side sleep mitigation? | Out of scope as a feature; documented as operator guidance. |
| Correction | Does a gated slot stay owed? | **Only if the gate runs before the attempts-ledger append.** The original brief assumed it did; recon of `daemon.ts:228-259` showed the ledger is written *before* spawn, so a gate placed after it would silently consume the slot for its full grace window. Now an explicit acceptance criterion (AC3). |

---

## 9. Tech Story

> **As** the operator of an unattended job-search pipeline,
> **when** my laptop has been asleep across scheduled slots,
> **I want** Job Bunny to decline to start runs it cannot finish, tell me once, and show me each
> slot as *deferred with a reason* instead of *failed*,
> **so that** I know within seconds — from my phone — whether I lost a day of job data and why.

**Completion moment (what "done" looks like):** the operator opens their phone at the end of a
lid-closed day, sees **one** message saying Job Bunny deferred today's slots because the host was
asleep, opens the board, and sees five `deferred — host asleep` rows and zero red failures.

**Riskiest assumption:** that the suspend-gap detector and the reachability probe *together* catch
the DarkWake case. Neither is sufficient alone — DNS may answer during a DarkWake because
TCPKeepAlive is active, and a fully-awake host with a dead network produces no tick gap. The
assumption that their union covers the observed failure mode is untested in combination and should
be validated against a real lid-closed cycle before this is called done.

---

## 10. Content Priority

What matters most, at the requirement level (screen and visual hierarchy belong to product-ux):

1. **Don't start doomed runs.** The gate. Everything else is downstream of it.
2. **Don't consume the slot when gating.** Without this, the gate is strictly *worse* than no gate.
3. **Don't storm the phone.** Telegram is the primary channel; its signal quality is load-bearing.
4. **Make daemon deafness loud.** A silent scheduler is the most expensive failure per unit of
   operator attention, because nothing at all indicates it.
5. **Make the deferral visible and truthful.** Turns "where did today go?" into a glance.
6. **Don't lose the whole day.** Catch-up — real value, but the most contract-changing and the
   least evidenced.

---

## 11. Requirements

Source key: **ASK** = the operator's decision this run · **INC** = incident evidence ·
**PER** = persona/JTBD · **IND** = industry table-stakes · **REC** = repo recon gap/constraint

### D1 — Do not start runs the host cannot finish

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| R1 | The daemon detects that the host was suspended, by comparing now against its own `lastTickAt` heartbeat, and declines to spawn on a tick that follows a gap far exceeding the tick interval | INC, REC, IND | **Must** |
| R2 | Before spawning, the daemon runs a bounded external reachability probe and declines to spawn if it fails | ASK, IND | **Must** |
| R3 | The gate is evaluated **before** the attempts-ledger append. A declined slot is not recorded as attempted, remains owed, and is retried on the next tick within its grace window | REC (`daemon.ts:228-259`) | **Must** |
| R4 | The probe uses `node:` builtins only — no new runtime dependency | REC (3-dep cap) | **Must** |
| R5 | Suspend detection works on macOS, Windows and Linux; no darwin-only API | REC (cross-platform) | **Must** |
| R6 | No change to `src/pipeline/runner/`; the stall watchdog stays wall-clock | ASK | **Must** |
| R7 | Each gate decision is recorded in `daemon.log` with the reason and the deciding signal | PER (operator hat) | **Should** |

### D1b — Catch-up

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| R8 | At most **one** catch-up run per local calendar day. It fires when **any** slot was deferred or missed that day and has passed its grace window — **regardless of whether other slots succeeded** | ASK, IND (launchd coalescing) | **Must** |
| R8a | The catch-up run **is** recorded in the attempts ledger, as a once-per-day entry, so it fires exactly once and does not re-trigger on every subsequent 30s tick for the rest of the day | REC (`daemon.ts:228-248`, D19 respawn-storm rule) | **Must** |
| R8b | A **failed** catch-up is not retried. One catch-up per day means one attempt per day, pass or fail | ASK (derived from R8's "exactly one") | **Must** |
| R9 | A catch-up must never produce a burst. Multiple missed slots coalesce into exactly one run — this protects the LinkedIn throttle breaker from five back-to-back scrapes | ASK, REC (breaker invariant) | **Must** |
| R10 | The catch-up run is identifiable as a catch-up in both the board and its digest, stating how many slots it is standing in for | PER, ASK | **Must** |
| R11 | The operator can stop an in-progress catch-up run from the board without a terminal | PER, ASK | **Should** |

> **Implementer warning — R3 and R8a are deliberately opposite, and must stay that way.**
> A **gated slot** must leave **no** ledger entry, so that it stays owed and is retried on the next
> tick (R3/AC3). A **catch-up** must leave **one** ledger entry, so that it fires once and does not
> re-trigger every 30s for the rest of the day (R8a). These look inconsistent and are not: the
> ledger's meaning is *"an attempt was made"*, and a gate decline is precisely the case where no
> attempt was made, while a catch-up is one. An implementer who makes the two consistent will break
> whichever one they normalise — either the slot is silently consumed for its full grace window, or
> the catch-up becomes the 30s respawn storm that the D19 rule (`daemon.ts:243-248`) exists to
> prevent. Both directions are covered by acceptance criteria (AC3 and AC12).

**Why R8 has no "unless something already succeeded today" condition.** An earlier draft narrowed
the trigger that way; it was overruled deliberately. Throttle-breaker protection comes entirely
from **coalescing to a single run** (R9), which was already the decided rule — a second condition
adds nothing to breaker safety while degrading what is plausibly the *more common* scenario: an
afternoon away rather than a whole day asleep. Worked example: 09:00 and 11:30 succeed, the lid
closes at noon, 14:00/16:30/19:00 defer, the lid opens at 20:12. Under the narrowed rule nothing
fresh would arrive between noon and 09:00 the next morning — roughly **21 hours stale on a day the
operator was back at the machine at 20:12**. The operator was shown this case and chose to fire the
catch-up.

### D2 — Daemon must not go silently deaf

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| R12 | The daemon detects that its DB schema is newer than its build and treats it as a daemon-level fault, not a per-tick log line | INC, REC | **Must** |
| R13 | The condition notifies the operator **once**, not once per tick (75 log lines / 0 alerts today) | INC, PER | **Must** |
| R14 | The board's daemon status shows a degraded state with the reason and the remedy (restart the daemon) | PER, REC | **Must** |
| R15 | The daemon stops repeat-logging the same fault and holds an explicit degraded state rather than ticking as if healthy | INC | **Must** |
| R16 | `jobbunny doctor` reports the degraded daemon state | PER | **Should** |

### D3 — Truthful, non-storming notification

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| R17 | The first failure of a given signature notifies immediately | ASK, IND | **Must** |
| R18 | Subsequent failures of the **same** signature are suppressed, with one reminder per day while still failing, carrying the consecutive-failure count | ASK, IND (Alertmanager) | **Must** |
| R19 | A failure with a **different** signature always breaks through immediately and is never suppressed as a duplicate | ASK | **Must** |
| R20 | Success digests are never suppressed by failure dedup | REC (guard-rail) | **Must** |
| R21 | Deferred slots do not page individually; they are visible in the board, and the catch-up digest explains the gap | ASK, PER | **Must** |

### D3b — Deferred slot visibility

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| R22 | A slot that was never attempted is shown in the board's run history with a status distinct from `failed`, and never as a failure | ASK, IND | **Must** |
| R23 | Every deferred entry carries a required human-readable reason ("host asleep", "network unreachable"). Reason text is mandatory, not optional | ASK | **Must** |
| R24 | Repeated gate declines for the same slot within its grace window produce **one** deferred entry, not one per 30s tick | REC (derived: 90min ÷ 30s = up to 180) | **Must** |
| R25 | A deferred entry is shown only for a slot that ultimately did **not** run within its grace window — a slot that was gated and then succeeded shows only its successful run | PER (signal quality) | **Must** |

---

## 12. Acceptance Criteria

Objectively checkable. "Simulated suspend" means a synthetic `lastTickAt` gap; "simulated
unreachable" means a probe forced to fail.

1. Given a simulated tick gap far exceeding the tick interval, and an owed slot inside its grace
   window, the daemon does **not** spawn a run.
2. Given a reachable host with no tick gap and an owed slot, the daemon **does** spawn — the gate
   does not suppress normal operation.
3. **Given a gated slot, the attempts ledger contains no entry for it**, and the slot is still
   returned as owed on the next evaluation. (Prevents the failure mode where a declined slot is
   silently consumed for its full 90-minute grace window, making the gate worse than no gate.)
4. Given a gate decline followed by a passing probe on the next tick, the run starts, and total
   delay is one tick interval — a transient decline costs ~30 seconds, not the slot.
5. Given a simulated unreachable network on an awake host, the daemon does not spawn, and the
   recorded reason is network-related rather than suspend-related.
6. The reachability probe imports only `node:` builtins; `package.json` runtime dependencies are
   unchanged.
7. Suspend detection contains no darwin-only call and its tests pass on the 3-OS CI matrix.
8. `git diff` for the change touches no file under `src/pipeline/runner/`.
9. Given a day in which five slots were missed entirely, exactly **one** catch-up run is started
   after wake — asserted as a count of 1, not 5.
10. **Given a day in which some slots succeeded and others deferred past their grace window**
    (e.g. 09:00 and 11:30 pass, 14:00/16:30/19:00 defer, host wakes at 20:12), exactly **one**
    catch-up run is started. Earlier success on the same day does not suppress it.
11. A catch-up run is distinguishable from a scheduled run in both the board and its digest, and
    states the number of slots it stands in for.
12. **Given a catch-up has already fired today, no further catch-up starts for the rest of that
    local day, across arbitrarily many subsequent ticks** — asserted by advancing the clock over
    many tick intervals after a catch-up and asserting the spawn count stays at 1. (Guards the D19
    respawn-storm rule: without a ledger entry the catch-up would re-trigger every 30s.)
13. **Given a catch-up run that fails, no second catch-up is started that day.** One per day means
    one attempt per day, pass or fail.
14. Given a DB schema newer than the daemon's build, the daemon emits exactly **one** notification
    and does not repeat the same log line on every subsequent tick (contrast: 75 occurrences).
15. In that state, the board's daemon status reads degraded, names the cause, and names the remedy.
16. Given N consecutive failures with an identical signature within 24h, the notifier sends exactly
    **two** messages: the first failure and one daily reminder carrying the count. (Contrast: 6.)
17. **Given a failure whose signature differs from the currently-suppressed one, a notification is
    sent immediately** — verified by a test that first establishes a suppressed signature and then
    raises a different one.
18. Given a passing run while a failure signature is suppressed, the success digest is sent.
19. Given five slots gated across one day, the board shows five entries with a non-failure status,
    each carrying non-empty reason text, and zero entries with `failed`.
20. Given a slot gated on 10 consecutive ticks and then run successfully, the board shows exactly
    one entry for that slot, and it is the successful run — not a deferred entry, and not ten.
21. `npm run check` passes on all three OSes, including `boundaries`.

---

## 13. Success Metrics

Observable outcomes, verifiable from the DB, the daemon log, and Telegram history.

- **Zero** runs in a 30-day window failing with the suspend signature (a `stalled: no beat()`
  abort preceded by `net::ERR_NAME_NOT_RESOLVED`) **where the daemon's tick history shows a suspend
  gap shortly before the run started**. Baseline: 6 in 24 hours. *The qualifier matters: a network
  that dies mid-run on a fully awake host produces the same signature, and no pre-spawn gate can
  prevent that. Without the qualifier this metric would red for a cause this feature does not
  claim to fix.*
- **No calendar day with zero successful runs** where the host was awake **and had working
  connectivity** at any point during the schedule window. Baseline: 2026-08-12 produced zero.
  *Both qualifiers are load-bearing. A host that is awake but offline all day is a day where the
  gate declining every slot is the **correct** behaviour and zero runs is the right outcome —
  scoring that as a failure would penalise the feature for working.*
- **No more than ~3 hours of the schedule window elapses after the last successful run of that
  day**, measured on days where the host was awake at or after the window's end. Worked against the
  configured slots (`09:00, 11:30, 14:00, 16:30, 19:00`, window ending 19:00): a healthy day ends
  with a 19:00 success, giving a tail of **0**; the partial-sleep day this metric exists to catch
  (11:30 success, lid closed, no catch-up) gives a tail of **7.5h**; the same day *with* the
  catch-up firing at 20:12 lands after the window ends, giving **0** again. Adjacent slots are
  ≤2.5h apart by construction, so a single missed trailing slot stays under the threshold and only
  a genuine unserved stretch trips it.
- **At most 2 notifications per 24h for any single ongoing failure.** Baseline: 6.
- **Time from a schema bump to operator awareness ≤ one tick + one notification.** Baseline:
  ~2 hours of useless ticking, discovered only by manually reading `daemon.log`.
- **100% of deferred entries carry non-empty reason text.** A blank reason is a defect, because it
  reintroduces the "where did today go?" question the entry exists to answer.
- **Qualitative, and the one that actually matters:** on the next lid-closed day, the operator's
  first hypothesis is correct without opening a terminal. The original incident cost a full
  investigation that started with the wrong suspect (a merge).

> **Why the freshness metric measures a within-window tail rather than a gap between runs.** The
> obvious formulation — "no gap longer than N hours between successful runs" — cannot work here.
> A perfectly healthy day ends at 19:00 and resumes at 09:00, a **14-hour** gap every single night,
> while the partial-sleep case this metric exists to catch produces **21.5h**. Any threshold has to
> thread between two numbers that are both overnight gaps, and it would need re-deriving for every
> change to the slot list. The tail formulation is threshold-stable instead: it asks only how much
> of the *scheduled day* went unserved after the last success, so the overnight gap never enters
> the arithmetic and the ≤2.5h spacing between adjacent slots sets the scale automatically. The
> cost is that it is a less intuitive number to read at a glance than "hours since last run" —
> a fair trade for a metric that is not red every night by construction.

---

## 14. Out of Scope

| Cut | Reason |
|---|---|
| Suspend-aware stall watchdog; any change to `src/pipeline/runner/` | Deliberately rejected. Would not have rescued these runs — the network was down and the CDP socket dead. It would convert a 16-minute failure into a run hanging across sleep cycles until the run cap. Highest blast radius in the repo, for negative benefit. |
| Making all pipeline deadlines monotonic-aware | The correct long-term answer to the architectural finding, and far too large for this slice. The gate makes it unnecessary for the observed failure mode. Record as a known architectural debt. |
| Host-side sleep prevention (`pmset repeat wake`, Amphetamine config) | Operator guidance, not software. **Documented here because it is a live trap:** Amphetamine's `PreventUserIdleSystemSleep` assertion does **not** override clamshell sleep — lid closed means asleep regardless. The operator either keeps the lid open during slots or schedules `pmset repeat wake`. |
| Full catch-up of every missed slot | Rejected: five back-to-back scrapes risk tripping the LinkedIn throttle breaker — a burst in a new costume. |
| Automatic daemon self-restart on schema drift | A process cannot reload its own code; a real fix needs a supervisor, which exists only on darwin (`autostart`). Alerting plus a visible degraded state solves the operator's actual problem (knowing) at a fraction of the risk. |
| A dedicated "recovered" notification | Unnecessary: success digests are already sent on every passing run (`run.ts:308-312`), so recovery is already visible on the primary channel. Adding one would be net new noise. |
| Notification channels other than Telegram | No evidence of need; single operator, single channel. |
| Retry/auto-resume of a failed scheduled run (`--resume` remains opt-in) | Different problem. The gate prevents the doomed run rather than recovering it; auto-resume of genuinely-broken runs is unevidenced. |

---

## 15. Four-Risks Scorecard

| Risk | Score | Rationale |
|---|---|---|
| **Value** | **High** | The failure is deterministic and its trigger is normal laptop behaviour, so the cost recurs indefinitely. G5 is a real defect that recurs on every schema bump. *Weakness:* value is partly contingent on how often the lid actually closes during slots — the evidence is one day, N=1, and a disciplined operator habit would eliminate much of D1's value without any code. |
| **Usability** | **Medium** — open concerns handed to UX | A `deferred` row in a list otherwise made of pass/fail can easily read as a *third* kind of failure; if it looks alarming, the fix reintroduces the anxiety it removes. The catch-up run is a second concern: it fires when the lid opens, so a ~28-minute scrape starts while the operator is actively using the machine — an interruption the operator has accepted in principle but which needs a designed expression (R11 asks for stoppability). **Both are UX's to resolve; I am not answering them here.** |
| **Feasibility** | **Medium — PROVISIONAL** (no engineering tools; product-ui confirms) | Three unconfirmed points. (1) **The deferred-entry surface may cross the structural `runs`-tables-are-pipeline/runner-only invariant** — the single hardest constraint here, and the reason Q1 specifies outcome and not mechanism. (2) The daemon needs a notifier, but only `cli/wire/compose.ts` may instantiate adapters; injection through the daemon's existing deps looks plausible but is unverified. (3) Notification dedup needs persistent last-sent state, and none exists today — that is new storage. *Encouraging:* the gate itself reuses an existing guard-clause shape at `daemon.ts:216-226`, and `lastTickAt` is already written every tick. |
| **Viability** | **Medium** | Trivially viable in the usual sense — single user, no cost, no business model, so there is no commercial risk to assess. The real and non-trivial cost is **maintenance surface added to the daemon**, the one component with no supervisor and the one whose own failure is hardest to notice. This feature makes the daemon smarter about the world, and every such addition is a new way for the scheduler to be wrong. That is a genuine reason this scores Medium and not High. |

---

## Appendix — Evidence index

Incident runs 19–24 (profile `harish`), all failing at `farm` with:
`stage "farm" failed after 1 attempt(s) — cause: stage "farm" stalled: no beat() within 360000ms`.
Merge hypothesis ruled out on timing: PR #99 merged 2026-08-11T06:23:13Z with runs 15–18 passing
after it; run 19 failed at 15:49Z, before PR #100 merged at 18:44Z.

Explicitly ruled out and **not** to be re-investigated: Chrome process leak (none — cleanup at
`src/adapters/lanes/linkedin/lane.ts:290` worked on every killed run), LinkedIn throttle breaker
(never opened), and application/schema/DB errors inside the failing runs (no `src/**` stack frame
in any `failure_json`; `reconcile` succeeded cleanly every time).
