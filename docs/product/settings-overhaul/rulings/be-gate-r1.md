MODE: DESIGN-REVIEW (law: the premortem — I assumed the blueprint had already failed downstream and worked back to why). Filed ruling follows.

---

# FILED RULING — BE-blueprint gate, `settings-overhaul`

**VERDICT: CLEARS WITH CONDITIONS**

The blueprint is substantially sound and unusually well-grounded: `§0(d)`, `§0(e)`, the R13 hoist's behaviour-preservation, the breaker reuse, the cap-substring constants, and the R15 checkpoint seam all survived first-hand verification. Two findings (F1, F2) are blocker-severity and must be resolved before product-ui consumes the R20 rows; F3–F4 must be resolved before product-ui consumes the S2 contract. Everything else can ride as amendments.

## FINDINGS

### F1 — blocker — `stopDaemon` mis-specifies the stop mechanism; as written it orphans a live run child and leaves a stale pidfile
`§3.38` specifies stop as "send the **exact same** signal `jobbunny serve stop` sends to that pid → `{outcome:'stopped'}`". The real mechanism is four steps:

`/Users/harishamutha/Job-bunny/src/cli/commands/serve/lifecycle.ts:41-76` — `runServeStop` kills+confirms the daemon, **re-reads the pidfile**, kills+confirms `after.inFlight.pid`, then `releaseDaemonPidfile`. And `/Users/harishamutha/Job-bunny/src/cli/commands/serve/start.ts:232-242` documents why: *"the shutdown handler does NOT release the pidfile — removal belongs exclusively to `serve stop` … a still-running child would survive a successful stop."*

A board Stop that only SIGTERMs the daemon pid therefore (a) leaves the pidfile on disk naming a dead pid, and (b) **orphans the in-flight run child, which holds Chrome** — the one-Chrome invariant spec §11 names as R19/R20's review criterion. Separately, `§3.38`'s "any signal failure degrades to `already_stopped`" reports success exactly where `runServeStop` returns exit 1 (`lifecycle.ts:52-55,65-70`, survived-SIGKILL) — the inverted twin of the false-success `§7` correctly forbids for `startDaemon`.
**Resolves:** product-be amends `§3.38` to reuse/extract `runServeStop`'s full lifecycle, and adds a distinct failure outcome for survived-SIGKILL.

### F2 — blocker — the R20 user-gate is narrowed: the spec's own null branch is missing, and autostart ships ungated
Spec §12 Phase 3 (`spec.md:701-702`) names a fourth outcome: *"If that ruling is 'not worth it,' R19 still ships and **R20 becomes Won't**."* The `§0(c)` options table offers three, none of which is that branch — Option 3 still ships Stop plus a Start fallback. On top of that:
- `§3.37` ships Stop "**unconditional**, ships regardless of the R20 ruling";
- `§3.41` (autostart — explicitly part of R20 per `spec.md:598`) carries **no gate at all** in `§2` (row "Autostart toggle"), `§5` (R20 row), `§6`, or `§8`.

Only Start (`§3.40`) is gated. Two-thirds of a Must whose mechanism is user-gated is pre-decided. This contradicts the standing package ruling that the blueprint proposes options and nothing else depends on the outcome.
**Resolves:** (i) product-be adds the "R20 → Won't" option to the `§0(c)` table and marks autostart conditional in `§2`/`§5`/`§6`/`§8`; (ii) **user decision** on R20 before any of `§3.37-42` is built.

### F3 — major — the S2 conflict derivation is semantically wrong; `§2` encodes the defect as a contract
`§0(a)` computes the conflict as a pure set-difference of rank timezones minus `filter.json.timezones.accept`. Two live conditions are dropped:
- `/Users/harishamutha/Job-bunny/src/core/filter/config.ts:33-38` — `timezones` is `.optional()`. When absent, `/Users/harishamutha/Job-bunny/src/core/filter/rules/timezone.ts:13` returns `undefined` (**no drop rule exists**), yet every rank timezone is trivially "absent from accept" → the notice fires on a profile with no timezone rule at all.
- `severity: 'hard'|'soft'` (same lines). `/Users/harishamutha/Job-bunny/src/core/filter/engine.ts:32-34` — `decide()` drops **only** on hard-severity failures. Under `severity: 'soft'` nothing is dropped, yet ux-notes §6's copy asserts *"so no job from it can reach the board."*

