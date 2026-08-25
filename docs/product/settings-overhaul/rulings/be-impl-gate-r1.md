# Judge ruling — settings-overhaul BE implementation end-of-plan gate (round 1)
Date: 2026-08-19 · Target: git diff origin/main..HEAD on /Users/harishamutha/jb-wt-settings (16 code commits, 12 executed briefs)
I have what I need. One dispatch returned a materially wrong `source.ts` hunk which my own grep contradicted — noted below, and it's why every load-bearing claim here is cited to a command I ran myself.

MODE: CHANGE-REVIEW
STATUS: done
VERDICT: findings

---

# FILED RULING — BE implementation gate (whole-plan), `settings-overhaul`

**Target:** `git diff origin/main..HEAD` on `/Users/harishamutha/jb-wt-settings` (branch `feat/settings-overhaul-impl`), 16 code commits `710f4d8..8f32da2` over 12 executed briefs.
**Contract:** `docs/product/settings-overhaul/blueprint-be.md` §11/§11a (judge-gated dispositions), plus the repo stability principle in `CLAUDE.md`.
**Law applied:** the null hypothesis — the change is presumed wrong until evidence that *could have failed* clears it. Task 8 and §3 steps 20–23 treated as deliberately out of scope, not re-litigated.

**VERDICT: CLEARS WITH CONDITIONS**

The set composes coherently. §11's F1, F4, F5, F8 and §11a's type-homing are all satisfied in the actual diff, not just in the reports, and the gate is genuinely green. Three findings are load-bearing: **F1 blocks merge**, **F2 blocks the UI set** (it is a frozen-contract divergence the 38 UI briefs will import blind), **F3** should land with them. F4–F6 are minor and can ride.

## GATE — verified first-hand, not from any report

`npm run check` on HEAD, exit code captured directly (`REAL_EXIT=0`) rather than through a pipe. My first run reported "exit 0" from `tail`, which is meaningless; re-run without the pipe. Result: typecheck clean; lint `Checked 502 files, no fixes applied`; boundaries `no dependency violations found (492 modules, 1394 dependencies cruised)`; `tests 2106 / pass 2105 / fail 0 / skipped 1`. The `noNonNullAssertion` diagnostics in the output are pre-existing **warnings** on `src/ops/daemon/alert/schema_drift.ts`, a file byte-identical to `origin/main` and absent from this diff — not introduced here, and not fatal to biome.

## FINDINGS

### F1 — load-bearing — the board can SIGTERM/SIGKILL **itself**; `stopDaemon` has no self-pid guard
`/Users/harishamutha/jb-wt-settings/src/cli/wire/board_daemon_control.ts:241` passes `pid: overrides.pid ?? process.pid` into the `ServeDeps` bag. In the board that is the **long-lived board server's** pid. `runServeStartParent` then calls `acquireDaemonPidfile(deps.root, deps.pid, …)` (`src/cli/commands/serve/start.ts:44`), and `src/ops/daemon/pidfile.ts:199-200` writes that pid verbatim into the pidfile. The spawned child only overwrites it as its **first action after boot** (`start.ts:184-195`). Meanwhile `stopBoardDaemon` kills whatever the pidfile names, with no identity check:

```
// board_daemon_control.ts:105-115
const file = readDaemonPidfile(overrides.root, pidfileDeps);
if (!file) return { outcome: 'already_stopped' };
const daemonDead = await killAndConfirmDead(file.pid, killDeps);   // SIGTERM → SIGKILL
```

Two reachable paths:
- **Transient** — any `POST /api/daemon/stop` in the window between acquire and the child's overwrite (the parent itself sleeps `CHILD_ALIVE_CHECK_MS = 2_000` before returning, `start.ts:33,116`) reads the board's own pid and kills the board.
- **Persistent, and the worse one** — `runServeStartParent` calls `rotateIfLarge` then `openAppendFd` (`start.ts:90-92`) *after* acquiring. Those are raw `statSync`/`renameSync`/`mkdirSync`/`openSync` with **no try/catch** (`src/ops/daemon/logs/logs.ts:49-63`), as is `deps.spawn`. Any throw (EACCES, ENOSPC, EMFILE) propagates to `startBoardDaemon`'s catch at `board_daemon_control.ts:284-286`, which returns `spawn_failed` and **never calls `releaseDaemonPidfile`**. The CLI self-heals from this because its parent process exits and the pid dies; the board's parent lives forever, so the pidfile permanently names a live pid. `GET /api/daemon` then reports the daemon running, and the next Stop click kills the board server.

