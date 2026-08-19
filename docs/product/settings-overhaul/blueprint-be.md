# Blueprint — Backend (`settings-overhaul`)

Slug: `settings-overhaul` · Author: product-be · 2026-08-18
**Amendment: 2026-08-18, post BE-gate ruling `rulings/be-gate-r1.md` — verdict
CLEARS WITH CONDITIONS.** Every finding F1-F9, F11-F14 is amended inline and
dispositioned by ID in **§11**; read that section for exactly what changed.
Spec: `spec.md` (authoritative) · UX: `ux-notes.md` + `mockup.html` · State: `.state.md`

> **Read this first.** Most of this epic's Musts are **already fully served by
> existing, unchanged endpoints** — the board's config-doc PUT/GET,
> `GET /api/daemon`, `GET /api/profiles/:name/doctor`, `GET/PUT /api/secrets`.
> product-ui should treat the "existing, unchanged" rows in §2 as load-bearing
> facts, not filler. The genuinely NEW backend work is concentrated in six
> places: (1) hoisting the LinkedIn pacing invariant to save-time (R13),
> (2) a `schedule.skipNext` field (R19's "skip next"), (3) breaker-state read
> (R18), (4) LinkedIn session-health read (R17, amended — F6/F7/F14), (5) a
> checkpoint-backed filter-rule preview (R15, amended — F5), (6) daemon
> lifecycle control (R20, **user-gated on all three of start/stop/autostart
> together**, not implemented pending a ruling — amended, F2). Everything
> else is a UI reorganization of data that already flows through the board
> today. **Do not build S2's conflict notice or any R20 control until this
> amendment's conditions are read** (§11).

---

## 0. Open items — verdicts with evidence

### (a) Can the board cheaply evaluate the filter-timezone remote-only condition (C4)?

**Verdict: YES — still a full join, not degraded to adjacency — but the
original computation was semantically wrong. Corrected below per BE-gate
finding F3.**

`timezoneRule.eval` (`src/core/filter/rules/timezone.ts:9-26`) only fires when
`jd.structured.workType === 'remote'` — that "remote-only" nuance affects only
the **copy** ("drops remote roles..."), never the computation, and that part
of the original verdict stands. **Two other live conditions were dropped from
the original computation and must not be:**

1. **`filter.json.timezones` is `.optional()`** (`src/core/filter/config.ts:
   33-39`). When absent, `timezone.ts:13` returns `undefined` — **no drop rule
   exists at all** for this profile. The naive set-difference (every rank
   timezone is "absent from an empty accept list") fires the conflict notice
   on a profile that has no timezone rule whatsoever — a false positive on
   the epic's single best-evidenced requirement.
2. **`severity: 'hard' | 'soft'`** (same lines). `core/filter/engine.ts:32-34`
   — `decide()` drops a job **only** on a failing **hard** rule. Under
   `severity: 'soft'`, a job outside the accept list is kept (rank-penalized,
   not dropped) — so ux-notes §6's copy, *"so no job from it can reach the
   board,"* is true only when `severity === 'hard'`.

**Corrected computation** (still a pure function of the two already-fetched
config docs, still no per-job data, still cheap): given
`filter.json.timezones`,
1. if `timezones === undefined` → **no conflict is ever computed** — render
   nothing (there is no rule to conflict with).
2. else, for every timezone in `profile.json.settings.rank.location.
   {acceptableTimezones,borderlineTimezones}` (`core/rank/rank.ts:126-129`),
   normalize (`normalizeToken`, §NOTES/F4 for exactly which module owns this
   now) and check membership in `timezones.accept` (also normalized).
3. absent from `accept` **and** `timezones.severity === 'hard'` → the
   drop-notice copy applies verbatim (*"no job from it can reach the
   board"*).
4. absent from `accept` **and** `timezones.severity === 'soft'` → a
   **different, softer notice** is needed — the job is de-ranked, not
   dropped. Ux-notes §6 did not design copy for this branch; product-ui must
   add it (e.g. *"ranked as acceptable, but your rule only soft-flags it
   outside the allowed list — it still reaches the board, ranked lower"*) —
   flagged here as a UX gap this blueprint surfaces but does not close (not a
   BE decision).

This branching is still trivially cheap (a handful of string comparisons over
two small arrays) and still needs no new endpoint or per-job read — the
mechanism in §0(a)'s original verdict (client-side, over the two docs already
fetched) is unchanged. What changed is the **shape of the result**: it is no
longer a flat list of conflicting timezones, it is a list of
`{tz, severity: 'hard' | 'soft'}` (or the branch is skipped entirely when
`timezones` is absent), and product-ui must render two different copy
branches, not one.

### (b) R15 rule-change preview — feasibility spike

**Verdict: FEASIBLE. Ship it.** Server-side, reusing `core/filter`'s
`evaluate`/`decide` directly, zero reimplementation.

The blocker is not `core/filter` (pure, already reusable from `app/` per
`app-only-ports-core`) — it's data access. `CheckpointStore`
(`src/ports/checkpoint_store.ts:27-82`) today exposes only `readLatest`
(highest-position row for a group) — there is no way to fetch a *specific
stage's* checkpoint, and the payload the preview needs (the full pre-filter
candidate pool) is the **`assemble`** stage's checkpoint output
(`src/pipeline/stages/budgets.ts:48-49` — `assemble` immediately precedes
`filter` in the frozen order), not the latest one (which after a full run is
`sync`'s). This is closed by one small, additive, read-only port method (§3
steps 28-30) — see the checkpoints table already has a `stage` column
(`src/adapters/db/sqlite/store/migrations.ts` v2→v3 migration), so this is a
`WHERE` clause, not a schema change.

Real, honest constraint: checkpoints are pruned after `settings.cleanup
.checkpointsOlderThanDays` (default **2 days** —
`src/routines/cleanup/cleanup.ts:53`). If the last run is older than that,
the preview has nothing to read. This is not a design flaw — S4 already
designed for exactly this outcome (`ux-notes.md` §8, state (b): "No recent
run to preview against"). The implementation must check the last **5** runs
(newest-first), not just the latest one, since a run that failed mid-pipeline
before reaching `assemble` would otherwise falsely report "no preview" for a
day that actually has usable data one run earlier.

**Scope, precisely: filter-rule preview only.** The mockup's R15 strip (S4)
is drop-count preview for **Roles & companies rules**, i.e. `core/filter`.
There is no mockup screen asking for a rank re-scoring preview, so rank
preview is explicitly Out of Scope (§8) — do not build it.

### (c) R20 daemon lifecycle mechanism — USER-GATE, not decided here

**Four options, framed for the user to rule on** (BE-gate finding F2: the
spec's own null branch, `spec.md:701-702`, was missing from the original
three; added as Option 4 below). Nothing in the rest of this blueprint
depends on which wins — every other contract is designed to work identically
whichever way this falls, per spec §7.4's own framing. **R20 as a whole —
Start, Stop, and Autostart together — is what's gated; see the re-argument
below for why Stop is a candidate to ship independently, not a foregone
conclusion.**

| # | Mechanism | How it works | Blast radius | Cost |
|---|---|---|---|---|
| **1 — Board-initiated detached spawn (recommended)** | The board process directly calls the *same* spawn logic `jobbunny serve start` already runs (`src/cli/commands/serve/start.ts`'s `runServeStartParent`: `acquireDaemonPidfile` + `deps.spawn(command, args, {stdio:['ignore',fd,fd], detached:true})`, confirm-alive via `pidIsAlive`) as a detached, unref'd child. Stop reuses `runServeStop`'s full lifecycle (`serve/lifecycle.ts:41-76`) — see F1/§3.38. | **High**, but bounded: the board gains the power to spawn one specific, argument-free OS process (no user input reaches the command line) and to run the daemon's own kill-and-confirm sequence against pids it reads from its own pidfile. It does **not** let the board spawn a pipeline run — the daemon, once up, is still the only thing that ever spawns `jobbunny run`. Reuses `acquireDaemonPidfile`'s existing exclusive-write race guard, so a double-click can't spawn two daemons. | **Corrected per BE-gate finding F9 — `runServeStartParent` is not a drop-in reusable primitive, and the true cost is materially higher than "lowest":** it (i) gates on darwin legacy-plist cleanup unrelated to a board-triggered start (`start.ts:36-42`); (ii) can **block up to ~35s** re-checking a stale-but-alive incumbent before stealing its pidfile (`STEAL_RECHECK_WAIT_MS`, `start.ts:32,58-67`) plus a further 2s child-alive confirm (`CHILD_ALIVE_CHECK_MS`, `start.ts:33,118`) — both **far** past ux-notes §10's ≤400ms Doherty-acknowledgement design, so the UI cannot show "Starting…" then a normal poll; it needs its own long-wait affordance; (iii) rotates and opens a log fd, writes to stderr, and returns process exit codes (`start.ts:92-94,123-126`) — none of which map cleanly onto a JSON API response and all of which the wrapping route must translate deliberately, not pass through. **Still the cheapest of the four that deliver Start at all** — every primitive is real, tested code — but "100% code reuse, zero new subsystems" overstated the ease; budget for a wrapping layer that handles the ~35s worst case and the exit-code→outcome translation, not a thin pass-through. |
| **2 — OS service-manager integration** | Extend today's darwin-only `autostart` (`src/cli/commands/autostart.ts`, a `launchctl`-managed LaunchAgent) into a full cross-platform service wrapper: `launchctl kickstart/bootout` on macOS, a systemd user unit + `systemctl --user start/stop` on Linux, a Windows Service or Scheduled Task on Windows. | Comparable to Option 1 in principle, but the mechanism differs per OS, tripling the surface to build, test, and keep working across the 3-OS CI matrix (`check` job). | **Highest build cost, confirmed** — none of the Linux/Windows infrastructure exists today (`autostart.ts:200-203` gates the whole command to darwin), and it reduces to the same spawn/kill primitive Option 1 uses (with the same `start.ts` cost profile underneath it on macOS), wrapped in far more OS ceremony, for the same practical outcome. |
| **3 — Stop only; Start stays CLI-only, elevated to a labelled control** | The board never spawns the daemon. `[Stop]` (`runServeStop`'s full lifecycle, F1) ships. `[Start]` is *replaced*, not disabled, by a one-line statement + `[Copy: jobbunny serve start]` — exactly UX's already-designed S6 variant (b), `daemon-start-fallback`. | **Lowest of the three that ship anything** — zero new spawning capability, the board's structural write-surface invariant is untouched. Stop's real cost is the 4-step lifecycle in F1, not a bare signal — still bounded, still reuses existing tested code. | Low — reuses `runServeStop` verbatim; no new OS ceremony. |
| **4 — Not worth it: R20 becomes Won't (new, per spec.md:701-702)** | Neither Start nor Stop nor Autostart ships from the board. The Schedule/Daemon card stays entirely read-only (today's status display, unchanged) plus the existing `jobbunny serve start`/`stop` hint text. R19 (live-daemon control — pause/resume/skip-next) is **unaffected and still ships** — it is a config-doc write, not a process-control write, and does not depend on this ruling at all. | **Zero** — no new capability, no new blast radius. | **Zero build cost.** The spec explicitly names this as a clean, non-stall outcome, not a failure (`spec.md:701-702`: *"If that ruling is 'not worth it,' R19 still ships and R20 becomes Won't — a clean outcome, not a stall."*). |

**Re-argued per BE-gate finding F2: Stop's "ships unconditionally" claim from
the original verdict does not survive as stated.** F1 established that Stop
is not a bare `SIGTERM` — it is `runServeStop`'s real 4-step lifecycle
(daemon kill-and-confirm, pidfile re-read, in-flight-child kill-and-confirm,
pidfile release). Spec §12 Phase 3 frames R20 as **one** bundled requirement
(start + stop + autostart, `spec.md:598`, Q4 rider) whose *mechanism* is
deferred to this gate — under Option 4 ("not worth it"), the spec's own
words are that **R20 becomes Won't**, which on a literal reading takes Stop
with it. **What I can say architecturally, without pre-deciding the user's
call: Stop is separable from Start's mechanism question** — nothing about
`runServeStop`'s reuse depends on which of Options 1/2/3 wins for Start, and
it is markedly lower-risk than Start (no spawn, no 35s wait, no OS-specific
ceremony — a well-precedented kill-and-confirm sequence the CLI already runs
today). **I recommend the user's ruling include Stop regardless of which
option is chosen for Start** — but this is a recommendation inside the
options above, not a fact I am entitled to bake into the rest of the
blueprint unconditionally. §3.37 has been amended accordingly: it now states
the dependency plainly rather than asserting it away.

**Recommendation for the ruling itself: Option 1**, with Stop shipped
regardless (see above). It is the only option that satisfies R20 as literally
stated (start, stop, *and* autostart from the board) without inventing new
OS-specific machinery — but the user should read its cost cell (corrected
above, F9) before ruling, not the original "lowest build cost" framing.

### (d) `userDataDir` resolution for R18

**Verdict: trivial, already effectively resolved by convention.** Production
composition (`src/cli/wire/compose.ts:241`) always sets `chromeUserDataDir:
path.join(root, 'chrome')`, where `root` is the resolved data home
(`resolveHome()`). `DEFAULT_USER_DATA_DIR` (`~/.jobbunny/chrome`, `src/
adapters/browser/cdp-chrome/launcher.ts:70`) is only an inert fallback for a
caller that supplies no override — it is **not** what production actually
uses, and must not be used by the board either (it would silently ignore
`JOBBUNNY_HOME`). `src/cli/wire/board.ts:181` already resolves `const root =
overrides.root ?? resolveHome()` at construction — the board's own `wireBoard`
already has everything needed. **Resolution: `path.join(root, 'chrome')`,
computed inside `wireBoard()`, mirroring `compose.ts:241` exactly.** Per
`adapters-no-cross-family`, this string is computed locally (not imported
from `cdp-chrome`), same discipline `LinkedinBreakerConfig.userDataDir`
already documents (`breaker_store.ts:49-54`).

### (e) Schedule pause — per-profile or machine-wide?

**Verdict: per-profile field (two of them); "machine-wide master" is
UI-only fan-out, not new stored state.**

- **Pause/resume a profile's schedule**: `profile.json.schedule.enabled`
  **already exists** (`src/core/config/schema.ts:12`) and **already gates**
  `isRunOwed` (`src/core/schedule/owed.ts:71`) and `scanProfileSchedules`
  (`src/ops/daemon/scan/scan.ts:71`). Writing `enabled: false` through the
  **existing** `PUT /api/profiles/:name/config/profile.json` is the entire
  mechanism. **Zero new backend work.**
- **Skip next run**: no existing field means this. New, small, additive:
  `schedule.skipNext: {date, slot} | null` (§3 steps 5-9) — checked by
  `isRunOwed` alongside `enabled`/`weekdays`, written through the **same
  existing** config PUT. Still zero write-surface expansion — it rides the
  endpoint that already exists.
- **"Pause all" (machine-wide master)**: **not a new stored flag.** It is the
  client fanning the *existing* per-profile `enabled: false` write out across
  every profile it knows about (from `GET /api/profiles`). This is a UI
  orchestration decision, not new BE surface — but it is **not atomic**: N
  sequential PUTs can partially fail. See §7 Failure Semantics.

---

## 1. Stack Summary

Confirmed CHANGE TO EXISTING, no new dependency, no stack question (spec §4).
Evidence for the pieces this blueprint touches, verified first-hand (not
recon-inherited):

- **Board HTTP server**: `src/app/server/server.ts:56-69` — `createBoardServer`
  composes `RouteDef[]` from each `app/features/<x>/index.ts`, binds
  `127.0.0.1` (`server.ts:54`). Every feature route factory takes the *same*
  `source: BoardSource` — new capabilities are added as new `BoardSource`
  methods, not new top-level server dependencies (confirmed:
  `BoardServerOptions` at `server.ts:35-45` carries only `source`, `logger`,
  `uiDir`, `host`, `version`).
- **Write surface, structural**: `src/ports/board.ts:143-227` — `BoardStore`
  writes only `tracking`; `BoardSource` writes config docs, run-intents,
  secrets, and guarded profile create/remove. `runDoctor`/`readDaemonStatus`
  are the existing precedent for **read-only additions to `BoardSource`**
  (`board.ts:224-227`) — every new read this blueprint adds follows that
  exact precedent.
- **Config docs**: `GET/PUT /api/profiles/:name/config/:doc`
  (`src/app/features/config/routes.ts:147-155`), `ConfigDocKey` = `'profile
  .json' | 'filter.json' | 'resume.json' | 'search_urls.md'`
  (`src/ports/config_store.ts:1-5`), validated by `validateConfigDoc`
  (`src/core/config/validators.ts:52-90`), 422 body `{error:{code:
  'validation', message}}` (`config/routes.ts:114`, `shared/http.ts:22-24`).
- **Sqlite**: `node:sqlite`, sync, `LATEST_SCHEMA_VERSION = 8`
  (`src/adapters/db/sqlite/store/migrations.ts:16`). `checkpoints` table
  (v2→v3 migration) already has `stage`, `position`, `run_date`, `time_dir`
  columns — this blueprint needs one new *query* against it, no `ALTER
  TABLE`.
- **Daemon**: tick loop every 30s (`src/ops/daemon/daemon.ts:62`), pidfile at
  `<root>/.jobbunny-daemon.pid` (`src/ops/daemon/pidfile.ts:176-178`),
  `GET /api/daemon` → `DaemonStatus` (`src/ports/board.ts:89-109`, route at
  `src/app/features/daemon/routes.ts:18-19`).
- **LinkedIn breaker**: file at `<userDataDir>/.jobbunny-linkedin-breaker
  .json` (`src/adapters/lanes/linkedin/breaker_store.ts:73-77`), pure derive
  function `breakerPhase(state, now, cooldownMs)` already exported
  (`breaker_store.ts:138-147`), cooldown constant `THROTTLE_COOLDOWN_MS = 4h`
  (`src/adapters/lanes/linkedin/throttle.ts:29`).
- **Chrome/CDP**: bounded reachability probe `defaultCdpReachable` (2s
  default `AbortSignal.timeout`, `src/adapters/browser/cdp-chrome/
  provider.ts:98-108`), reused unchanged by the existing `cdpReachableCheck`
  doctor check (`src/adapters/browser/cdp-chrome/check.ts`) — the exact idiom
  R17's probe must mirror. Chrome is **long-lived across runs** (reuse/recycle
  policy in `provider.ts:29-44`, no `.close()` call site found anywhere in
  the pipeline/compose layer) — a `[Check now]` probe will usually find a
  live Chrome to attach to, not need to launch one.
- **Boundary rules enforced by `npm run boundaries`** (`.dependency-cruiser
  .cjs`, cited throughout): `core-is-pure`, `ports-only-core`,
  `adapters-no-cross-family`, `adapters-only-ports-core`, `only-wire-imports-
  adapters` (the carve-out `cli/wire/*` — including `board.ts` — is where
  this blueprint's adapter reads are wired). Every step below states which
  rule it must respect.

---

## 2. Data Contracts

`existing` = read/write path already exists, unchanged, cited for product-ui.
`new` = this blueprint's contract, implementation step numbers in §3.

| Datum | Type | Endpoint / port shape | Source of truth | Status |
|---|---|---|---|---|
| Ranking lists (domain keywords, seniority targets, home cities, timezone lists, work-type prefs) | `RankConfig['title'\|'seniority'\|'location'\|'workTypePreference']` (`core/rank/rank.ts:65-172`) | `GET/PUT config/profile.json`, `settings.rank.*` | `profile.json` | existing |
| Point weights/denominators (skills, title, seniority, yoe, softVerdictPenalty) | same schema, other fields | same, raw-only per Q2(b) | `profile.json` | existing, **UI must not form-edit** |
| `filter.json.companies.avoid` | `string[]` | `GET/PUT config/filter.json` | `filter.json` | existing |
| `filter.json.timezones` (`accept`, `severity`) | `{accept: string[]; severity: 'hard'\|'soft'}` (`core/filter/config.ts:34-39`) | `GET/PUT config/filter.json` | `filter.json` | existing |
| **Timezone conflict set** (R2/C4) | derived: `{tz: string; severity: 'hard'\|'soft'}[]` (empty/absent when `filter.json.timezones` is undefined) — see corrected §0(a) | **computed client-side** from the two docs above, using `normalizeToken` from its own dependency-free module — see item (a) and F4's resolution below | derived, not stored | new (client-only, see §3.13, F4-amended) |
| Yield caps (`maxNewPerLane`, `maxProbesPerRun`, `maxCardsPerUrl`) | numbers, `settings.source`/`settings.linkedin` (`src/cli/wire/settings.ts:53,59,66`) | `GET/PUT config/profile.json` | `profile.json` | existing |
| `maxAgeDays` | number, `settings.linkedin` — **NOT a yield cap**, gates LinkedIn page-inventory staleness for a doctor check (`resolveInventoryMaxAgeDays`, `settings.ts:27-38`) | `GET/PUT config/profile.json` | `profile.json` | existing — **copy correction**: do not describe as limiting job count |
| **Cap-hit binding markers** (`maxNewPerLane`/`maxCardsPerUrl` hit on the last run) | `{maxNewPerLane: boolean; maxCardsPerUrl: boolean}` added to `SoftErrorSummary` | `GET /api/profiles/:name/runs/:id/soft-errors` (extended) | `run_events.msg` substring match, mirroring `hasBreakerMessage` | new (§3.10) |
| `maxProbesPerRun` cap-hit | — **no signal exists today** (silent `break`, `source.ts:205`) | same extended endpoint, once instrumented | new warn log + same substring match | new (§3.11) |
| LinkedIn pacing (jitter/inter-url ranges) | `{jitterMinMs,jitterMaxMs,interUrlDelayMinMs,interUrlDelayMaxMs}` (`settings.ts:116-129`, to be relocated) | `GET/PUT config/profile.json`, `settings.linkedin.*` | `profile.json` | existing write path, **new save-time validation** (§3.1-4) |
| Cleanup TTLs | numbers, `settings.cleanup.*` (`cleanup.ts:41-56`) | `GET/PUT config/profile.json` | `profile.json` | existing |
| Notion `mirror`/`dryRun` | booleans, `settings.notion.*` (`notion/connector.ts:26-33`) | `GET/PUT config/profile.json` | `profile.json` | existing |
| Connector (read-only display) | string | `GET config/profile.json`, `.connector` | `profile.json` | existing |
| Last-run funnel (`jobsIn`/`jobsOut`/`dropsByRule` per stage) | `RunResult` (`ops/observability/run/result.ts:4-20`) — opaque `unknown` at the port (`RunDetail.result`), concrete JSON at rest | `GET /api/profiles/:name/runs/:id` (`.result`) | `runs.result_json` | existing — **product-ui must hand-type `RunResult`'s shape in `ui/`** (cross-boundary, cannot import `ops/observability`) |
| Run list / last run id | `RunSummary[]` | `GET /api/profiles/:name/runs` | `runs` table | existing |
| **Filter-rule preview** (R15) | **`FilterPreviewResult`** — defined in `src/ports/board.ts` (alongside `DaemonStatus`), re-exported by the new `src/app/features/preview/index.ts` (BE-gate bounce, UI-gate F6) | `POST /api/profiles/:name/preview/filter` — response body IS `FilterPreviewResult` directly, no envelope | derived from a checkpoint, never stored | new (§3.28-33) |
| Daemon status (state, pid, lastTickAt, inFlight, per-profile schedule) | `DaemonStatus` (`ports/board.ts:89-109`) | `GET /api/daemon` | pidfile + per-profile `runs` | existing |
| `schedule.enabled` (pause/resume) | boolean | `GET/PUT config/profile.json` | `profile.json` | existing |
| **`schedule.skipNext`** (skip-next-run) | `{date: string; slot: string} \| null` | `GET/PUT config/profile.json` | `profile.json` | new field (§3.5-9) |
| **Breaker status** (R18) | **`BreakerStatus`** = `{phase: 'closed'\|'open'; reopenAt: string \| null}` — defined in `src/ports/board.ts`, re-exported by the new `src/app/features/linkedin/index.ts` (BE-gate bounce, UI-gate F6) | `GET /api/linkedin/breaker` — response body IS `BreakerStatus` directly | `<chrome>/.jobbunny-linkedin-breaker.json` | new (§3.14-19) |
| **LinkedIn session health** (R17) | **`LinkedinSessionStatus`** = `{state: 'signed-in'\|'signed-out'\|'unknown'; checkedAt: string \| null}` — defined in `src/ports/board.ts`, re-exported by the new `src/app/features/linkedin/index.ts` (same barrel as `BreakerStatus`) | `GET /api/linkedin/session` (cached), `POST /api/linkedin/session/check` (probe now) — both response bodies ARE `LinkedinSessionStatus` directly | in-memory (never persisted) | new (§3.20-23) |
| Doctor findings | `DoctorReport` (`ports/doctor.ts`) | `GET /api/profiles/:name/doctor` | live checks | existing |
| Secrets presence | `SecretPresence` | `GET /api/secrets`, `PUT /api/secrets/:key` | `.env` | existing |
| **Daemon start/stop** (R20) | **`StopDaemonOutcome`** = `{outcome:'stopped'}\|{outcome:'already_stopped'}\|{outcome:'daemon_unresponsive'}\|{outcome:'child_unresponsive'; childPid:number}` (F1-amended shape, §3.38) and **`StartDaemonOutcome`** = `{outcome:'started'\|'already_running'\|'spawn_failed'}` — **both defined in `src/ports/board.ts`**, re-exported by `src/app/features/daemon/index.ts` **in addition to** its existing `makeDaemonRoutes` export (BE-gate bounce, UI-gate F6 — that barrel currently exports no types at all) | `POST /api/daemon/stop` — response body IS `StopDaemonOutcome` directly; `POST /api/daemon/start` — response body IS `StartDaemonOutcome` directly | pidfile + process | new (§3.37-40), Stop's shipping is a §0(c) sub-choice, Start conditional |
| **Autostart toggle** | **`AutostartOutcome`** = `{outcome: 'ok'\|'unsupported_platform'}` — defined in `src/ports/board.ts`, re-exported by `src/app/features/daemon/index.ts` (same barrel as the two outcomes above — named `AutostartOutcome` to match what product-ui's own blueprint already assumes, per the UI-gate ruling's F4) | `PUT /api/daemon/autostart` — response body IS `AutostartOutcome` directly | LaunchAgent plist (darwin only) | new (§3.41-42), **CONDITIONAL on §0(c) ruling — part of the same bundled R20 Must, per `spec.md:598`** |
| Profile create/remove | — | `POST /api/profiles`, `DELETE /api/profiles/:name` | filesystem + db | existing |

---

## 3. Implementation Steps

Dependency-ordered, one file of focus each, colocated tests included. Grouped
by spec phase for traceability; the phase label does not imply these must
ship as separate PRs.

### R13 — hoist LinkedIn pacing validation to save time (Phase 1)

1. **`src/core/config/linkedin_pacing/index.ts` (new module, in its own
   subfolder — BE-gate finding F8).** `src/core/config/` already holds
   exactly two impl files (`schema.ts`, `validators.ts`) — its own two-pair
   cap. Adding a third impl file directly in that folder would violate the
   convention ("a folder exceeding two implementation files … gets split
   into subfolders first"); the repo's own precedent for this exact move is
   `async/race_with_timeout.ts`'s split comment and `.dependency-cruiser
   .cjs:53-68`'s `builders.ts`/`migrate.ts`/`daemon_deferred.ts` splits.
   **Resolution: a new subfolder-module, not a fourth flat file** —
   `core/config/linkedin_pacing/index.ts` (+ colocated
   `linkedin_pacing.test.ts` inside the same subfolder), which does not
   count against `core/config/`'s own 2-impl-file cap (a subfolder is a
   nested module, not a flat impl file in the parent — the same shape
   `core/schedule/`, `core/filter/`, `core/rank/` already use). Move
   `LinkedinPacingSettingsSchema` (currently unexported, `src/cli/wire/
   settings.ts:116-129`) and its four `DEFAULT_*_MS` constants here,
   **exported** this time. `core/` may not import `cli/wire/`
   (`core-is-pure`), which is why this must move down rather than
   `validators.ts` reaching up.
   **Acknowledged tension, recorded rather than silently resolved (BE-gate
   finding F14):** `core/config/schema.ts`'s own doc comment and
   `cli/wire/settings.ts:29-31` both state that adapter-specific settings
   shapes are adapter-owned and deliberately **not** imported into `core/`.
   This schema describes the LinkedIn lane's pacing tunable, which is
   adapter-shaped in spirit — but it is **not currently defined inside
   `adapters/lanes/linkedin/`** at all (it already lives in `cli/wire/
   settings.ts`, one layer removed from the adapter, unlike
   `NotionConnectorSettingsSchema`/`TelegramNotifierSettingsSchema`, which
   *are* defined inside their owning adapter files). Moving it to `core/`
   is mechanically legal under `core-is-pure` and is the only placement
   `validators.ts` can reach for save-time validation (R13) — but it is a
   real, acknowledged exception to the documented intent, not a clean fit.
   Add a short comment to the new module's own doc header naming this
   exception explicitly (one sentence: "lives in `core/` rather than inside
   the LinkedIn adapter because `core/config/validators.ts` must reach it at
   save time and `core-is-pure` forbids the reverse import — see
   blueprint-be.md §3.1"), so a future reader does not mistake it for an
   oversight. Colocated test: `linkedin_pacing.test.ts` — valid range
   parses, `jitterMinMs > jitterMaxMs` throws with the existing message
   text, missing keys default quietly (port the 3-4 cases already covered
   in `settings.test.ts`).
2. **`src/cli/wire/settings.ts` — edit.** Replace the local
   `LinkedinPacingSettingsSchema` definition and its four `DEFAULT_*_MS`
   consts with an import from `core/config/linkedin_pacing/index.ts`.
   `resolveJitterRange`/`resolveInterUrlDelayRange` (lines 134-147) keep
   their exact signatures and behavior — this step is a pure relocation, not
   a behavior change. Re-run `settings.test.ts` unmodified; it must still
   pass byte-for-byte (proves the relocation didn't change behavior).
3. **`src/core/config/validators.ts` — edit.** In the `'profile.json'` case
   (lines 58-69), after `PipelineConfigSchema.parse` succeeds, add: parse
   `parsed.settings.linkedin` through the relocated
   `LinkedinPacingSettingsSchema` inside the same try/catch, converting a
   thrown zod error into `profile.json is invalid: <zod message>` — same
   pattern already used for the sqlite-path-retired check at lines 65-67.
   Missing `settings.linkedin` must default quietly (matches
   `resolveJitterRange`'s own `settings ?? {}` posture) — only a
   *present-but-invalid* value throws.
4. **`src/core/config/validators.test.ts` — edit.** Add: a profile.json with
   `jitterMinMs: 15000, jitterMaxMs: 12000` is rejected at
   `validateConfigDoc` time with a message naming both fields (mirrors the
   spec's own named acceptance case, §11 R13); a profile.json with no
   `settings.linkedin` at all still validates; a profile.json with a valid
   range still validates.

### R19 "skip next run" (Phase 3, but the field itself has no phase gate)

5. **`src/core/config/schema.ts` — edit.** Add to `ScheduleSchema` (line
   10-15): `skipNext: z.object({ date: z.string(), slot: z.string() })
   .nullable().default(null)`. Optional field, backward-compatible — every
   existing `profile.json` without it parses unchanged (zod `.default(null)`
   on a missing key).
6. **`src/core/config/schema.test.ts` — edit.** Add: a schedule with no
   `skipNext` key parses with `skipNext: null`; a schedule with a valid
   `skipNext` object round-trips.
7. **`src/core/schedule/types.ts` — edit.** Add `skipNext: { date: string;
   slot: string } | null` to `ProfileSchedule` (line 15-21).
8. **`src/ops/daemon/scan/scan.ts` — edit.** At the object literal around
   lines 75-78 (where `enabled`/`times`/`weekdays`/`graceMinutes` are copied
   from the parsed schedule into `ProfileSchedule`), add `skipNext:
   schedule.skipNext ?? null`.
9. **`src/core/schedule/owed.ts` — edit.** In `isRunOwed`'s per-schedule loop
   (lines 70-83), add one more `continue` guard alongside the existing
   `enabled`/`weekdays` checks: skip a slot when `schedule.skipNext` is
   non-null and `schedule.skipNext.date === date && schedule.skipNext.slot
   === slot`. Pure, no I/O — matches the file's existing purity contract.
   `owed.test.ts` — edit: add a case where a matching `skipNext` suppresses
   an otherwise-owed slot, and a case where a non-matching (past-date, or
   different-slot) `skipNext` has no effect (self-inert once its date has
   passed — no separate cleanup mechanism needed, since `isRunOwed` only ever
   evaluates against *today's* date).

Write path for `skipNext` is the **existing** `PUT config/profile.json` — no
new route, no write-surface expansion.

### Cap-hit binding markers (R6/G2, Phase 1)

10. **`src/app/features/runs/soft_errors.ts` — edit.** Add a new const array
    `CAP_MESSAGE_SUBSTRINGS` mirroring `BREAKER_MESSAGE_SUBSTRINGS` (lines
    46-50): `'source: maxNewPerLane cap hit'`, `'linkedin lane: maxCardsPerUrl
    cap hit'` (exact substrings from `source.ts:292` and
    `fire/loop/cards.ts:53` respectively — verify byte-exact against those
    two lines before committing the constant, the same discipline
    `BREAKER_MESSAGE_SUBSTRINGS`'s own comment insists on). Add a pure
    function `capsHit(events: RunEventRow[]): {maxNewPerLane: boolean;
    maxCardsPerUrl: boolean}` mirroring `hasBreakerMessage` (lines 52-56).
    Add `capsHit` to `SoftErrorSummary` (line 23-38) and populate it in
    `groupSoftErrors`'s return.
11. **`src/pipeline/stages/source.ts` — edit.** At the `maxProbesPerRun`
    break point (line 205, `if (probesIssued >= opts.maxProbesPerRun)
    break;`), add one `ctx.logger.warn('source: maxProbesPerRun cap hit —
    stopping probes for this run', { maxProbesPerRun: opts.maxProbesPerRun
    });` immediately before the `break`, mirroring the existing
    `maxNewPerLane` warn's exact idiom (lines 291-293). **Instrumentation
    only — no control-flow change**, low blast radius per the stability
    principle (adds observability, does not alter what the stage does).
    `source.test.ts` — edit: assert the new warn fires exactly when the
    `maxProbesPerRun` cap is hit, with the configured value in `data`.
12. **`src/app/features/runs/soft_errors.test.ts` — edit.** Add coverage for
    `capsHit` (each of the two flags true/false independently, and both
    absent → both false).
13. **Superseded by BE-gate finding F4 — do not deep-import `core/jd/
    normalize.ts`.** The original step 13 proposed importing
    `src/core/jd/normalize.ts` directly from `ui/` and amending CLAUDE.md to
    bless that file specifically. Two problems, both real: (i)
    `src/core/jd/index.ts:1-2` is `export * from './normalize.ts'; export *
    from './schema.ts'` — `schema.ts` imports `zod` — so a deep import of
    `normalize.ts` alone reaches *past* the module's own public surface
    (`index.ts`), which is exactly the two-pair rule's "internals aren't
    imported across module boundaries" clause, and every one of the 13
    existing `ui/` → `core/` imports goes through a module `index.ts`
    (`src/core/datetime/index.ts`), none through a bare file. (ii) amending
    CLAUDE.md's own dependency-free-module rule to carve out one file, one
    time, for one feature, enshrines the violation inside the text of the
    rule that's supposed to prevent it.
    **Resolution — one mechanism, named precisely: extract `normalizeToken`
    into its own dependency-free core module with a real `index.ts`.**
    New: `src/core/normalize_token/index.ts` (module name deliberately not
    `core/jd/normalize_token/` — it must NOT be nested under `core/jd/`,
    because nesting it there still puts it behind `core/jd/index.ts`'s
    public surface, which pulls in `schema.ts`/zod on any `import * from
    './jd'`-shaped re-export; it needs to be a **sibling** of `core/jd/`,
    fully independent). Move `normalizeToken` (currently `core/jd/
    normalize.ts:6-9`) into this new module's `index.ts`, verbatim, zero
    behavior change. `core/jd/normalize.ts` re-exports it (`export {
    normalizeToken } from '../normalize_token/index.ts';`) so every existing
    internal caller (`core/filter/rules/timezone.ts:15-16`,
    `core/filter/rules/company.ts`, `core/company/*`) keeps compiling
    unchanged — this is a pure extraction, not a rename at any existing call
    site. Colocated `normalize_token.test.ts` (or `index.test.ts` inside the
    subfolder) — port `normalize.test.ts`'s existing `normalizeToken` cases
    unchanged.
    **Then**, in the same change that lands the S2 conflict-notice client
    logic, add one line to CLAUDE.md's "`ui/` may import `src/core/**`"
    paragraph naming `src/core/normalize_token/` (the whole module, via its
    `index.ts`) as the second dependency-free, ui-importable core module —
    this now genuinely matches the rule as written ("a `core` **module** the
    SPA imports"), not a carve-out for one file past a module boundary.
    `ui/` imports `normalizeToken` from `core/normalize_token/index.ts`,
    never from `core/jd/`.

### Breaker status (R18, Phase 2)

14. No sqlite/schema change. `readBreaker`/`breakerPhase` already exported
    and already degrade correctly (`breaker_store.ts:109-147`) — reuse
    verbatim, do not reimplement.
15. **`src/ports/board.ts` — edit.** **Named type, per BE-gate bounce
    (UI-gate F6) — pin `export interface BreakerStatus { phase: 'closed' |
    'open'; reopenAt: string | null; }`** alongside `DaemonStatus` (same
    file, same export style — `DaemonStatus` itself is defined at lines
    89-109, this is the same kind of addition). Add to `BoardSource` (after
    `readDaemonStatus`, following its exact read-only-addition precedent,
    lines 264-267): `readBreakerStatus(): Promise<BreakerStatus>`. Doc
    comment: never throws; a missing or corrupt file reads as `'closed'`
    (matches `readBreaker`'s own contract); `'half-open'` (post-cooldown,
    pre-probe) is folded into `'closed'` for display — a judgment call,
    recorded in §9 NOTES, since the board never triggers or observes the
    half-open probe itself.
16. **New `src/cli/wire/board_linkedin.ts` (new sibling module — BE-gate
    finding F8).** `src/cli/wire/board.ts` is **388 lines** against the
    repo's 400-line impl-file cap (`npm run filesize`, gated inside `npm
    test`/`npm run check`) — this blueprint's LinkedIn work alone (breaker
    read + session cache-read + session probe, steps 16-23) plus the R15
    preview (step 32) plus daemon control (steps 38, 40-41) would add
    **seven** new method implementations directly into that one file,
    blowing the cap outright. **Resolution, mirroring the file's own
    existing precedent** — `board.ts` already delegates
    `readDaemonStatus`/`runDoctor` to sibling files `board_daemon.ts`/
    `board_doctor.ts` rather than implementing them inline. Apply the same
    pattern: a new sibling, `src/cli/wire/board_linkedin.ts`, exporting
    `readBoardBreakerStatus(deps: {root: string}): {phase: 'closed' |
    'open'; reopenAt: string | null}`. Inside it, compute `const
    chromeUserDataDir = path.join(root, 'chrome')` (mirrors `compose.ts:241`
    exactly — see §0(d)); call `readBreaker(chromeUserDataDir,
    defaultLinkedinBreakerDeps())`, then `breakerPhase(state, new Date(),
    THROTTLE_COOLDOWN_MS)`; map `'open'` → `{phase:'open', reopenAt: new
    Date(Date.parse(state.openedAt) + THROTTLE_COOLDOWN_MS).toISOString()}`,
    `'closed'` or `'half-open'` → `{phase:'closed', reopenAt: null}`.
    Imports: `readBreaker`, `breakerPhase`, `defaultLinkedinBreakerDeps` from
    `adapters/lanes/linkedin/breaker_store.ts`, `THROTTLE_COOLDOWN_MS` from
    `adapters/lanes/linkedin/throttle.ts` — permitted here because
    `cli/wire` is the documented exception to `only-wire-imports-adapters`;
    this is **not** a violation of `adapters-no-cross-family` (that rule
    forbids one *adapter* importing another adapter family; `cli/wire` is
    not an adapter). `src/cli/wire/board.ts` itself only gains a **thin**
    `readBreakerStatus(): Promise<...>` method whose body is a one-line
    delegation to `readBoardBreakerStatus({root})`, exactly mirroring how
    `readDaemonStatus()` delegates to `readBoardDaemonStatus`.
17. **New `src/app/features/linkedin/routes.ts` + `index.ts`.** Single route:
    `GET /api/linkedin/breaker` → `{status: 200, body: await source
    .readBreakerStatus()}`. Mirror `daemon/routes.ts`'s exact shape (single
    handler function + `makeXRoutes(source)` factory, no `service.ts` — two-
    pair rule, this folder starts life as the doctor/daemon-style 3-file
    slice: `routes.ts` + `routes.test.ts` + `index.ts`).
    **`index.ts`'s exact contents, per BE-gate bounce (UI-gate F6) — mirror
    `app/features/config/index.ts`'s own convention exactly**
    (`export type { BoardProfile } from '../../../ports/board.ts';` +
    `export { makeConfigRoutes } from './routes.ts';`):
    ```ts
    export type { BreakerStatus } from '../../../ports/board.ts';
    export { makeLinkedinRoutes } from './routes.ts';
    ```
    (`LinkedinSessionStatus` is added to this same export-type line at
    step 22, once the session routes land in the same file.)
18. **`src/app/server/server.ts` — edit.** Import `makeLinkedinRoutes` from
    `../features/linkedin/index.ts`; add `...makeLinkedinRoutes(source)` to
    the `routes` array (after `makeDaemonRoutes`, same grouping as the
    ops-surface routes).
19. **`src/app/features/linkedin/routes.test.ts` — new.** Cover: breaker
    open → `{phase:'open', reopenAt: <iso>}`; breaker file absent →
    `{phase:'closed', reopenAt:null}`; corrupt breaker file → same closed
    result (never a 500).

### LinkedIn session health (R17, Phase 2)

20. **`src/adapters/browser/cdp-chrome/session_check.ts` — new file.**
    Exported function `checkLinkedinSession(deps: {reachable:
    CdpReachableFn; connect: ConnectFn; cdpUrl: string; cookieDomainSuffix:
    string; cookieName: string; timeoutMs?: number}): Promise<'signed-in' |
    'signed-out' | 'unknown'>`. Algorithm: (1) `await deps.reachable(deps
    .cdpUrl)` — reuses `defaultCdpReachable`'s exact bounded idiom
    (`provider.ts:98-109`, 2s default via `AbortSignal.timeout`); `null`
    result → return `'unknown'` immediately, **never call connect, never
    launch anything**. (2) On reachable, `const browser = await deps.connect
    (deps.cdpUrl)` wrapped in the existing `raceWithTimeout` helper
    (`adapters/browser/cdp-chrome/async/race_with_timeout.ts:15-28` —
    already exists, reuse it, do not write a new timeout wrapper) with
    `deps.timeoutMs ?? 3000`. On timeout or any connect error → `'unknown'`.
    **Deliberate deviation, named per BE-gate finding F6:** unlike the rest
    of this codebase's "AbortSignal is the deadline mechanism everywhere"
    convention, this bound is a **timer race** (`raceWithTimeout`'s
    `Promise.race` against a `setTimeout`), not an `AbortSignal` — because
    playwright's `connectOverCDP` accepts no signal/abort option.
    `raceWithTimeout`'s own doc comment (`race_with_timeout.ts:11-13`) is
    explicit that the losing `task` "is left to settle on its own time" —
    a timed-out `connectOverCDP` call is not cancelled, only ignored; this
    is the same precedented deviation `connectWithRetry` already accepts
    elsewhere in this adapter family, reused here rather than invented.
    (3) On a successful connect, get the contexts **defensively** —
    `CdpBrowser.contexts` is itself `.optional()` on the interface
    (`provider.ts:72` — BE-gate finding F14): `const contexts =
    browser.contexts?.() ?? []`; if `contexts.length === 0` → `'unknown'`
    (no persistent context to inspect, not evidence of signed-out). Else
    read `await contexts[0].cookies()` (a **new** method on the
    `CdpBrowserContext` interface — widen it additively at `provider.ts:61-
    63`; grep confirms this interface is referenced only at `provider.ts:
    61,72,73` with no test fakes implementing it today, so the widen breaks
    nothing — F14, verified). Filter for a cookie whose `name ===
    deps.cookieName` and `domain` ends with `deps.cookieDomainSuffix`. Found
    → `'signed-in'`; not found → `'signed-out'`. Any exception at this step
    → `'unknown'` (never let a cookie-read failure masquerade as signed-out —
    matches spec AC15). (4) **New, per BE-gate finding F6 — always
    disconnect before returning**, on every branch past a successful
    connect (signed-in, signed-out, or a cookie-read exception): call the
    CDP browser's own disconnect/close (playwright's `browser.close()` on a
    `connectOverCDP`-returned handle detaches the CDP session without
    killing the underlying Chrome process — verify this exact non-killing
    semantic against playwright's docs/existing test doubles at
    implementation time, since it is the one claim in this step not
    independently verified against this repo's own code). Wrap the
    disconnect itself in a try/catch that swallows any error — a failed
    disconnect must never flip an otherwise-good `'signed-in'`/`'signed-out'`
    result to `'unknown'`, and must never throw out of this function.
    **Never call `launchChrome`** at any point in this function. Colocated
    `session_check.test.ts`: unreachable → unknown (connect never called,
    assert via a spy); reachable + connect timeout → unknown; reachable +
    empty `contexts()` → unknown; reachable + cookie present → signed-in,
    **and disconnect was called**; reachable + cookie absent → signed-out,
    **and disconnect was called**; reachable + `cookies()` throws →
    unknown, **and disconnect was still called** (proves the new step 4 runs
    on the error path too, not just the happy path).
21. **`src/ports/board.ts` — edit, same pin as step 15.** **Named type, per
    BE-gate bounce (UI-gate F6) — `export interface LinkedinSessionStatus {
    state: 'signed-in' | 'signed-out' | 'unknown'; checkedAt: string |
    null; }`**, alongside `BreakerStatus`. Add to `BoardSource`:
    `readLinkedinSession(): Promise<LinkedinSessionStatus>` and
    `checkLinkedinSessionNow(): Promise<LinkedinSessionStatus>`.
    **New `src/cli/wire/board_linkedin.ts` — edit (same new sibling file as
    step 16, F8).** Module-level (or closure-scoped, constructed once inside
    `wireBoard`) in-memory cache: `let sessionCache: LinkedinSessionStatus =
    {state: 'unknown', checkedAt: null}`. **Deliberately not persisted** — a
    board restart resets to unknown, which is the honest state (no evidence
    yet), not an error. Export `readBoardLinkedinSession(): LinkedinSessionStatus`
    (returns the cache, no probe) and `async checkBoardLinkedinSessionNow
    (deps: {source: BoardSource; probe: typeof checkLinkedinSession; ...})
    : Promise<LinkedinSessionStatus>`.
    **Gate widened per BE-gate finding F7 — `inFlight` alone is
    insufficient.** `DaemonStatus.inFlight` (`ports/board.ts:107`) is read
    from the **daemon's own pidfile** and therefore covers only
    daemon-spawned runs — a CLI-initiated `jobbunny run`, or any run while
    the daemon is stopped, reads `inFlight: null` even though it genuinely
    owns Chrome. Before probing, check **both**: (i)
    `(await source.readDaemonStatus()).inFlight !== null`, and (ii) for
    every profile in `await source.listProfiles()`, whether that profile's
    own most recent run is `status === 'running'` (`RunSummary.status`,
    `ports/run_store.ts:22`, `'crashed'` derived on a stale heartbeat so a
    genuinely wedged run does not permanently block the probe) — reuse the
    **exact** existing idiom `app/features/intents/routes.ts:48-65`'s
    `postHandler` already uses for its own running-run guard
    (`store.listRuns({limit:1,offset:0})`, check
    `rows[0]?.status === 'running'`), looped over every profile rather than
    one. If **either** signal is true, skip the probe entirely and return
    the **existing** cached value unchanged (never touch Chrome while any
    run, daemon- or CLI-spawned, owns it, per the one-Chrome invariant).
    Else call `checkLinkedinSession(...)` with `cookieName`/
    `cookieDomainSuffix` constants (LinkedIn's session cookie — confirm the
    exact cookie name at implementation time against a real logged-in
    `.chrome-debug` profile before hardcoding; do not guess a literal here),
    update `sessionCache = {state, checkedAt: new Date().toISOString()}`,
    return it. `src/cli/wire/board.ts` gains only two thin delegating
    methods, `readLinkedinSession()`/`checkLinkedinSessionNow()`, each a
    one-line call into this sibling — mirroring step 16's delegation
    pattern.
22. **New `src/app/features/linkedin/routes.ts` — edit (same file as step
    17, or split into `session_routes.ts`/`breaker_routes.ts` if the two-file
    cap is hit — check file size after adding this).** Add: `GET
    /api/linkedin/session` → `source.readLinkedinSession()`; `POST
    /api/linkedin/session/check` → `source.checkLinkedinSessionNow()`.
    **`index.ts`'s type-export line (from step 17) widens, per BE-gate
    bounce (UI-gate F6):**
    ```ts
    export type { BreakerStatus, LinkedinSessionStatus } from '../../../ports/board.ts';
    export { makeLinkedinRoutes } from './routes.ts';
    ```
    (If the file split named in this step happens, the type-export line in
    `index.ts` is unaffected either way — it re-exports from `ports/
    board.ts`, not from whichever `routes.ts` file implements the handler.)
23. **`src/app/features/linkedin/routes.test.ts` — edit.** Cover: GET
    returns the cache without probing (assert the injected probe function is
    never called); POST probes and updates the cache; POST while a run is
    daemon-`inFlight` returns the stale cache and does not probe (assert via
    spy); POST while a run is CLI-initiated (`inFlight: null` but some
    profile's `RunSummary.status === 'running'`) **also** returns the stale
    cache and does not probe — this is the case F7 exists to close, must not
    regress silently.

### R15 filter-rule preview (Phase 1's spike, largest new surface)

28. **`src/ports/checkpoint_store.ts` — edit.** Add to `CheckpointStore`
    (after `readLatest`, same doc-comment discipline): `readAt(runDate:
    string, timeDir: string, stage: string): { ref: CheckpointRef; payload:
    unknown } | undefined`. Doc comment: the highest-`position` row matching
    `stage` in this group (defensive against a theoretical same-stage retry
    within one group), or `undefined` if no such row exists. **Read-only
    addition — `write`/`readLatest`/`pruneOlderThan`/every other method on
    this port is untouched.**
29. **`src/adapters/db/sqlite/checkpoints/store.ts` — edit.** Implement
    `readAt`: `SELECT * FROM checkpoints WHERE run_date = ? AND time_dir = ?
    AND stage = ? ORDER BY position DESC LIMIT 1`, same row-to-`{ref,
    payload}` mapping `readLatest` already uses (reuse its private mapping
    helper if one exists, do not duplicate the parse logic).
30. **`src/adapters/db/sqlite/checkpoints/store.test.ts` — edit.** Add:
    `readAt` finds the `'assemble'` checkpoint by name within a group that
    also has `'filter'`/`'dedup'`/etc rows (proves it's not just returning
    latest); returns `undefined` for a stage never written in that group;
    returns `undefined` for an unknown `(runDate, timeDir)`.
30a. **Comment updates, same change as step 28 — BE-gate finding F13.** Two
    existing contract comments assert an invariant `readAt` breaks and must
    be corrected in the **same** change that lands it, per CLAUDE.md's
    "architecture docs as code" convention: (i)
    `src/routines/cleanup/cleanup.ts:14-17` ("every checkpoint read path …
    only ever looks at the *same-day* latest checkpoint, so retaining rows
    for the 30-day `runsOlderThanDays` window was pure dead weight") and
    (ii) `src/ports/checkpoint_store.ts:46-62`'s `latestTimeDir`/
    `latestCheckpointTimeDir` doc comments, which carry the same "every
    caller wants the latest" framing. Both need one clause each noting that
    `readAt` (R15's preview) is a **deliberate exception** — it reads a
    named, possibly non-latest stage's checkpoint from within the *last 5
    days'* runs, not same-day-latest — so the `checkpointsOlderThanDays`
    TTL (default 2 days, `cleanup.ts:53`) is what actually bounds R15's
    reach, not this file's "same-day only" framing. Do not change the TTL
    itself or any pruning behavior — this is a comment-accuracy fix only.
31. **`src/ports/board.ts` — edit.** Add to `BoardSource`: `previewFilterRule
    (name: string, draftFilterConfig: unknown): Promise<FilterPreviewResult>`
    where
    ```ts
    export type FilterPreviewResult =
      | { available: true; totalJobs: number; baselineDrops: number;
          draftDrops: number; newlyDropped: Array<{ title: string; company: string }> }
      | { available: false; reason: 'no_recent_run' | 'checkpoint_expired' };
    ```
    `newlyDropped` capped at 12 entries (matches the mockup's disclosure,
    `ux-notes.md` §8 "see which 12 →"). **`FilterPreviewResult` does not
    exist in the repo today — THIS STEP CREATES IT in `ports/board.ts`**
    (zero hits for `FilterPreviewResult` in `src/ports/board.ts` as of this
    writing, per UI-gate finding R2-F6). The BE-gate bounce (UI-gate F6)
    additionally pins where it's re-exported from once authored: the new
    `src/app/features/preview/index.ts`, see step 33.
32. **New `src/cli/wire/board_preview.ts` — new sibling module (BE-gate
    finding F8 — see step 16's rationale; `board.ts` cannot absorb this
    implementation either).** Export `previewFilterRule(deps: {source:
    BoardSource; ...}, name: string, draftFilterConfig: unknown): Promise
    <FilterPreviewResult>`: (1) validate `draftFilterConfig` via
    `FilterConfigSchema.safeParse` — on failure, throw (caller/route turns
    this into 422, same posture as `writeConfigDoc`'s validator-throw
    contract); (2) open a short-lived `RunStoreReader` for `name` (reuse
    whatever the profile's `openStore` already exposes, or a dedicated
    short-lived reader mirroring `readConfigDoc`'s close-in-`finally`
    posture) and call `listRuns({limit: 5})`; (3) open a short-lived
    checkpoint store for the profile (same root-relative path convention
    every other per-profile store uses); for each run newest-first, try
    `checkpointStore.readAt(run.date, run.timeDir ?? '', 'assemble')` —
    first hit wins, stop iterating; no hit across all 5 →
    `{available:false, reason:'no_recent_run'}` if no run exists at all,
    else `{available:false, reason:'checkpoint_expired'}`; (4) on a hit,
    parse `payload` defensively as `{jobs: unknown[]; dropped: unknown[]}`
    (never trust it blindly — a checkpoint payload is opaque `unknown` at
    the port boundary by design) — malformed payload also degrades to
    `checkpoint_expired`, never throws; **(4a) new, per BE-gate finding
    F5 — narrow to structured jobs before evaluating.**
    `pipeline/runner/stage.ts:12-15`'s `StagePayload.jobs` is typed `JD[]`,
    and `JD.structured` is `.optional()` (`core/jd/schema.ts:80`) — a `JD`
    with no `structured` slice satisfies `StagePayload` but **not**
    `StructuredJD` (`schema.ts:101`), and `core/filter/engine.ts:20`'s
    `evaluate(jd: StructuredJD, …)` plus `rules/timezone.ts:12`'s
    destructure of `jd.structured` both assume it is present. In the
    frozen pipeline order the `assemble`-stage checkpoint's jobs *should*
    all have run through `structure` already — but "should" is not a type
    guarantee against an opaque `unknown` payload, and one malformed entry
    must not crash the whole preview. **Filter the parsed job array with an
    explicit narrowing guard — `(jd): jd is StructuredJD => jd.structured
    !== undefined` — before calling `evaluate()`, and drop (do not throw
    on) any entry that fails it.** If the guard drops **every** entry
    (payload was entirely unstructured — a genuinely corrupt or
    unexpected checkpoint), degrade to `{available:false, reason:
    'checkpoint_expired'}` rather than reporting a preview over zero jobs
    as if it were meaningful; (5) read the profile's **current**
    `filter.json` via the existing `readConfigDoc`; (6) run `core/filter`'s
    `evaluate()` + `decide()` (imported directly — `app`/`cli/wire` may
    import `core` freely) over every **narrowed, structured** job from
    (4a), twice — once with the current config, once with the validated
    draft; count `decide()==='drop'` for each; build `newlyDropped` from
    jobs that drop under the draft but not the current config, capped at
    12, `{title: jd.identity.title, company: jd.identity.company}`.
    `src/cli/wire/board.ts` gains only a thin `previewFilterRule(...)`
    delegating method, mirroring steps 16/21's pattern.
33. **`src/app/features/preview/routes.ts` + `index.ts` — new.** `POST
    /api/profiles/:name/preview/filter`, body = draft filter config JSON.
    Handler: `await source.previewFilterRule(name, req.body)`; on the
    validator throw, catch and re-throw as `HttpError(422, 'validation',
    message)` (same envelope as config PUT). Two-pair slice:
    `routes.ts` + `routes.test.ts` + `index.ts`.
    **`index.ts`'s exact contents, per BE-gate bounce (UI-gate F6) — same
    convention as `linkedin/index.ts` (step 17) and `config/index.ts`:**
    ```ts
    export type { FilterPreviewResult } from '../../../ports/board.ts';
    export { makePreviewRoutes } from './routes.ts';
    ```
34. **`src/app/server/server.ts` — edit.** Register `...makePreviewRoutes
    (source)`.
35. **`src/app/features/preview/routes.test.ts` — new.** Cover: happy path
    (draft drops more than baseline, `newlyDropped` populated, capped at
    12); no run yet for the profile → `available:false/no_recent_run`;
    checkpoint pruned/missing → `available:false/checkpoint_expired`;
    malformed draft body → 422 with a message naming the field; **new, F5
    — a checkpoint payload containing one job with no `structured` slice
    is silently dropped from the count (not a 500), and a payload that is
    entirely unstructured degrades to `available:false/checkpoint_expired`
    rather than a preview over zero jobs.**
36. **Explicitly not built**: rank re-scoring preview. No mockup screen
    requests it (§8 Out of Scope).

### R20 daemon control (Phase 3 — gated by the §0(c) USER ruling; see the
re-argument in §0(c) for exactly what is and isn't conditional)

**Nothing in steps 37-42 is built until the user rules on §0(c).** Step 37 is
marked *recommended-unconditional* rather than *unconditional* — see the
re-argument in §0(c): under Option 4 ("R20 becomes Won't"), the spec's own
words take the whole bundled requirement with it, Stop included. What
survives regardless of the ruling is only the **design** below — it does not
depend on which of Options 1/2/3/4 is chosen except where stated.

37. **`src/app/features/daemon/routes.ts` — edit.** Add `POST /api/daemon/
    stop`. **Recommended to ship regardless of which Option the user picks
    for Start — but this is the blueprint's recommendation inside §0(c), not
    a pre-decided fact; if the user's ruling is Option 4, this step does not
    ship either** (re-argued per BE-gate finding F2). Handler calls a new
    `BoardSource.stopDaemon(): Promise<StopDaemonOutcome>` (outcome type
    below, F1).
38. **`src/ports/board.ts` — edit, same pin as steps 15/21 (BE-gate bounce,
    UI-gate F6).** **`StopDaemonOutcome` must be defined here, not in
    `cli/wire/board_daemon_control.ts`** — a type defined inside `cli/wire/`
    is not reachable through the `ports/board.ts` → `app/features/daemon/
    index.ts` → `ui/src/lib/api/types.ts` chain every other response type
    in this blueprint uses (§1, `only-wire-imports-adapters`'s carve-out
    covers `cli/wire`'s *adapter* imports, it does not make `cli/wire`
    itself importable from `app/` or `ui/`). Add, alongside `DaemonStatus`:
    ```ts
    export type StopDaemonOutcome =
      | { outcome: 'stopped' }
      | { outcome: 'already_stopped' }
      | { outcome: 'daemon_unresponsive' }
      | { outcome: 'child_unresponsive'; childPid: number };
    ```
    Add to `BoardSource`: `stopDaemon(): Promise<StopDaemonOutcome>`.
    **New `src/cli/wire/board_daemon_control.ts` — new sibling module
    (BE-gate finding F8, same rationale as steps 16/32 — `board.ts` cannot
    absorb this and the other six new implementations without exceeding the
    400-line cap; kept as its own file, separate from the existing
    *read-only* `board_daemon.ts`, on purpose — read vs. write is the same
    split the port itself already draws elsewhere).** Implements
    `stopDaemon()`, returning the `StopDaemonOutcome` now defined in
    `ports/board.ts` (imported, not redeclared).
    **Rewritten per BE-gate finding F1 — the original spec ("send the exact
    same signal `jobbunny serve stop` sends … degrades to `already_stopped`
    on any failure") mis-specified the mechanism and inverted a real failure
    into a false success.** `stopDaemon()` must reuse `runServeStop`'s full
    four-step lifecycle (`src/cli/commands/serve/lifecycle.ts:41-76`), not a
    bare signal:
    1. Read the daemon pidfile (`readDaemonPidfile`). Absent → `{outcome:
       'already_stopped'}`.
    2. `killAndConfirmDead(file.pid, deps)` — SIGTERM, poll to death or
       `SIGKILL_GRACE_MS`, then SIGKILL, poll again (`lifecycle.ts:33-39`,
       reused verbatim, not reimplemented). **If this returns `false` (the
       daemon survived SIGKILL) → a distinct outcome, `{outcome:
       'daemon_unresponsive'}` — never `already_stopped`.** This is the
       exact false-success `§7`'s own guarantee for `startDaemon` already
       forbids; `stopDaemon` must not commit the inverted version of the
       same mistake.
    3. **Re-read the pidfile** (`lifecycle.ts:57-61`'s own comment explains
       why: the daemon child's shutdown handler deliberately does NOT
       release the pidfile itself — `start.ts:232-243` — precisely so this
       re-read still finds an `inFlight` child to kill; skipping this step
       is what orphans a live run holding Chrome). If `after.inFlight` is
       present, `killAndConfirmDead(after.inFlight.pid, deps)` the same way.
       Survived-SIGKILL here → `{outcome: 'child_unresponsive', childPid:
       after.inFlight.pid}` — distinct from the daemon-level failure, since
       a stuck run child is a different operator action (may need a manual
       `kill -9` or a reboot) than a stuck daemon.
    4. Only once both steps succeed: `releaseDaemonPidfile(...)` →
       `{outcome: 'stopped'}`.

    (The `StopDaemonOutcome` shape above is defined once, in `ports/
    board.ts` per the pin at the top of this step — not redeclared here.)

    **Reuse, don't reimplement**: `killAndConfirmDead`/`waitUntilDead`
    (`lifecycle.ts:16-39`) are already colocated, tested functions — import
    them directly (or extract `runServeStop`'s own body into a shared
    function both the CLI command and the board call, if that refactor is
    cheaper than duplicating the 4-step sequence inline; either way, the
    **sequence and its ordering** — daemon before child, always — must not
    be re-derived by hand). This is a non-behavioral extraction if done via
    shared-function reuse; verify `serve.test.ts` stays green unmodified as
    proof. `stopDaemon()` never throws — every branch above is a typed
    outcome, not an exception; the route layer maps `daemon_unresponsive`/
    `child_unresponsive` to a **visible, non-200-success** response (e.g.
    a 200 body the client renders as a warning, not a "stopped" success
    line — exact HTTP status is product-ui's call, but it must not read as
    success).
39. **`daemon/routes.test.ts` — edit.** Cover all four outcomes, including
    both new unresponsive branches (assert `SIGKILL` was attempted before
    either fires, and that a survived-SIGKILL daemon never reports
    `already_stopped`).
    **`src/app/features/daemon/index.ts` — edit, per BE-gate bounce
    (UI-gate F6).** This barrel currently exports exactly one symbol,
    `export { makeDaemonRoutes } from './routes.ts';`, and no types at all
    (confirmed — the UI-gate's own finding). Add a type-export line
    matching every other feature barrel's convention (`config/index.ts`,
    `board/index.ts`):
    ```ts
    export type { StopDaemonOutcome } from '../../../ports/board.ts';
    export { makeDaemonRoutes } from './routes.ts';
    ```
    (`StartDaemonOutcome`/`AutostartOutcome` are added to this same
    export-type line at steps 40/41, once those methods exist — conditional
    on the §0(c) ruling, same as the methods themselves.)
40. **CONDITIONAL on the §0(c) ruling landing on Option 1 — do not build
    until then.** **`src/ports/board.ts` — edit, same pin as step 38.**
    `export type StartDaemonOutcome = { outcome: 'started' | 'already_running'
    | 'spawn_failed' };` defined here, not in `cli/wire/`, for the identical
    reason step 38 gives. Add to `BoardSource`: `startDaemon(): Promise
    <StartDaemonOutcome>`. `POST /api/daemon/start` → this method, in
    the same new `board_daemon_control.ts` module (F8), reusing
    `cli/commands/serve/start.ts`'s `runServeStartParent` sequence
    (`acquireDaemonPidfile` → `deps.spawn(..., {detached:true})` → confirm
    via `pidIsAlive`). **Budget for the real cost corrected in §0(c)/F9**:
    this call can legitimately take up to ~35s (`STEAL_RECHECK_WAIT_MS`) in
    the stale-incumbent-pidfile branch plus ~2s (`CHILD_ALIVE_CHECK_MS`) in
    the common case — the route must not assume a fast round-trip, and
    product-ui's ≤400ms Doherty acknowledgement (ux-notes §10) needs its own
    long-poll or streaming affordance for this one control, not the generic
    save-bar pattern. Translate `runServeStartParent`'s exit-code/stderr
    contract into the typed outcome deliberately (darwin legacy-plist
    refusal, spawn error, dead-on-arrival child) rather than collapsing
    everything non-zero into `spawn_failed` — at minimum distinguish
    "already running" (exit 1, `start.ts:44-51`) from a genuine spawn
    failure so the board doesn't report a live daemon as newly failed to
    start. Wrap in try/catch; any failure to spawn or confirm liveness that
    doesn't map to a more specific outcome → `{outcome:'spawn_failed'}`,
    never an unhandled exception.
41. **CONDITIONAL on the §0(c) ruling — Autostart is part of the same
    bundled R20 Must (`spec.md:598`), not an independent Should. BE-gate
    finding F2: the original spec left this ungated, which is corrected
    here.** **`src/ports/board.ts` — edit, same pin as steps 38/40.**
    `export type AutostartOutcome = { outcome: 'ok' | 'unsupported_platform'
    };` — named **`AutostartOutcome`** to match what product-ui's own
    blueprint already assumes for this control (UI-gate finding F4), defined
    here for the same reachability reason as `StopDaemonOutcome`/
    `StartDaemonOutcome`. Add to `BoardSource`: `setAutostart(enabled:
    boolean): Promise<AutostartOutcome>`. **`src/app/features/daemon/
    index.ts`'s type-export line (from step 39) widens to its final form:**
    ```ts
    export type { StopDaemonOutcome, StartDaemonOutcome, AutostartOutcome } from '../../../ports/board.ts';
    export { makeDaemonRoutes } from './routes.ts';
    ```
    `PUT /api/daemon/autostart` (body `{enabled: boolean}`) →
    `source.setAutostart(enabled)`, implemented in `board_daemon_control.ts`.
    Before implementing, **verify** `runEnable`/`runDisable`
    (`cli/commands/autostart.ts:205,237`, confirmed **not exported** as of
    this blueprint's writing — F12) — extract them to exported top-level
    functions first, as a small non-behavioral refactor covered by the
    existing `autostart.test.ts` staying green unmodified. On
    `process.platform !== 'darwin'` → `{outcome:'unsupported_platform'}`
    without attempting anything (mirrors the CLI command's own existing
    darwin gate — locate and reuse it, do not reimplement the check).
    launchctl-level hiccups are tolerated non-fatally, matching the existing
    CLI's own posture (`autostart.ts:228-231`) — the board must not
    surface these as request failures.
42. **CONDITIONAL, same gate as step 41.** `daemon/routes.test.ts` — edit.
    Cover: autostart toggle both directions on a stubbed darwin platform;
    non-darwin → `unsupported_platform`, no side effect attempted.

Steps 24-27 numbering intentionally skipped above (folded into 20-23's
LinkedIn feature slice) to keep the R17 block internally contiguous; no gap
in actual work.

---

## 4. Schema & Migrations

**No sqlite schema migration.** `LATEST_SCHEMA_VERSION` stays **8**. Every
new capability in this blueprint is either:

- a **new query** against an existing table (`checkpoints.stage`, already a
  column since the v2→v3 migration) — step 29, or
- a **new optional field** inside an existing JSON config-doc's zod schema
  (`schedule.skipNext`) — config docs are schemaless JSON at rest, validated
  only at read/write time; an old `profile.json` with no `skipNext` key
  parses unchanged under the widened schema (`.nullable().default(null)`).
  This is inherently forward- and backward-compatible — no expand/migrate/
  contract sequence is needed because there is no column to add and no row
  to backfill.

**Verification step, not a migration, but treat it with the same rigor per
CLAUDE.md's stability principle**: before landing step 5 (the `ScheduleSchema`
widen), add a fixture test in `schema.test.ts` that parses the **committed
`profiles/rajni/profile.json`** fixture unchanged through the new schema —
proves the widen doesn't reject any real, currently-valid document. This is
the closest analogue to a "rehearse on a copy" step this change needs, since
there is no destructive operation and no data to migrate.

**Contract-comment update required alongside the `readAt` query (BE-gate
finding F13, detailed at step 30a):** `readAt` is a query, not a schema
change, but it invalidates the "every checkpoint read path only looks at
same-day latest" assertion two existing comments make
(`routines/cleanup/cleanup.ts:14-17`, `ports/checkpoint_store.ts:46-62`).
Both must be corrected in the same change per CLAUDE.md's "docs as code"
convention — see step 30a for the exact wording change.

---

## 5. Requirements Coverage

| Req | MoSCoW | Server-side delivery |
|---|---|---|
| R1 | Must | UI-only (nav labels) |
| R2 | Must | Client-side computation over existing config docs + `normalizeToken` — §0(a), §3.13 |
| R3 | Must | UI-only (scope chips) |
| R4 | Must | UI-only, existing config GET/PUT (all 4 docs) |
| R5 | Should | UI-only (dirty-state guard) |
| R6 | Must | Existing config GET for values; §3.10-11 for binding markers |
| R7 | Must | Existing `filter.json` GET/PUT |
| R8 | Must | Existing `profile.json` GET/PUT (`settings.rank.*`) |
| R9 | Must | Existing `profile.json` GET/PUT (`settings.notion.*`) |
| R10 | Should | Existing `profile.json` GET/PUT (`settings.cleanup.*`) |
| R11 | Must | UI-only (read-only display) |
| R12 | Should | Existing `profile.json` GET/PUT (`settings.linkedin.*`); save-time validation via R13 |
| R13 | Must | §3.1-4 |
| R14 | Must | **Corrected per BE-gate finding F7.** UI-only, but NOT `GET /api/daemon`'s `inFlight` alone — that field is read from the daemon's own pidfile and covers only daemon-spawned runs (`ports/board.ts:107`), so it overclaims for a CLI-initiated `jobbunny run`. Primary signal: `GET /api/profiles/:name/runs?limit=1`'s `RunSummary.status === 'running'` (existing endpoint, `ports/run_store.ts:22`) for the profile being saved. `inFlight` is a secondary, daemon-specific enrichment only, never sufficient alone. |
| R15 | Should (conditional) | **Spike passed** — §3.28-36; §0(b) |
| R16 | Must | UI-only, existing `GET /api/daemon` |
| R17 | Must | §3.20-23 (F6, F7, F14 amendments applied) |
| R18 | Must | §3.14-19; §0(d) |
| R19 | Must | Pause/resume: UI-only (existing `enabled` field). Skip-next: §3.5-9 |
| R20 | Must (mechanism deferred) | **Corrected per BE-gate finding F2 — all three parts gated on the §0(c) ruling, not two.** Stop: §3.37-39, *recommended* to ship regardless of the ruling but not pre-decided (see §0(c) re-argument) — ships only if the ruling is not Option 4. Start: §3.40, gated on Option 1. Autostart: §3.41-42, gated the same as Start (bundled Must, `spec.md:598`) — **not independently shippable**, corrected from the original miswording. |
| R21 | Should | UI-only, existing `GET /api/profiles/:name/doctor` |
| R22 | Must | UI-only aggregation over existing doctor + config + secrets GETs |
| R23 | Must | UI-only (named CLI/slash-command handoff copy) |
| R24 | Must | UI-only, existing secrets GET/PUT (unchanged, no behavior change) |
| R25 | Should | UI-only (confirmation dialogs) |
| R26 | Could | UI-only (client-side filter over static section labels) |
| R27 | Could | UI-only if the tail slot is spent; if built, needs a cheap new read of each schema's `.parse({})` defaults — **not designed here**, flagged as deferred-if-cheap in §8 |
| R28 | Won't | — |
| R29 | Won't | — |
| R30 | Won't | — |
| R31 | Won't | — |
| R32 | Won't | — |

---

## 6. Read-Write Path Map

Per screen, per state — the server path delivering it. "Existing" rows are
unchanged; "New" rows cite the step number.

| Screen | State | Server path |
|---|---|---|
| **S1 landing** | default | `GET runs` (last id) → `GET runs/:id` (existing, `.result` = funnel) + `GET runs/:id/soft-errors` (existing endpoint, **new** `capsHit` field, §3.10) + `GET config/profile.json`+`filter.json` (existing, for caps/rules-in-force values) |
| | empty (no run yet) | `GET runs` returns `[]` — client renders "No run recorded yet"; caps/rules rows still render from config GETs |
| | loading | client-side skeleton over the same calls |
| | error | existing per-endpoint error envelopes; client retries per block |
| **S2 Where you'll work** | default | `GET config/filter.json` + `GET config/profile.json`, conflict computed client-side (§0(a), F3/F4-corrected) |
| | conflict present, hard rule | same calls; client-computed, `timezones.severity==='hard'` — drop-notice copy applies |
| | conflict present, soft rule | same calls; `timezones.severity==='soft'` — a **different** notice is needed (de-ranked, not dropped); copy not designed by UX, flagged (§0(a)) |
| | no rule configured | `filter.json.timezones === undefined` — **no conflict notice ever renders** (§0(a)/F3) |
| **S3 Fetching** | default | `GET config/profile.json` (caps + pacing values); binding markers from `GET runs/:id/soft-errors` |
| | save (jitter min>max) | `PUT config/profile.json` → 422 via §3.3's new validation |
| **S4 Roles & companies** | default | `GET config/filter.json`+`profile.json` |
| | preview strip, available | `POST profiles/:name/preview/filter` (§3.31-33) |
| | preview strip, no recent run | same endpoint, `available:false` |
| **S5 Raw config** | default | existing `GET config/:doc` ×4 |
| | save | existing `PUT config/:doc`, same validators as the owning form |
| **S6/S7 Operate — Daemon card** | default | existing `GET /api/daemon` |
| | start/stop | **all gated on §0(c) — see re-argument.** stop: §3.37-39, recommended-but-not-decided to ship regardless of the ruling. start: §3.40, gated on Option 1. |
| | autostart toggle | §3.41-42, **gated on §0(c)** (F2 — bundled with start, not independent) |
| **Scheduled runs card** | default | existing `GET /api/daemon` (`profiles[]`) |
| | skip next | `PUT config/profile.json` (`schedule.skipNext`, §3.5-9) |
| | pause/resume row | `PUT config/profile.json` (`schedule.enabled`, existing) |
| | pause all | client fan-out over N existing `PUT config/profile.json` calls — **not atomic**, see §7 |
| **LinkedIn card** | session, cached | `GET /api/linkedin/session` (§3.22) |
| | session, check now | `POST /api/linkedin/session/check` (§3.22) — gated on **both** daemon `inFlight` **and** any profile's `runs.status==='running'` (F7, §3.21) |
| | breaker | `GET /api/linkedin/breaker` (§3.14-19) |
| **Setup & health card** | default | existing `GET /api/profiles/:name/doctor` |
| **Secrets card** | default | existing `GET /api/secrets`, `PUT /api/secrets/:key` |
| **S8 save model** | success | existing PUT response; "run in flight" line reads `GET /api/profiles/:name/runs?limit=1`'s `status` (corrected per F7 — `GET /api/daemon`'s `inFlight` alone overclaims for a CLI-initiated run) |
| | validation error | existing 422 envelope (extended by §3.3-4 for pacing) |
| **S9 Danger zone** | default | existing `DELETE /api/profiles/:name` |

---

## 7. Failure Semantics

Per the repo's own idiom (fail-soft where breadth matters, fail-loud on total
outage — CLAUDE.md), stated per new path:

| Path | Posture | Detail |
|---|---|---|
| `readBreakerStatus` | **fail-soft** | Missing/corrupt breaker file → `closed`, never a 500 — inherits `readBreaker`'s own contract (`breaker_store.ts:89-108`) verbatim. |
| `readLinkedinSession` (cached read) | **fail-soft, trivially** | Pure in-memory read, cannot fail. |
| `checkLinkedinSessionNow` (probe) | **fail-soft** | Unreachable Chrome, connect timeout, empty `contexts()`, or cookie-read error → `unknown`, **never** `signed-out` (AC15, hard requirement — a false signed-out trains the user to ignore the one signal that matters). **Gate widened per F7**: a run in flight — daemon-spawned (`inFlight`) **or** CLI-initiated (any profile's `runs.status==='running'`) — skips the probe entirely and returns the stale cache; never contends with the one-Chrome invariant either way. **Per F6, the CDP connection is now explicitly closed on every branch past a successful connect** (see §3.20 step 4) — a disconnect failure is itself swallowed and never flips a good result to `unknown`. |
| `previewFilterRule` | **fail-soft on missing data, fail-loud on bad input** | No recent run / expired checkpoint / malformed checkpoint payload → `available:false` + reason, 200 response, never a 500. A malformed **draft** config (the user's own typo) → 422, visible, not swallowed — the user needs to know their edit didn't parse. |
| `validateConfigDoc` pacing hoist | **fail-loud** | 422 at save time, same posture as every existing config validation failure — this is the entire point of R13/G10. |
| `schedule.skipNext` | **fail-soft by construction** | A stale or malformed-but-schema-valid `skipNext` (e.g. a past date) is simply never matched by `isRunOwed` (which only evaluates today's date) — inert, no special handling, no cleanup job needed. |
| `stopDaemon` | **fail-soft on the expected-absence cases, distinctly-reported on genuine failure (rewritten per F1)** | Pidfile absent → `already_stopped`. Daemon confirmed dead (SIGTERM or SIGKILL took) → `stopped`. **A daemon that survives SIGKILL is a distinct, visible outcome (`daemon_unresponsive`) — never silently reported as `already_stopped`** (F1's central finding: the original spec inverted this into a false success, the exact failure mode `§0(c)`'s `startDaemon` guarantee already forbids in the other direction). Same distinct treatment for an in-flight run child that survives SIGKILL (`child_unresponsive`) — reported separately from the daemon-level outcome since it implies a different operator remedy. |
| `startDaemon` (conditional) | **fail-loud on genuine failure, fail-soft on already-running** | Spawn failure or liveness-confirm failure → `spawn_failed`, a distinct, visible outcome (not silently reported as success) so the user isn't told the daemon is up when it isn't. Already running → `already_running`, not an error. |
| `setAutostart` | **fail-soft on OS tooling, fail-loud only on platform mismatch made visible** | `launchctl` hiccups tolerated exactly as the existing CLI already tolerates them (`autostart.ts:228-231`); non-darwin → an explicit, honest `unsupported_platform` outcome, never a silent no-op and never a crash. |
| Pause-all (client fan-out) | **UI-owned, not atomic** | N independent `PUT config/profile.json` calls. product-ui must report per-profile success/failure (not a single boolean) — a partial failure must never be presented as "all paused." Flagged for product-ui, not fixed here: no new server transaction is being proposed for this, since a machine-wide atomic pause was explicitly decided *not* to be new stored state (§0(e)). |

**Idempotency / bounded waits, per new path:**

- `checkLinkedinSessionNow`: bounded twice over (2s reachability +
  `raceWithTimeout`-wrapped connect, ≤3s) — total ≤~5s worst case. Safe to
  re-run (`[Check now]` clicked twice just re-probes). **Corrected per F6**:
  the original claim "no state accumulates beyond overwriting the cache" was
  false as originally specified — §3.20 did not disconnect the CDP
  connection, so each check leaked a live connection. §3.20 step 4 now
  disconnects on every branch past a successful connect, which is what
  actually makes repeated `[Check now]` clicks safe to re-run without
  accumulating open connections; the timer-race bound (not `AbortSignal`,
  a deliberate, named deviation per F6) still leaves a *timed-out* connect
  attempt to settle on its own, per `raceWithTimeout`'s own contract — a
  bounded, accepted residual, not state that grows unbounded.
- `previewFilterRule`: bounded by the checkpoint-lookup loop being capped at
  5 runs (not unbounded scanning); safe to re-run (pure read, no write).
- `stopDaemon`/`startDaemon`: idempotent by construction — `already_stopped`/
  `already_running` are first-class outcomes, not errors, so a double-click
  is harmless. `startDaemon` reuses `acquireDaemonPidfile`'s existing
  exclusive-write race guard, so two concurrent Start requests cannot spawn
  two daemons. `stopDaemon`'s two new outcomes (`daemon_unresponsive`,
  `child_unresponsive`, F1) are **not** silently retried automatically —
  a caller that re-invokes Stop after either will simply re-attempt the same
  kill-and-confirm sequence against whatever the pidfile now shows, which is
  safe (each attempt is independently bounded by `SIGKILL_GRACE_MS`) but not
  guaranteed to resolve a genuinely wedged process; that is an operator
  escalation, not a retry-loop problem this endpoint should paper over.
- `setAutostart`: idempotent (re-enabling an already-enabled autostart, or
  disabling an already-disabled one, is a no-op per the existing CLI
  command's own behavior, reused verbatim).

---

## 8. Write-Surface Expansion — dedicated section, blast radius per entry

Per the requirement that any expansion beyond CLAUDE.md's enumerated board
write surface (`tracking`, config docs, run-intents insert/cancel-own,
secrets write-only, guarded profile create/remove) be named explicitly:

| Addition | Kind | Blast radius | Notes |
|---|---|---|---|
| `schedule.skipNext` | Not an expansion | — | Rides the existing config-doc PUT; listed here only for completeness. |
| `readBreakerStatus`, `readLinkedinSession`, `previewFilterRule`, `readAt` (checkpoint) | New reads | **Low** | Pure reads, additive to `BoardSource`/`CheckpointStore`, following the `runDoctor`/`readDaemonStatus` precedent exactly. No existing write path touched. |
| `checkLinkedinSessionNow` | New external-system read | **Medium** | Not a "write" in the CLAUDE.md sense (mutates nothing in Chrome), but it is a genuinely new *class* of board capability — driving a live CDP connection. Called out for the same review discipline as a write. Never launches Chrome; gated on no run in-flight; every failure mode degrades to `unknown`, never a false negative. |
| `stopDaemon` | New process control | **Medium — corrected per F1, not a bare signal** | Runs `runServeStop`'s full 4-step kill-and-confirm-and-release lifecycle (daemon, re-read pidfile, in-flight child, release) against pids the board already reads from its own pidfile — cannot target an arbitrary process. **Recommended** to ship regardless of the Start ruling, but gated the same as the rest of R20 if the user picks Option 4 ("R20 becomes Won't") — see §0(c) re-argument, F2. Not "unconditional" as originally stated. |
| `startDaemon` (conditional) | New process control | **High — spec's own "highest in this spec" rating, confirmed; cost cells corrected per F9** | The board gains the power to spawn one specific, zero-argument OS process, via `runServeStartParent` (not a thin primitive — darwin legacy-plist gate, up to ~35s stale-pidfile recheck, log fd handling, exit-code translation, all budgeted in §3.40). Does **not** let it spawn a pipeline run (the daemon remains the sole run-spawner). Reuses `acquireDaemonPidfile`'s existing race guard. **Not implemented until the §0(c) ruling lands on Option 1.** |
| `setAutostart` | New OS-integration write | **Low-Medium** | Confined to darwin, writes one LaunchAgent plist + one `launchctl` shell-out, reuses the existing CLI command's own tested logic verbatim, no pipeline/DB touch. **Gated on the same §0(c) ruling as Start — corrected per F2**, since spec §11 R20 (`spec.md:598`) bundles autostart into the same Must whose mechanism is deferred; it is not an independently-shippable item. |

**Regression, non-negotiable, verified against every addition above**: the
board still binds `127.0.0.1` only (`server.ts:54`, untouched), and **no
addition in this blueprint lets the board spawn a pipeline run by any path**
— `startDaemon` spawns the *supervisor*, never a `jobbunny run` invocation
directly; every run is still either daemon-spawned off a real schedule slot
or claimed off a `run_intents` row, unchanged.

---

## 9. Risks & Assumptions

- **`half-open` breaker state folded into `closed` for display** (§3.15) —
  a judgment call, not spec-mandated. The spec/UX only ask for a binary
  closed/open surface; `half-open` (cooldown elapsed, no probe run yet) has
  no natural home in that binary without inventing a third UI state nobody
  asked for. If a later stage wants tri-state, `breakerPhase`'s own return
  value already supports it — this is a display choice, not a data
  limitation.
- **LinkedIn session cookie name/domain not pinned in this blueprint** (§3.20)
  — I did not have a live, logged-in `.chrome-debug` profile to inspect.
  The implementing step must confirm the exact cookie (LinkedIn's primary
  session cookie is conventionally named `li_at`, scoped to
  `.linkedin.com`, but this must be verified against a real session before
  hardcoding, not assumed from general web knowledge).
- **Checkpoint TTL (2 days default) genuinely bounds R15's usefulness** for
  a profile whose last run is older than that. This is not a defect — S4 was
  designed for this outcome — but it means the preview's real-world hit
  rate depends on how often the user actually opens this screen relative to
  their run cadence. Not measurable before ship.
- **Resolved by the BE-gate review (F1, F12), no longer an open assumption**:
  the stop logic (`runServeStop`, `cli/commands/serve/lifecycle.ts:41-76`)
  is fully traced now — §3.38 reuses it precisely, not by assumption.
  `runEnable`/`runDisable` (`cli/commands/autostart.ts:205,237`) are
  **confirmed not exported** (F12) — §3.41 already specifies extracting them
  first as a small, mechanical, non-behavioral refactor covered by the
  existing `autostart.test.ts` staying green; this remains correctly
  hedged, not newly risky.
- **`runServeStartParent`'s real cost (F9) is a genuine, not-yet-measured
  risk for the UI, independent of this blueprint.** The ~35s worst-case
  stale-pidfile recheck (`start.ts:32,58-67`) is architecturally real and
  cannot be shortened without changing `isDaemonPidfileStale`'s own
  wake-from-sleep tolerance (out of this blueprint's scope) — product-ui
  must design a genuine long-wait affordance for Start, not assume the
  generic ≤400ms Doherty pattern covers it.
- **Pause-all's non-atomicity is accepted, not solved.** A machine-wide
  transactional pause was deliberately rejected (§0(e)) as new stored state
  the data model doesn't otherwise need. If this proves painful in practice,
  the fix is a UI-level retry/report affordance, not a new server endpoint.
- **`RunResult`'s shape must be hand-typed in `ui/`** since `ops/
  observability` isn't a dependency-free core module — a drift risk if the
  schema changes without updating the UI-side type. Flagged for product-ui,
  not fixed here (out of this blueprint's write boundary).
- **`core/config/linkedin_pacing/`'s placement is a documented exception, not
  a clean fit (F14)** — it houses an adapter-shaped setting inside `core/`
  because `validators.ts` must reach it at save time and `core-is-pure`
  forbids the reverse import. Mechanically legal, contrary to the stated
  intent in `schema.ts`'s own doc comment. Accepted and recorded rather than
  worked around, per §3.1.
- **The CDP disconnect's non-killing semantics (F6, §3.20 step 4) are stated,
  not independently verified against this repo's own code** — I did not find
  an existing call site in this codebase that closes a `connectOverCDP`
  handle to check the claim "detaches without killing the underlying Chrome
  process" against. This must be confirmed against playwright's own
  documentation or a small spike before the implementing step ships it as
  fact, since if it's wrong, `[Check now]` would kill the shared Chrome
  every time it runs — a materially worse outcome than the connection-leak
  it's meant to fix.

---

## 10. Out of Scope

| Excluded | Reason |
|---|---|
| Rank re-scoring preview | No mockup screen requests it; R15 is filter-only (§0(b)) |
| `startDaemon`/`stopDaemon`/`setAutostart` implementation (all of §3.37-42) | Gated on the §0(c) user ruling — this blueprint specifies the design but does not authorize building any of it yet. **If the ruling is Option 4 ("not worth it"), all of R20 becomes Won't per `spec.md:701-702` — R19 (live-daemon control, config-doc-only) is unaffected and ships regardless.** |
| A transactional, atomic "pause all" | Rejected in favor of UI-level fan-out over existing per-profile writes (§0(e)) — no new stored state |
| R27 reset-to-default's server-side default-exposure endpoint | Tail item, "ship only if cheap" — not designed here; if it survives triage, needs a small new read of each schema's `.parse({})` output, deferred |
| Any change to the 10-stage pipeline's order or semantics | Frozen, untouched by every step above |
| Chrome/LinkedIn login implementation | Parked `setup-overhaul` epic (R30, Won't) |
| Manual breaker reset | R29, Won't — a reset button on a breaker that tripped for cause is an account-ban affordance |
| Telegram digest-shape configuration | R31, Won't — no such config exists |
| Full new-profile creation | R28, Won't |

---

## 11. BE-gate ruling — dispositions (2026-08-18 amendment, ruling `be-gate-r1.md`)

Verdict: **CLEARS WITH CONDITIONS.** Every finding below is dispositioned by
ID. F2's user ruling and F10 (spec/AC6 ratification) are explicitly not
mine — noted, not actioned.

| Finding | Severity | Disposition |
|---|---|---|
| **F1** | Blocker | **Amended.** §3.37-38 rewritten to reuse `runServeStop`'s full 4-step lifecycle (`lifecycle.ts:41-76`); new `daemon_unresponsive`/`child_unresponsive` outcomes replace the false-success degrade to `already_stopped`. §7, §8 updated to match. |
| **F2** | Blocker | **Amended, blueprint half only — user ruling is not mine.** §0(c) gained a 4th option ("R20 → Won't", `spec.md:701-702`); §3.41-42 (autostart) now explicitly gated on the same ruling as Start, not independent; §3.37/§0(c) re-argue Stop's "unconditional" claim as a recommendation inside the options, not a pre-decided fact. §2, §5, §6, §8 updated for consistency. |
| **F3** | Major | **Amended.** §0(a) rewritten: guards on `timezones !== undefined` (no rule → no conflict, ever) and branches on `severity` (`hard` → drop-notice copy stands; `soft` → a different, UX-undesigned notice is needed — flagged, not closed). §2's conflict-set row and §6's S2 states updated to the 3-state shape (no rule / hard conflict / soft conflict). |
| **F4** | Major | **Amended — one mechanism named.** Original §3.13 (amend CLAUDE.md to bless a deep import past `core/jd/index.ts`) withdrawn. Resolution: extract `normalizeToken` into its own sibling module, `core/normalize_token/index.ts` (not nested under `core/jd/`, so it isn't gated behind `core/jd/index.ts`'s zod-importing surface), re-exported from `core/jd/normalize.ts` for existing internal callers. `ui/` imports the new module's `index.ts`. CLAUDE.md gains one line naming the whole module, matching its own "module the SPA imports" wording — no more file-level carve-out. |
| **F5** | Major | **Amended.** §3.32 step (4a) added: an explicit `(jd): jd is StructuredJD => jd.structured !== undefined` narrowing guard before `evaluate()`, dropping (not throwing on) unstructured entries; an entirely-unstructured payload degrades to `checkpoint_expired` rather than a zero-job preview. §3.35 test list extended. |
| **F6** | Major | **Amended.** §3.20 step 4 added: explicit CDP disconnect on every branch past a successful connect, swallowed on its own failure. §7's "no state accumulates" line corrected — it was false as originally written; now explains what actually makes re-runs safe (the disconnect, not mere cache-overwrite). The AbortSignal-vs-timer-race deviation is now named explicitly as deliberate, with the precedent (`connectWithRetry`) cited. §9 records the disconnect's non-killing semantics as unverified-against-this-repo, flagged for implementation-time confirmation. |
| **F7** | Major | **Amended.** §3.21's probe gate widened to check `RunSummary.status==='running'` across every profile (reusing the exact existing guard idiom from `app/features/intents/routes.ts`'s `postHandler`) in addition to daemon `inFlight`. §5's R14 row and §6's S8-success row corrected to use `GET .../runs?limit=1` as the primary signal, `inFlight` as secondary-only. §3.23 test list extended for the CLI-run case. |
| **F8** | Major | **Amended.** Target files named precisely rather than left to the executor: `core/config/linkedin_pacing/index.ts` (new subfolder-module, keeps `core/config/`'s 2-impl-file cap intact); `cli/wire/board_linkedin.ts` (breaker + session, new sibling, mirrors the existing `board_daemon.ts`/`board_doctor.ts` delegation pattern); `cli/wire/board_preview.ts` (R15 preview); `cli/wire/board_daemon_control.ts` (stop/start/autostart, deliberately separate from the existing read-only `board_daemon.ts`). `board.ts` itself now only gains thin one-line delegating methods per capability, not seven full implementations. |
| **F9** | Major | **Amended.** §0(c) Option 1's cost/blast-radius cells rewritten to name the darwin legacy-plist gate, the ~35s `STEAL_RECHECK_WAIT_MS` worst case, the 2s `CHILD_ALIVE_CHECK_MS`, and the log-fd/exit-code translation burden — "lowest cost, 100% reuse" replaced with an honest "cheapest of the four that deliver Start, but budget for a wrapping layer." §3.40 budgets the same cost explicitly, including the Doherty-acknowledgement mismatch product-ui must design around. |
| **F11** | Minor | **Amended.** All internal cross-references swept to the real step numbers (37-42 for daemon control, 14-19 for breaker, 20-23 for session, consistently across §0(c), §2, §5, §6). |
| **F12** | Minor | **Amended where reproducible; two sub-claims disputed — see below.** `scan.ts`'s literal citation widened to 73-79 (the full object literal, not just the 4 field lines) per the ruling's framing. `runEnable`/`runDisable` not-exported status confirmed and left correctly hedged (no change needed, ruling itself notes this was already right). **Disputed:** re-verified `validators.ts` and `settings.ts` directly against current source at amendment time; the profile.json case is at lines 58-69 (sqlite check 65-67) and the three cap-default consts are at lines 53/59/66 — **exactly what the blueprint already said**, not the "51-61/57-59" and "54,60,67" the ruling cites as corrections. I could not reproduce those two specific sub-claims against the file as it currently reads. Not blocking — routed back to the judge per DONE-WHEN rather than silently overridden in either direction; the rest of F12's citations were incorporated. |
| **F13** | Minor | **Amended.** New step 30a schedules the `cleanup.ts:14-17` and `checkpoint_store.ts:46-62` comment corrections in the same change as `readAt` (step 28), per CLAUDE.md's docs-as-code convention. §4 cross-references it. |
| **F14** | Minor | **Amended, both parts.** `CdpBrowser.contexts?.() ?? []` guard added to §3.20 step 3, with the grep evidence (`provider.ts:61,72,73`, no fakes) cited. The `core/config/`-houses-an-adapter-setting tension is named explicitly in §3.1 (a code-comment instruction for the implementing step) and recorded in §9 — accepted as a documented exception, not silently resolved either way. |

**Not mine, not actioned**: F2's user ruling on §0(c) itself (four options now
correctly on the table for the orchestrator to collect); F10 (spec/AC6
ratification against the `maxAgeDays` correction) — user/PM level, unchanged
from the original blueprint's own copy-correction note in §2.

### 11a. BE bounce from the UI-blueprint gate (2026-08-18, ruling `ui-gate-r1.md`, finding F6 only)

The UI gate verified that this blueprint's §2 named response *shapes*
(`{outcome}`, `{phase, reopenAt}`, etc.) but no importable TypeScript
identifiers, and that its own downstream assumption — an existing `daemon`
re-export line in `ui/src/lib/api/types.ts` — does not exist (`src/app/
features/daemon/index.ts` exports only `makeDaemonRoutes`, no types; the
`linkedin/`/`preview/` folders this blueprint's §3 creates don't exist yet
either, which is expected but meant no barrel could be verified against).

**Disposition: amended, §2 only, per the bounce's own scope.** Six type
identifiers pinned, all defined in `src/ports/board.ts` (matching
`DaemonStatus`'s own existing placement, never in `cli/wire/` — a `cli/wire/`
type is not reachable through the `ports` → `app/features/*/index.ts` →
`ui/src/lib/api/types.ts` chain every other response type in this blueprint
already uses) and re-exported by their owning feature's `index.ts` barrel,
matching `board/config/profiles/runs`'s own verified convention exactly
(`export type {...} from '../../../ports/board.ts'; export { makeXRoutes }
from './routes.ts';`):

| Identifier | Home | Re-exported by |
|---|---|---|
| `BreakerStatus` | `ports/board.ts` | new `app/features/linkedin/index.ts` |
| `LinkedinSessionStatus` | `ports/board.ts` | new `app/features/linkedin/index.ts` (same barrel) |
| `FilterPreviewResult` | `ports/board.ts` — **authored by step 31, not pre-existing** (zero hits in the repo today, per UI-gate finding R2-F6) | new `app/features/preview/index.ts` |
| `StopDaemonOutcome` | `ports/board.ts` | `app/features/daemon/index.ts` (existing barrel, gains its first type export) |
| `StartDaemonOutcome` | `ports/board.ts` | `app/features/daemon/index.ts` (same barrel, conditional on §0(c)) |
| `AutostartOutcome` | `ports/board.ts` | `app/features/daemon/index.ts` (same barrel, conditional on §0(c); named to match what product-ui's own blueprint already assumed) |

No contract was redesigned — every shape is byte-identical to what §0(c)/§3
already specified; this bounce only named and homed the types. `ui/src/lib/
api/types.ts`'s own new/extended re-export blocks are product-ui's file to
amend (already flagged in the UI-gate ruling as part of its own step-9
correction), not touched here.

**`AutostartOutcome`'s error channel — implementation-time clarification, not
a contract change.** The two variants above (`ok`, `unsupported_platform`)
are unchanged and remain byte-identical to what §3.41 froze; they are the
success and platform-no-op cases, and **no third variant is added**. A real
darwin legacy-plist conflict is not one of them — it surfaces at the API
boundary as a **thrown** `HttpError(409, 'autostart_conflict', <message>)`
(raised in `cli/wire/board_autostart_control.ts`, propagated unchanged
through `app/features/daemon/routes.ts`), never as a discriminated-union
case. Callers must therefore handle autostart failure on **two** channels:
narrow `outcome` for the two success/no-op values, and a separate
catch/error branch for the 409. A client that only narrows
`AutostartOutcome` type-checks cleanly while being blind to a real,
reachable failure on any machine carrying a legacy plist.

---

## NOTES

**Charter discipline — what I read first-hand vs. delegated.** The contracts
this blueprint's hardest decisions hinge on — `core/config/validators.ts`,
`cli/wire/settings.ts`, `core/rank/rank.ts`, `core/filter/config.ts` +
`rules/timezone.ts` + `engine.ts` + `index.ts`, `core/jd/schema.ts` +
`normalize.ts`, `ports/board.ts`, `ports/checkpoint_store.ts`,
`ports/run_store.ts`, `pipeline/runner/stage.ts`, `ops/observability/run/
result.ts`, `cli/wire/board.ts` (full file), `ops/daemon/daemon.ts` +
`pidfile.ts`, `adapters/lanes/linkedin/breaker_store.ts` + `throttle.ts`,
`adapters/browser/cdp-chrome/provider.ts` + `check.ts`, `core/schedule/
types.ts` + `owed.ts`, `ops/daemon/scan/scan.ts`, `app/features/runs/
soft_errors.ts`, `app/features/daemon/routes.ts`, `app/features/intents/
routes.ts` + `ports/run_intents.ts`, `app/server/server.ts`,
`cli/commands/autostart.ts`/`serve/*.ts` (headers + signatures),
`adapters/db/sqlite/store/migrations.ts` (schema) — **all read directly**,
not summarized from a dispatch. Every file:line citation above traces to one
of these reads.

**Amendment-pass reads (2026-08-18, all first-hand, none delegated):**
`cli/commands/serve/lifecycle.ts` (full file — F1), `cli/commands/serve/
start.ts` (full file — F9), `adapters/browser/cdp-chrome/async/
race_with_timeout.ts` (full file — F6), `core/config/validators.ts` (full
file, re-verified — F12), `cli/wire/settings.ts` (constants re-verified,
line grep — F12), `routines/cleanup/cleanup.ts` (lines 1-60 — F13),
`ports/checkpoint_store.ts` (lines 40-64 — F13), `core/schedule/owed.ts` and
`ops/daemon/scan/scan.ts` (grepped for current guard/literal line numbers —
F12), `package.json` (filesize gate location) and `wc -l` against
`cli/wire/board.ts` + `core/config/*.ts` (F8, confirmed 388/400 lines and
the 2-impl-file `core/config/` count directly, not asserted).

**Delegated (breadth, output-capped, per charter):** two `executor-fast`
dispatches — (1) doctor-check enumeration + `cdp-reachable`'s bounded-wait
idiom, confirming it uses no `AbortSignal` internally (the timeout lives one
layer down, in `defaultCdpReachable`, which I verified myself); (2) full
`app/features/**/routes.ts` inventory, the config-route 422 shape, the
`ConfigDocKey`/`RouteDef`/`BoardRequest`/`HttpError` type shapes, and the
two-pair-rule file-layout convention (routes.ts + routes.test.ts + index.ts,
no `service.ts`). Both returned capped, cited findings; neither result is
load-bearing for a design decision I didn't independently verify — they
confirmed conventions I then applied, and I cross-checked the route-
composition claim myself by reading `app/server/server.ts` directly (§1).

**Deviations from the dispatch:** none in the original pass. **This amendment
pass (2026-08-18) deviates from nothing either** — every change traces to a
BE-gate finding (§11), none is a self-initiated redesign. Every open item
(a)-(e) still carries a verdict with file:line evidence; (c)/§0(c) is
explicitly marked USER-GATE, now covering start+stop+autostart together
(F2), and nothing else in this blueprint depends on which way it falls
(re-verified post-amendment: R19, R6, R2, R15, R17, R18 are all still
designed independently of R20's mechanism).

**Judgment calls made** (also listed inline at point of use): half-open
breaker state displayed as closed (§9); LinkedIn cookie name to be confirmed
at implementation time, not guessed here (§9); the conflict computation for
R2 stays client-side (unchanged verdict) but now imports from a **new,
purpose-built** `core/normalize_token/` module rather than deep-importing
`core/jd/normalize.ts` (F4) — a genuine, board-reviewed mechanism choice, not
a fallback; a server-endpoint alternative remains available if a later
reviewer prefers it, and nothing else in this blueprint depends on which way
that goes; the CDP disconnect's non-killing semantics (F6) stated as a
to-verify assumption, not a guess treated as fact (§9); `core/config/
linkedin_pacing/`'s placement accepted as a documented boundary exception
rather than worked around (F14, §9); Stop's "ship regardless of the ruling"
posture downgraded from a stated fact to a recommendation inside the §0(c)
options, since F2 established that the spec's own words bundle it with the
rest of R20 under the "Won't" branch.

**One thing this blueprint deliberately did NOT do**: invent a new
requirement, field, or endpoint not traced to a spec requirement or a
mockup state. Every "new" row in §2 cites the requirement it serves; every
UI-only row is UI-only because the existing endpoint already carries the
datum — verified, not assumed, for each one.