`§0(a)`'s claim that the nuance "affects only the **copy**, never the **computation**" is true for the remote-only gate and false for these two.
**Resolves:** product-be amends `§0(a)` and the `§2` "Timezone conflict set" row to guard on `timezones !== undefined` and to branch the result on `severity`.

### F4 — major — the client-side seam is ambiguous and, as named, violates the two-pair rule
`/Users/harishamutha/Job-bunny/src/core/jd/index.ts:1-2` is `export * from './normalize.ts'; export * from './schema.ts';` and `schema.ts:1` imports zod. So the plan requires `ui/` to deep-import `src/core/jd/normalize.ts`, past the module's public surface. All 13 existing ui→core imports go through a module index (`ui/src/features/runs/RunsList.tsx:14` et al., every one `src/core/datetime/index.ts`), and CLAUDE.md's rule is module-shaped ("a `core` **module** the SPA imports"). `§3.13` then proposes amending CLAUDE.md to bless the file — enshrining a violation of the two-pair rule inside the text of another rule. `normalize.ts` itself is genuinely zero-import (verified, `/Users/harishamutha/Job-bunny/src/core/jd/normalize.ts` — no import statements); that narrow fact is correct, it just isn't sufficient.
**Resolves:** product-be names **one** mechanism in `§2` — either extract `normalizeToken` into its own dependency-free core module with an `index.ts`, or take the `§NOTES` server-endpoint fallback. `§3.13` as written must not stand.