Violates `src/ports/board.ts:337-339`'s own contract for `stopDaemon` — *"NEVER throws; every failure mode is a typed outcome"* — self-termination is neither. Also squarely the failure class `CLAUDE.md`'s stability principle reserves deliberate review for.
**Not my fix to make.** Routes to the implementer: a `file.pid === process.pid` guard in `stopBoardDaemon`, and a `releaseDaemonPidfile` in `startBoardDaemon`'s catch.

### F2 — load-bearing — `AutostartOutcome` cannot express the 409 the UI will actually receive
§11a froze six identifiers and stated *"every shape is byte-identical to what §0(c)/§3 already specified; this bounce only named and homed the types."* The fix round then diverged from that frozen shape: `/Users/harishamutha/jb-wt-settings/src/cli/wire/board_autostart_control.ts:145-151` **throws** `HttpError(409, 'autostart_conflict', …)` for the darwin legacy-plist refusal, because `AutostartOutcome = { outcome: 'ok' | 'unsupported_platform' }` (`src/ports/board.ts`) has no slot for it.

The UI set imports `AutostartOutcome` from `src/app/features/daemon/index.ts` (verified: the barrel exports exactly `AutostartOutcome, StartDaemonOutcome, StopDaemonOutcome`). A UI brief written against that type will type-check perfectly while being **blind to a 409 that is a routine darwin outcome** — any machine carrying a legacy plist. Neither blueprint §2 nor §11a mentions a 409 anywhere, so no downstream brief can have accounted for it.

Secondary, same finding: this is an intra-diff inconsistency. Tasks 11/12/13 added three sibling controls; two are contractually "never throw, every failure is a typed outcome," the third throws. The UI must handle one of three parallel controls differently for a reason invisible in its type.

### F3 — load-bearing — the preview route reports server-side data corruption as the user's validation error
`/Users/harishamutha/jb-wt-settings/src/app/features/preview/routes.ts:20-31` wraps **every** throw as `HttpError(422, 'validation', message)`, on an explicitly stated premise:

> `// The only throw previewFilterRule makes is the draft-validation failure (its own doc comment)`

That premise is false against the implementation. `/Users/harishamutha/jb-wt-settings/src/cli/wire/board_preview.ts:128-132` parses the profile's **current stored** config:

```
const currentConfig = currentRaw === undefined
  ? FilterConfigSchema.parse({})
  : FilterConfigSchema.parse(JSON.parse(currentRaw));
```

`JSON.parse` throws on a corrupt doc, and `FilterConfigSchema.parse` throws on a stored `filter.json` that no longer satisfies the schema. `deps.source.openStore(name)` can throw too. All three surface to the user as *"your draft filter is invalid"* — an undiagnosable mislabel of a server-side problem. Blueprint §7's "never a 500" is technically met, but by misattribution rather than by handling.

### F4 — load-bearing (minor) — cross-task stale comment: `maxProbesPerRun` "no signal exists"
`/Users/harishamutha/jb-wt-settings/src/app/features/runs/soft_errors.ts:38-43` states `maxProbesPerRun` *"is deliberately absent: no signal exists yet to detect it from run events."* Task 6 (`fbd4911`) created exactly that signal — `source.ts:205-211` now emits `'source: maxProbesPerRun cap hit — stopping probes for this run'`. Task 5 wrote the comment, task 6 created the signal, neither reconciled. The two-flag `capsHit` shape is itself blueprint-compliant (step 10 mandates only `maxNewPerLane`/`maxCardsPerUrl`); the **comment** is false as of the combined diff, against `CLAUDE.md`'s docs-as-code rule.

### F5 — load-bearing (minor) — the `readAt` contract comment overstates its reach, in three places
The comments F13 specifically scheduled all say `readAt` reads *"from within the last 5 days' worth of runs"* — `src/ports/checkpoint_store.ts` (twice, on `latestTimeDir` and `latestCheckpointTimeDir`) and `src/routines/cleanup/cleanup.ts:17-23`. But `src/cli/wire/board_preview.ts:27` is `const MAX_RECENT_RUNS = 5` — **5 runs, not 5 days**. At the ~5 fires/day this profile schedules, that is under one day. A single propagated error, in a contract comment on a stability-sensitive port.

### F6 — cosmetic — preview's unknown-profile posture diverges from every sibling feature
`src/app/features/config/routes.ts:82` throws `HttpError(404, 'no_such_profile', …)` for a name that isn't a profile. The preview route returns `200 {available:false, reason:'no_recent_run'}` for the same input, because `board_preview.ts:89-91` collapses `openStore(name) === null` into the no-run branch. Safe — the membership gate in `openStore` is upstream, so there is no traversal risk — but inconsistent with the convention every other route follows.

### F7 — unverified assumption — `startDaemon`'s ~37s worst case has no HTTP-layer bound
`board_daemon_control.ts:205-226` documents deliberately that no timeout wraps `runServeStartParent`, whose `STEAL_RECHECK_WAIT_MS` (35s) + `CHILD_ALIVE_CHECK_MS` (2s) path is *"a legitimate slow path, not a hang."* I found no request timeout at the server layer to bound it. Blueprint §11's F9 disposition routes the Doherty-acknowledgement mismatch to product-ui. Recording as an assumption the UI set must honour, not a defect in this diff.

### CARRY-FORWARD — not a BE defect, but at real risk of being dropped
`CLAUDE.md:82` still reads *"Currently the only such module is `src/core/datetime/`."* The F4-mandated line naming `src/core/normalize_token/` was never added. **BE is compliant**: blueprint step 13 explicitly defers it to *"the same change that lands the S2 conflict-notice client logic"* — the UI set. But `plan.md`'s "One outstanding advisor action" says the advisor applies it right after task 7 lands, and that did not happen; the only `CLAUDE.md` edit in this range is from `e81040b` (the pre-implementation docs commit, LinkedIn breaker state path, unrelated). The moment a UI brief imports `core/normalize_token/`, it violates a rule that still names `datetime` as the only such module.

## WHAT SURVIVED (checks that could have failed)

- **F1 disposition (§11) — clears.** `stopBoardDaemon` reproduces `runServeStop`'s exact four steps in order — daemon first (D10), pidfile re-read, child kill, release last — via the same `killAndConfirmDead` and `SIGKILL_GRACE_MS` (`lifecycle.ts:45-51` vs `board_daemon_control.ts:104-133`). `daemon_unresponsive`/`child_unresponsive` exist and are distinct; no survived-SIGKILL path returns `already_stopped`. The `KillDeps` narrowing (`lifecycle.ts:26`) is documented in the same change.
- **The inert `ServeDeps` stand-ins are safe.** I read `runServeStartParent` (`start.ts:35-129`) end to end: it reads only `platform`, `listLaunchAgentFiles`, `uid`, `writeErr`, `root`, `pid`, `pidfile`, `pidIsAlive`, `sleep`, `home`, `logs`, `spawn`, `nodeBin`, `cliEntry`, `readDaemonLogTail`, `write`. It never touches `killPid`, `scan`, `notify`, or any tick-loop field. The stub `killPid: () => {}` cannot silently no-op a steal.
- **F5 disposition (§11) — clears.** `isStructuredJD` guard at `board_preview.ts:64-68`, applied at `:120`, all-unstructured degrading to `checkpoint_expired` at `:121-123`.
- **F8 disposition (§11) — clears.** All four named target files exist; `board.ts` holds only thin delegates and sits at **389/400** lines; `core/config/` keeps its 2-impl-file count with `linkedin_pacing/` as a subfolder-module.
- **§11a — clears for everything in scope.** Four of six identifiers are defined in `ports/board.ts` and re-exported by the correct barrels (`daemon/index.ts` gains its first type export; new `preview/index.ts` exports `FilterPreviewResult`). The two absent — `BreakerStatus`, `LinkedinSessionStatus` — belong to deferred task 8, correctly.
- **Cap substrings are byte-exact.** `CAP_MESSAGE_SUBSTRINGS` matches `source.ts:300` and `fire/loop/cards.ts:53` exactly. Verified by direct grep after a dispatch misreported this hunk (see NOTES).
- **A TypeError hypothesis died.** I expected `LinkedinPacingSettingsSchema.parse(parsed.settings.linkedin ?? {})` (`validators.ts:64`) to throw on a `profile.json` with no `settings` key. `schema.ts:24` is `settings: z.record(z.string(), z.unknown()).default({})` — always defined post-parse. No regression.
- **`skipNext` is self-inert as designed** (blueprint step 9: *"no separate cleanup mechanism needed"*), and the write path is the existing `PUT config/profile.json` with no new surface.
- **A beyond-blueprint fix that is correct.** `dfc90a8` extends the `skipNext` guard to `deriveExpiredUnserved` (`deferrals.ts:57-70`), which the blueprint never specified. Without it a deliberately skipped slot would read as expired-unserved and could spawn a same-day catch-up run, defeating the skip. A real hole in the frozen plan, caught and closed with a mirrored comment. Approved deviation, not a finding.
- **Boundaries hold.** `board_preview.ts` correctly stays outside the `only-wire-imports-adapters` carve-out by taking `openCheckpointStore` via injection rather than importing the adapter.