### F5 — major — `previewFilterRule` can throw, contradicting its own `§7` "never a 500"
`/Users/harishamutha/Job-bunny/src/pipeline/runner/stage.ts:12-15` — `StagePayload = { jobs: JD[]; dropped: DroppedRecord[] }` (so `§3.32`'s defensive parse shape is right). But `/Users/harishamutha/Job-bunny/src/core/jd/schema.ts:80,101` — `structured` is `.optional()` and `StructuredJD = JD & { structured: … }`, while `engine.ts:20` `evaluate(jd: StructuredJD, …)` and `rules/timezone.ts:12` destructure `jd.structured`. `§3.32(6)` runs `evaluate()` over "every job in the checkpoint payload" with no narrowing guard; one unstructured job is a TypeError, and `§3.33`'s only catch is around the draft validator.
**Resolves:** product-be adds the `structured`-present guard and its degrade to `§3.32`.

### F6 — major — the session probe leaks CDP connections; `§7`'s "no state accumulates" is false
`raceWithTimeout` exists and is bounded as claimed (`/Users/harishamutha/Job-bunny/src/adapters/browser/cdp-chrome/async/race_with_timeout.ts:15-28`) — but its own doc comment is explicit that `task` "is left to settle on its own time". It does **not** abort `connectOverCDP`. `§3.20` never disconnects the browser after reading cookies, so each `[Check now]` leaves a live CDP connection. `§7`'s "Safe to re-run … no state accumulates beyond overwriting the cache" does not hold. Related: CLAUDE.md's "`AbortSignal` is the deadline mechanism everywhere; no unbounded await in an adapter" — connect is bounded by a timer race, not a signal (precedented in-repo by `connectWithRetry`, so worth stating as a deliberate deviation rather than leaving silent).
**Resolves:** product-be adds an explicit disconnect/close in `§3.20` and corrects `§7`'s idempotency line.

### F7 — major — `inFlight` does not answer "is a run in progress"
`/Users/harishamutha/Job-bunny/src/ports/board.ts:107` — `inFlight` is read from the **daemon pidfile** (`DaemonInFlight`), so it covers only daemon-spawned runs. A CLI-initiated `jobbunny run`, or any run while the daemon is stopped, reads `inFlight: null`. Two consequences:
- `§5`'s R14 row — "`GET /api/daemon`'s existing `inFlight` field **already answers** 'is a run in progress'" — is an overclaim; ux-notes §11's success line *"nothing is running right now"* can be false for the exact persona who runs CLI commands.
- `§3.21`'s probe gate ("never touch Chrome while a run owns it", restated as a guarantee in `§7`) does not hold for a CLI run.

`RunSummary.status` (`/Users/harishamutha/Job-bunny/src/ports/run_store.ts:22`, `'running'` with `'crashed'` derived on stale heartbeat) is the complete signal.
**Resolves:** product-be amends the R14 row and `§3.21` to consult the runs table alongside `inFlight`.

### F8 — major — the file placement is not executable against the repo's own gates
- `/Users/harishamutha/Job-bunny/src/cli/wire/board.ts` is **388 lines** against a 400-line impl cap gated by `npm run filesize` (`package.json:21`, inside `npm test` → `npm run check`). Steps `§3.16, 21, 32, 38, 40, 41` add **seven** implementations to that one file.
- `/Users/harishamutha/Job-bunny/src/core/config/` holds exactly two impl files (`schema.ts`, `validators.ts`). `§3.1` adds `linkedin_pacing.ts` as a third — CLAUDE.md's two-pair rule requires the folder be split into subfolders first.

The repo already splits for precisely this reason: `async/race_with_timeout.ts:2-4` ("purely to keep that file under the 400-line cap"), and `.dependency-cruiser.cjs:53-68` records `builders.ts`/`migrate.ts`/`daemon_deferred.ts` as the same manoeuvre. `§3.22` notices the cap for the new `linkedin` slice but nowhere else.
**Resolves:** product-be names the target files/subfolders in `§3` rather than leaving the split to the executor.

### F9 — major — `§0(c)` Option 1's cost claims are unsupported, and the user rules on them
`/Users/harishamutha/Job-bunny/src/cli/commands/serve/start.ts:35-129` — `runServeStartParent` is not a reusable primitive. It gates on darwin legacy plists (`:36-41`), can **block ~35 s** on `STEAL_RECHECK_WAIT_MS` (`:32,58`) plus 2 s `CHILD_ALIVE_CHECK_MS` (`:33,117`), rotates and opens a log fd (`:92-94`), writes to stderr, reads a log tail, and returns exit codes. "Lowest build cost — zero new subsystems, **100% code reuse**" overstates it, and the latency is unstated while ux-notes §10 designs a ≤400 ms Doherty acknowledgement. The pidfile race-guard claim *is* true (`acquireDaemonPidfile` → `deps.writeFileSyncExclusive`, `pidfile.ts:193-211`), as is Option 2's "none of the Linux/Windows infrastructure exists today" (`autostart.ts:200-203`).
**Resolves:** product-be corrects Option 1's cost/blast-radius cells before the user rules.

### F10 — minor (routing) — `maxAgeDays` correction is right, but it contradicts a Must and an AC
Verified: the only consumers are `/Users/harishamutha/Job-bunny/src/cli/wire/settings.ts:35` and `/Users/harishamutha/Job-bunny/src/adapters/lanes/linkedin/inventory.ts:60-102` (page-inventory freshness → a doctor check). `§2`'s copy correction is correct and spec §5.3 / R6 / AC6 are wrong to call it a yield cap. But AC6 ("each display a one-line statement of what they cap") is unsatisfiable as literally written for this field.
**Resolves:** **user/PM** ratifies the correction so QA does not test AC6 as written.

### F11 — minor — broken internal cross-references in the table product-ui enshrines
`§2` cites "§3.26" for daemon start/stop and "§3.27" for autostart; `§0(c)` cites "§3 step 26" for Stop — but line 556 declares steps 24-27 skipped and the real steps are 37-42. The breaker is cited as `§3.16-19` (`§2`), `§3.14-19` (`§5`), `§3.17-19` (`§6`).

### F12 — minor — pervasive citation drift; no line number in the document is trustworthy
`validators.ts` profile.json case is 51-61 (blueprint: 58-69) and the sqlite check 57-59 (blueprint: 65-67); cap defaults are `settings.ts:54,60,67` (blueprint: 53,59,66); `cleanup.ts:54` (blueprint: :53); `defaultCdpReachable` is `provider.ts:97-107` (blueprint: 98-108); `owed.ts`'s enabled/weekdays guards are 65-66 with the slot loop 68-77 (blueprint: 70-83); `scan.ts`'s literal is 73-79 (blueprint: 75-78). `runEnable`/`runDisable` (`autostart.ts:205,235`) are **not** exported — `§3.41` correctly hedged this.

### F13 — minor — two contract comments R15 invalidates are not scheduled for update
`/Users/harishamutha/Job-bunny/src/routines/cleanup/cleanup.ts:51-53` and the sibling reasoning in `/Users/harishamutha/Job-bunny/src/ports/checkpoint_store.ts:46-62` both assert every checkpoint read path looks only at the same-day latest checkpoint — `readAt` breaks that. CLAUDE.md requires per-module contracts move in the same change; `§3.13` schedules a CLAUDE.md edit but nothing for these.

### F14 — minor — two smaller precision gaps
`CdpBrowser.contexts` is **optional** (`provider.ts:72`), so `§3.20`'s literal `browser.contexts()[0].cookies()` needs a guard. And `/Users/harishamutha/Job-bunny/src/core/config/schema.ts:4-8` plus `cli/wire/settings.ts:29-31` both document that adapter settings shapes are adapter-owned and deliberately not imported into core — `§3.1` moves the LinkedIn pacing schema into `core/config/` against that stated intent (mechanically legal under `core-is-pure`; contrary to a documented boundary). Note the widening of `CdpBrowserContext` in `§3.20` **is** safe as claimed — grep shows the interface is referenced only at `provider.ts:61,72,73`, with no fakes to break.

## WHAT SURVIVED THE PREMORTEM (verified, not assumed)

- **`§0(d)` clears outright.** `compose.ts:241` `path.join(root, 'chrome')` ✓; `launcher.ts:64-70`'s own comment confirms `DEFAULT_USER_DATA_DIR` is inert ✓; `board.ts` is genuinely inside the `only-wire-imports-adapters` carve-out (`.dependency-cruiser.cjs:74`) ✓.
- **`§0(e)` clears.** `schedule.enabled` at `schema.ts:12`, gating `owed.ts:65` and `scan.ts:71` ✓. `skipNext` is self-inert because `isRunOwed` derives `date` from `now` (`owed.ts:60`) ✓.
- **`§0(b)` clears, and probe 3's answer is yes.** `CheckpointStore` exposes no stage-specific read ✓; `CheckpointRef.stage` exists ✓; `RunSummary.date`/`timeDir` exist ✓; TTL default is 2 (`cleanup.ts:54`) and a profile whose last run predates it degrades to `available:false`, which ux-notes §8 state (b) designed ✓.
- **R13's hoist is behaviour-preserving** — `settings.ts:116-129` `.parse(settings ?? {})` defaults quietly, so "only present-but-invalid throws" is exact ✓.
- **Cap substrings are byte-exact** — `source.ts:292`, `fire/loop/cards.ts:53` ✓; `maxProbesPerRun` is genuinely silent (`source.ts:205`) ✓.
- **R18's reuse is correct** — `readBreaker` (`breaker_store.ts:109-133`) returns `undefined` for missing/corrupt and `breakerPhase` (`:138-147`) turns that into `'closed'`, satisfying AC16 ✓.
- **The probe cannot launch Chrome** — structurally, its deps bag carries no launcher ✓; `defaultCdpReachable` is 2s-bounded via `AbortSignal.timeout` (`provider.ts:97-107`) ✓.
- **Phase 1 + 2 coverage: no silent drops.** Every R1–R9, R11, R13, R14, R16–R18, R21 maps to a contract or an explicit UI-only row.
- **No prior ruling reopened.** Connector read-only, weights raw-only, one consolidated Advanced area, no manual breaker reset (`§10`), new-profile Won't, Operate rename with `#/setup` untouched — all honoured.

## CONDITIONS

**Blocking before product-ui consumes the affected rows:**
1. **F1** → product-be amendment (`§3.38`, `§0(c)` "de-risking finding").
2. **F2** → **user decision** on R20 + product-be amendment gating autostart and adding the null option.
3. **F3, F4** → product-be amendment to `§0(a)` and the `§2` conflict row. Until then product-ui must not implement S2's notice.
4. **F5, F6, F7** → product-be amendment; each contradicts a guarantee the blueprint itself states in `§7`.

**Non-blocking, required before implementation starts:**
5. **F8** → product-be names target files/subfolders in `§3`.
6. **F9** → product-be corrects Option 1's cost cells (must land with F2, since the user rules on them).
7. **F10** → **user/PM** ratifies the `maxAgeDays` correction against R6/AC6.
8. **F11, F12, F13, F14** → product-be housekeeping pass.

**Note to product-ui:** treat every file:line citation in this blueprint as unverified until re-checked (F12), and do not build S2's conflict notice or any R20 control until conditions 1–4 land.