## CONDITIONS

**Blocking before this branch merges:**
1. **F1** — self-pid guard in `stopBoardDaemon`, plus pidfile release in `startBoardDaemon`'s catch.

**Blocking before the UI set consumes these contracts:**
2. **F2** — either widen `AutostartOutcome` with the conflict member (and drop the throw), or amend blueprint §2/§11a to pin the 409 explicitly so the UI briefs can be written against it. This is a frozen-contract change either way and is **product-be's call, not the implementer's**.
3. **F3** — narrow the preview route's catch, or have `previewFilterRule` distinguish draft-invalid from stored-config-invalid.

**Non-blocking, fold into the next pass:**
4. **F4, F5, F6** — comment corrections and the route-posture alignment.
5. **F7** — carry to product-ui as a stated assumption.
6. **CARRY-FORWARD** — the `CLAUDE.md` `normalize_token` line must land with the UI set's S2 work; `plan.md`'s "outstanding advisor action" should be closed or explicitly re-pointed at the UI set so it is not lost.

**Note to the UI set:** the four types you will import exist and are correctly homed and barrelled. Do not write against `AutostartOutcome` until condition 2 lands — the type as it stands is incomplete.

---

EVIDENCE:
- Gate status — `npm run check` with exit code captured outside a pipe — REAL_EXIT=0, 2106 tests / 0 fail, boundaries clean, lint 502 files clean; pre-existing warnings only, on a file identical to `origin/main`.
- "stopDaemon can kill the board" — read `board_daemon_control.ts`, `serve/start.ts:35-129`, `serve/lifecycle.ts`, `ops/daemon/pidfile.ts:193-212`, `ops/daemon/logs/logs.ts:49-63` — confirmed: pidfile written under `process.pid`, killed with no identity check, catch path never releases.
- "inert ServeDeps stand-ins are unread" — read `runServeStartParent` in full — confirmed, `killPid` never referenced.
- "cap warn message is mislabelled" (dispatch-reported) — own `grep -n "cap hit" src/pipeline/stages/source.ts` — **hypothesis died**: line 207 reads `maxProbesPerRun`, exactly as blueprint step 11 specifies. Dispatch was wrong.
- "cap substrings drifted from source" — own grep of `soft_errors.ts:64-70` vs `source.ts:300` and `cards.ts:53` — byte-exact, survived.
- "save-time pacing validation TypeErrors on a settings-less config" — read `schema.ts:24` — died, `.default({})` present.
- "preview route mislabels stored-config errors" — read `preview/routes.ts:20-31` against `board_preview.ts:128-132` — confirmed, the route's own stated premise is false.
- "`AutostartOutcome` omits the 409" — read `board_autostart_control.ts:145-151`, `ports/board.ts` type, `app/features/daemon/index.ts` barrel, blueprint §11a table — confirmed, no 409 anywhere in the contract.
- "readAt reaches 5 days" — read the three comments against `board_preview.ts:27` — confirmed wrong, it is 5 runs.
- "CLAUDE.md normalize_token line landed" — own `grep -n normalize_token CLAUDE.md` + `git log origin/main..HEAD -- CLAUDE.md` — confirmed absent; sole CLAUDE.md commit is `e81040b`, unrelated.
- "skipNext needs a cleanup mechanism" — read blueprint step 9 — died, explicitly self-inert by design.

DELEGATION LOG:
- executor-fast — verbatim extraction of the core-layer diff (normalize_token, linkedin_pacing, validators, schedule, CLAUDE.md, normalizeToken call-site grep) — returned; used only after spot-verification.
- executor-fast — verbatim extraction of the app/pipeline diff (preview + daemon routes, server.ts, checkpoint store, cleanup, source.ts, soft_errors, autostart/lifecycle) — returned; **one hunk (`source.ts`) was materially wrong** and was discarded.

NOTES: One dispatch returned a `source.ts` diff hunk showing the new warn as `'source: maxNewPerLane cap hit — dropping remainder'`, which would have been a genuine cross-task defect (wrong cap attributed in `capsHit`). My own grep showed line 207 actually reads `'source: maxProbesPerRun cap hit — stopping probes for this run'` — correct. I discarded that hunk and re-verified every other claim I took from either dispatch against a command I ran myself; no other discrepancy surfaced. Similarly, my first gate run reported "exit code 0" from `tail` at the end of a pipe, which is not npm's status — the green verdict here rests on the re-run with the exit code captured directly. I hold no Write/Edit and have changed nothing; every finding routes back to the party that owns the fix (F2 in particular is product-be's contract decision, not the implementer's).
