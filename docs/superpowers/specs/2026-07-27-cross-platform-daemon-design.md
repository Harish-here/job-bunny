# Cross-platform daemon design

Status: design spec, decisions final. Target branch: `main-v2`. Do not redesign — implement as specified; disagreements go in an implementer's own NOTES, never into the code.

## 1. Problem statement

Job Bunny's scheduling is OS-level: `jobbunny schedule install` (`src/cli/commands/schedule.ts`) reads every profile's `schedule.times[]` and writes one `launchd` plist per distinct time slot via `src/adapters/scheduler/launchd/` (`plist.ts` + `launchd.ts`), then loads each with `launchctl bootstrap gui/<uid>`. A `gui/<uid>` LaunchAgent only runs while that UID has an active GUI session, and `launchd` does not replay a calendar fire that elapsed while the agent was unloaded (e.g. across a reboot before login).

**2026-07-27 incident** (the concrete motivating case):

| Time (local) | Event |
|---|---|
| 13:24 | Mac reboots. No GUI session exists yet — `gui/<uid>` LaunchAgents are not loaded. |
| 14:00 | The `harish` profile's 14:00 slot (`profile.json`'s `schedule.times`) elapses. No agent is loaded to fire it. |
| 14:04 | User logs into the GUI. `gui/<uid>` LaunchAgents load. `launchd` does **not** retroactively fire the missed 14:00 calendar interval — it only arms the *next* one (16:30). |

Net effect: the 14:00 run never happens, and nothing tells the user it was skipped — the run simply doesn't exist. This is a structural property of `launchd`'s `gui/<uid>` domain, not a misconfiguration; it recurs on every reboot-before-login.

Additionally, `launchd` is macOS-only, blocking any future use of Job Bunny on Windows or Linux.

**Goal**: make Job Bunny run on macOS, Windows, and Linux, and replace OS-level scheduling with an in-app daemon that reasons about "is a run owed right now" against wall-clock time, so a reboot-before-login produces a *late* run instead of a *silently skipped* one.

## 2. Goals and non-goals

**Goals**

- `npm install` + `node src/cli/main.ts <command>` works unmodified on macOS, Windows, and Linux.
- Scheduling moves from `launchd` plists to an in-process daemon (`jobbunny serve start|stop|status`) that ticks a wall clock and spawns runs when owed.
- Chrome discovery becomes cross-platform and pid-file-based (no `lsof`, no `ps`).
- Zero new runtime dependencies.

**Non-goals** (explicitly out of scope for this spec):

- **OS autostart.** No LaunchAgent/Windows Service/systemd unit that starts the daemon automatically at boot or login. A reboot leaves the daemon down until the user manually runs `serve start` again — accepted (see §11). A seam is reserved for a future `jobbunny autostart enable` (see below), but no such command is implemented here.
- **Multi-user.** Single OS user, single daemon, single pidfile. No concept of multiple concurrent users of one Job Bunny install.
- **Hosting.** No server deployment, no remote access to the daemon, no network-exposed control surface.
- **Distribution/packaging.** No installer, no signed binary, no `npm publish`, no `.pkg`/`.msi`/`.deb`. Still run from a git checkout via `node`.
- **LLM API fallback.** No Anthropic API key path and no degraded no-LLM mode. The `claude` CLI on `PATH` remains the only structure-stage provider (§9 of the goals list, and D13).
- Per-user LinkedIn session management (out of scope, unchanged from today's single shared `.chrome-debug/` profile).
- Going public / productizing.

**The autostart seam.** `jobbunny autostart enable` (not built here) would, per OS, register "run `jobbunny serve start` at login" with the OS's own native mechanism (a LaunchAgent on macOS, a Scheduled Task on Windows, a systemd `--user` unit on Linux) — and nothing else. It carries zero schedule knowledge; the daemon's tick loop (§4, §6) remains the only place `schedule.times`/`weekdays`/`graceMinutes` are interpreted. This keeps the OS layer a dumb "start this process" trigger, never a second scheduler.

## 3. Decision register

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Scope | Full cross-platform port, single-user. Success = `npm install` + run works on macOS, Windows, Linux. | Multi-user/hosting/packaging/distribution add complexity with no current user. |
| D2 | Trigger model | In-app daemon (`serve start/stop/status`) replaces `launchd`. No OS autostart in this spec; a reboot leaves the daemon down until manually restarted. | Removes the `gui/<uid>`-load dependency that caused the 2026-07-27 miss; autostart is a separable, per-OS concern deferred to a future `autostart` command. |
| D3 | Supervisor model | Daemon does not run the pipeline in-process. It spawns `jobbunny run --profile <name> --headless` as a **child process** via `node:child_process` and awaits exit. | Preserves the fresh-process-per-run invariant; gives crash isolation; makes the run-cap watchdog a simple child kill; boundary-clean (`ops/` may not import `adapters/**` per `only-wire-imports-adapters`, nor `cli` per `nothing-imports-cli` — spawning a subprocess is not an import). |
| D4 | No timer-to-next-fire | Daemon ticks every 30s and asks a pure function whether any run is owed, comparing against the local wall clock. Tick interval is a constant, not user config. | `setTimeout` uses a monotonic clock that does not advance across system suspend, so a long-delay timer fires late after sleep. A 30s tick makes normal fires, downtime catch-up, and post-sleep recovery the same code path. |
| D5 | Zero new runtime deps | Daemon built from Node stdlib only: `spawn(detached:true, stdio:'ignore')` + `unref()`; `writeFileSync(...,{flag:'wx'})`; `process.kill(pid,0)`; `process.kill(pid,'SIGTERM')`; `setInterval` (the 30s tick loop, §6.6); `setTimeout` (the daemon-side child deadline backstop, §6.5). | Repo's 3-runtime-dep cap (`@notionhq/client`, `playwright`, `zod`, plus de-facto `dotenv`) is a hard budget. `pm2`, `node-windows`/`node-mac`/`node-linux`, `daemonize2`, `croner`, `cron`, `node-cron`, `node-schedule` are all rejected: process supervision here is one child at a time with `spawn`+`unref`, which stdlib already covers, and the schedule shape is a flat list of `HH:MM` times, not cron expressions. `croner` is the one to adopt **if and only if** the schedule config format ever changes to cron expressions — not before. |
| D6 | Daemon scope | Cross-profile. `serve start` takes no `--profile`, matching today's `schedule install`. Reads every profile with `schedule.enabled === true`. Profiles sharing a slot run **sequentially**. One daemon, one pidfile. | Matches today's `;`-joined plist commands. Two runs cannot share Chrome on CDP port 9222 (one `.chrome-debug/` user-data-dir, one port) — sequential execution is required, not a preference. |
| D7 | Failed runs count as served | A slot with a run folder is served regardless of that run's outcome. | The runner already retries internally; treating a failed run as "still owed" would relaunch a broken pipeline every 30s. |
| D8 | Grace window | A slot stays owed for 90 minutes after its time, then is skipped permanently. Configurable per profile as `schedule.graceMinutes` (default 90). | Long enough to absorb a late login or a wake-from-sleep; short enough that a 09:00 slot can never fire in the evening. With the DEFAULT configuration (times 150 minutes apart — 09:00, 11:30, 14:00, 16:30, 19:00 — and the default 90-minute grace), at most one slot is ever owed per profile at a time. This is not validated: `graceMinutes` has no enforced upper bound, so a user who sets it larger than their smallest inter-slot gap can have more than one slot owed for the same profile simultaneously — `isRunOwed`'s contract already allows for this (§5), and the daemon's sequential-execution rule (§6.4) handles it correctly. |
| D9 | Slot-to-run-folder matching | Run folders are named by **actual** start time (`HH-MM` local), not by slot. A slot is SERVED if any run folder for that profile on that local date has a start time within `[slot, slot + graceMinutes]`. A manual run inside that window also marks the slot served (intended). | Run folders (`ops/observability/run_folder.ts`'s `formatRunTime`) have never recorded which slot triggered them — inferring "served" from folder existence in the window avoids adding new state while staying correct for both daemon-triggered and manual runs. |
| D10 | `serve stop` semantics | Kills an in-flight child run. The in-flight child pid is recorded in the pidfile so it stays killable even if the daemon process itself has died. | Windows caveat: Node emulates `SIGTERM` on Windows as an unconditional terminate, so the daemon cannot let the child clean up gracefully there. Accepted — the daemon holds no unflushed state (the run-folder ledger lives on disk) and `--resume` already handles an incomplete checkpoint. |
| D11 | Chrome discovery | Three tiers: (1) explicit override (`JOBBUNNY_CHROME_PATH` env / `settings['cdp-chrome'].candidates`), (2) per-OS candidate table built from environment variables, (3) the existing "checked every path" error. Candidate list comes from a pure `chromeCandidates(platform, env)` function. Placement: new subfolder `src/adapters/browser/cdp-chrome/discovery/`. | `cdp-chrome/` is already at 3 implementation files (`check.ts`, `launcher.ts`, `provider.ts`) — the repo's two-implementation-file cap forces a new subfolder rather than a 4th file at the top level. A pure candidate function lets Windows/Linux discovery be unit-tested from macOS by injecting a fake platform+env. |
| D12 | Eliminate `lsof`/`ps` | Replace pid discovery/aging with a Chrome pid file (`.chrome-debug/.jobbunny-chrome.json`: `{ pid, port, startedAt }`), written at spawn time. Liveness via `process.kill(pid,0)`; age via `Date.now() - startedAt`. `resolveListenerPid` and `getProcessAgeMs` are deleted entirely. Recycle only pid-file-owned Chromes at the existing 24h threshold; a reachable Chrome with no pid file is never touched. Pid file self-heals (deleted when its pid is dead). `doctor` warns when CDP is reachable but no pid file exists. | `lsof`/`ps` don't exist (or aren't reliably on `PATH`) on Windows. A pid file recorded at spawn time is both cross-platform and more accurate (`startedAt` is exact vs. parsing `ps -o etime=`). |
| D13 | LLM provider unchanged | Structure stage keeps shelling out to the `claude` CLI. Documented prerequisite (Claude Code itself is cross-platform). Add a `doctor` check for `claude` on `PATH`. No Anthropic API fallback, no degraded no-LLM mode. | Out of scope for this port — the CLI dependency is not an OS blocker, just a prerequisite to document and check. |
| D14 | Deletions | Delete `src/ports/scheduler.ts`, the entire `src/adapters/scheduler/launchd/` family, the `schedule install`/`schedule remove` CLI subcommands, and `runLaunchctl` in `wire.ts`. | The `Scheduler` interface's `install`/`remove`/`list` semantics describe registering jobs with an external OS registry — a concept a live daemon doesn't have. No successor port replaces it; the daemon is not a `Scheduler` implementation. |
| D15 | Migration | On darwin only, `serve start` globs `~/Library/LaunchAgents/com.jobbunny.*.plist`. If any exist, it refuses to start and prints a ready-to-paste cleanup block (`launchctl bootout gui/<uid>/<label>` + `rm` per plist found). No `launchd` code is retained to do this — a directory glob plus printed strings. | Prevents a stale `launchd` job firing a `jobbunny run` concurrently with the new daemon's own spawn, without reintroducing any `launchd` adapter code. |
| D16 | Logs | Daemon logs go to `~/.jobbunny/logs/` (built via `node:path` `join` + `node:os` `homedir`), replacing `~/Library/Logs/JobBunny/`. | `~/Library/Logs/` is macOS-only; `~/.jobbunny/` is a plain home-directory path that exists identically on all three OSes. |
| D17 | Testing + CI | New `.github/workflows/ci.yml`, matrix over `macos-latest`/`ubuntu-latest`/`windows-latest`, running `npm run check`. Hard requirement: unit tests never touch real Chrome, real Notion, or the network. Any existing test violating this must be made hermetic as part of the port. | `npm run check` is already the one gate (`typecheck && lint && boundaries && test`); running it on all three runners is the actual cross-platform proof. Non-hermetic tests would fail non-deterministically on CI runners that have none of Chrome/Notion/network available in the same shape as a dev machine. |
| D18 | Config schema extension | Extend `ScheduleSchema` with `enabled` (default `true`), `weekdays` (default `[1,2,3,4,5]`), `graceMinutes` (default `90`) — all optional-with-defaults. | The validated config path defines schedule as `{ times }` only, so `schedule.enabled` in `profiles/harish/profile.json:5` is silently stripped by zod today and honored only by the `RawScheduleSchema` that D14 deletes. Optional-with-defaults keeps every existing `profile.json` valid with no edit. |

## 4. Architecture

### 4.1 Layers touched

| Layer | Change |
|---|---|
| `src/core/schedule/` | **New.** Pure scheduling core: types + the owed-slot decision function. Zero I/O. |
| `src/ops/daemon/` | **New.** Daemon tick loop, supervision, pidfile handling. Injected fs/spawn deps, mirrors `ops/scheduling/run_lock.ts`'s shape. |
| `src/adapters/browser/cdp-chrome/discovery/` | **New** subfolder. Pure per-OS Chrome candidate list. |
| `src/adapters/browser/cdp-chrome/launcher.ts` | **Modified.** Adds pid-file read/write/self-heal; removes `resolveListenerPid`, `getProcessAgeMs`, `parseEtimeToMs` (the last has no remaining caller once `getProcessAgeMs` is gone). |
| `src/adapters/browser/cdp-chrome/provider.ts` | **Modified.** `decideChromeAction`'s inputs (`reachable`, `ageMs`, `maxAgeMs`) are now sourced from the Chrome pid file rather than `lsof`/`ps`; the function's pure shape (`{ reachable, ageMs, maxAgeMs } → 'launch' \| 'recycle' \| 'reuse'`) is unchanged — ownership is not a parameter to it. A reachable Chrome with no pid file is short-circuited to `reuse` by an outer branch in `provider.ts` before `decideChromeAction` is consulted at all (see §7.4). `resolveListenerPid`/`getProcessAgeMs` deps replaced by pid-file deps. |
| `src/ops/doctor/aggregate.ts` (or a new adapter-contributed check, wired via `cli/wire.ts`'s registry) | **Modified/added.** Two new checks: `claude`-on-`PATH` (D13), Chrome-reachable-but-no-pidfile warning (D12). |
| `src/cli/main.ts` | **Modified.** `USAGE`, `CommandName`, `COMMAND_NAMES`, `buildOptions`, `defaultCommands` — `schedule install|remove` replaced by `serve start|stop|status`. |
| `src/cli/commands/schedule.ts` | **Deleted.** |
| `src/cli/commands/serve.ts` | **New.** `serve` command dispatch (`start`/`stop`/`status`). |
| `src/cli/wire.ts` | **Modified.** `runLaunchctl`, `wireScheduler`, the `ports/scheduler.ts` and `adapters/scheduler/launchd` imports are removed; a `wireDaemon()`-equivalent composition point is added, wiring the daemon's injected fs/spawn/env deps and `RunLockDeps`-style pid liveness probe. |
| `src/ports/scheduler.ts` | **Deleted.** |
| `src/adapters/scheduler/launchd/` | **Deleted** (all 5 files, ~1012 lines total — `index.ts`, `launchd.ts`, `launchd.test.ts`, `plist.ts`, `plist.test.ts`). |
| `src/core/config/schema.ts` | **Modified.** `ScheduleSchema` extended with `enabled` (default `true`), `weekdays` (default `[1,2,3,4,5]`), `graceMinutes` (default `90`) so `PipelineConfig.schedule` matches `core/schedule/types.ts`'s `ProfileSchedule` shape. Additive only — existing `profile.json` files (e.g. `profiles/harish/profile.json`'s `schedule: { enabled, times }`) already carry `enabled`; it was previously read only by `cli/commands/schedule.ts`'s looser, now-deleted `RawScheduleSchema`. |
| `.github/workflows/ci.yml` | **New.** 3-OS matrix running `npm run check`. |

### 4.2 New module contents (two-pair rule compliant)

```
src/core/schedule/
  types.ts       — Weekday, ProfileSchedule, RunRecord, OwedRun
  types.test.ts
  owed.ts        — isRunOwed, nextFireAt
  owed.test.ts
  index.ts       — public surface (re-exports types.ts + owed.ts)

src/ops/daemon/
  daemon.ts      — tick loop, spawn supervision, sequential multi-profile execution
  daemon.test.ts
  pidfile.ts     — daemon pidfile read/write/stale-detection (copies run_lock.ts's shape)
  pidfile.test.ts
  index.ts       — public surface

src/adapters/browser/cdp-chrome/discovery/
  candidates.ts  — chromeCandidates(platform, env)
  candidates.test.ts
  index.ts       — public surface
```

Both `src/core/schedule/` and `src/ops/daemon/` land at exactly 2 implementation files each (excluding `index.ts` and test files) — at, not over, the two-pair cap. `discovery/` lands at 1.

### 4.3 Data flow: one tick, timer to child exit

1. The daemon's setInterval (30_000 ms, per D4) fires.
2. Daemon reads every `profiles/<name>/profile.json` under `profiles/`, parses `schedule` via `PipelineConfigSchema` (extended per §4.1), and builds `ProfileSchedule[]` — skipping (not aborting on) an unreadable/invalid profile, same posture as today's `collectScheduledJobs` in the now-deleted `schedule.ts`.
3. Daemon builds `RunRecord[]` by scanning `profiles/<name>/data/runs/<today's date>/` for every profile (via the existing `ops/observability/run_folder.ts` naming convention — one `RunRecord` per `HH-MM` (or `HH-MM-N` collision-suffixed) directory found).
4. Daemon calls the pure `isRunOwed(now, schedules, history)` (`src/core/schedule/owed.ts`) — zero I/O, testable directly.
5. For each `OwedRun` returned (in ascending `slot` order, matching profile insertion order within a shared slot — mirrors today's sorted-profile-name, file-order convention from `collectScheduledJobs`), the daemon:
   a. Writes the child's pid into the daemon pidfile's `inFlight` field (`src/ops/daemon/pidfile.ts`) before spawning.
   b. Spawns `node src/cli/main.ts run --profile <name> --headless` via `node:child_process.spawn` (not detached — the daemon supervises and awaits this child; only Chrome itself, launched inside that child's own `wire()` call, is `detached`+`unref`ed, unchanged from today).
   c. Awaits the child's exit (any exit code — D7: failure still counts the slot as served).
   d. Clears `inFlight` from the pidfile.
   e. Sequentially proceeds to the next `OwedRun` in the batch — never spawns two children concurrently (D6).
6. Tick returns; the interval fires again in 30s. If a tick is still processing a long-running child when the next interval would fire, the daemon does not start a second overlapping tick — the `setInterval` callback runs the whole owed-runs batch to completion before it is eligible to run again in practice, since one JS callback frame does not overlap the next scheduling of the same interval id (Node's `setInterval` re-arms only after the callback returns; an `async` callback that is still pending simply means the *next* invocation is queued once the event loop is free — the daemon must therefore guard re-entrancy explicitly with an in-memory "tick in progress" boolean, since `setInterval`'s callback CAN still be invoked again by the timer while the previous async callback hasn't resolved (Node does not skip a fired interval just because your handler returned a still-pending promise) — see §6 for the reentrancy guard shape).

### 4.4 Config schema extension

Today `src/core/config/schema.ts:10-12` defines:

```ts
export const ScheduleSchema = z.object({
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')),
});
```

and `schedule: ScheduleSchema.optional()` at line 19.

Consequence to state explicitly: `schedule.enabled` present in `profiles/harish/profile.json:5` is **silently stripped by zod today**, because the schema declares no such key and zod strips unknown keys by default. It is honored only by the looser `RawScheduleSchema` in `src/cli/commands/schedule.ts:71-76`, which D14 deletes. Without this change the daemon would have no validated way to know which profiles are enabled.

The replacement schema, reproduced verbatim:

```ts
export const ScheduleSchema = z.object({
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')),
  enabled: z.boolean().default(true),
  weekdays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  graceMinutes: z.number().int().positive().default(90),
});
```

Consequences, stated as rules:

1. All three new fields are optional-with-defaults, so `profiles/harish/profile.json` and `profiles/rajni/profile.json` remain valid with no edit required. Do not edit either file as part of this port.
2. A profile with no `schedule` block at all is simply never scheduled — `schedule` stays `.optional()`.
3. Per CLAUDE.md's "Seeding never clobbers" hard rule, `jobbunny profile build` must fill these fields only when absent and must never overwrite a user-set value.

## 5. The pure scheduling core

`src/core/schedule/types.ts` — reproduced verbatim:

```ts
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ProfileSchedule {
  profile: string;
  enabled: boolean;
  times: string[];       // "HH:MM", local wall clock
  weekdays: Weekday[];   // default [1, 2, 3, 4, 5]
  graceMinutes: number;  // default 90
}

export interface RunRecord {
  profile: string;
  date: string;      // "YYYY-MM-DD" local
  startedAt: string; // "HH:MM" local, parsed from the run folder name "HH-MM"
}

export interface OwedRun {
  profile: string;
  date: string;  // "YYYY-MM-DD" local
  slot: string;  // "HH:MM" local
}
```

**Run-folder parsing rule, stated once**: when parsing a run-folder name into `RunRecord.startedAt`, any `-N` collision suffix (§4.3's `HH-MM-N` case) is stripped, and `startedAt` is the plain `HH:MM`. Two folders in the same minute (e.g. `14-04` and `14-04-2`) therefore yield two `RunRecord`s with an identical `startedAt`, which is harmless — served-detection (§5.1 rule 6) only asks whether ANY record falls in the window, not how many.

`src/core/schedule/owed.ts` — reproduced verbatim:

```ts
export function isRunOwed(
  now: Date,
  schedules: readonly ProfileSchedule[],
  history: readonly RunRecord[],
): OwedRun[];

export function nextFireAt(
  now: Date,
  schedules: readonly ProfileSchedule[],
): { at: Date; runs: OwedRun[] } | null;
```

Both functions take `now` as a parameter — no `Date.now()` inside `core/schedule/`, per CLAUDE.md's core-purity convention (scorers/pure functions never read the wall clock internally).

`isRunOwed`'s contract: it MAY return multiple `OwedRun` entries for the same profile in one call. This happens when a profile's `graceMinutes` exceeds its own smallest inter-slot gap (D8) — two of that profile's slots can be simultaneously owed. Callers (the daemon's tick loop, §6.4) must not assume at most one `OwedRun` per profile.

`nextFireAt` is a pure informational helper (e.g. for `serve status`'s "next scheduled run" line) — it does **not** drive the daemon's timing (D4: no timer-to-next-fire). It answers "if nothing else changes, when is the next owed run and which profiles does it include", scanning forward from `now` across `schedules` without consulting `history` (its `runs` are always slot-owed, never actual-history-adjusted — that adjustment only happens through `isRunOwed`, called on the next real tick). `nextFireAt` returns only STRICTLY FUTURE slots — it never consults `history`, so it cannot know whether an already-passed, still-in-grace slot was served. `serve status` therefore reports currently-owed runs separately, by calling `isRunOwed` directly; `nextFireAt` is used purely for the "next scheduled run" line.

### 5.1 `isRunOwed` — the owed-slot rule, spelled out

A slot `(profile, date, time)` is **owed** at `now` iff **all** of:

1. `schedule.enabled === true` for that profile.
2. `now`'s local weekday (`0` Sunday .. `6` Saturday) is in `schedule.weekdays`.
3. `time` is in `schedule.times`.
4. `now >= parseLocal(date, time)` — the slot's moment has arrived.
5. `now <= parseLocal(date, time) + schedule.graceMinutes minutes` — the slot is still inside its grace window.
6. **No** `RunRecord` exists for `profile` on `date` whose `startedAt` (parsed as `HH:MM`, itself converted to a moment on `date`) falls in `[time, time + graceMinutes minutes]` (inclusive both ends) — i.e., the slot has not already been SERVED (D7, D9: any run folder in the window counts, regardless of that run's pass/fail outcome, and regardless of whether it was daemon-spawned or manual).

`date` here is always `now`'s local date — `isRunOwed` only ever evaluates slots for the current calendar day; a slot whose grace window straddles midnight (e.g. `23:50` + 90min grace inspected at `00:05` the next day) is out of scope for this design (see §11 — 30s tick granularity risk list already covers same-class edge cases; a midnight-straddling grace window is accepted as unslept-on because the default 90min grace against typical daytime `schedule.times` in `profiles/harish/profile.json` (`09:00`–`19:00`) never approaches midnight).

### 5.2 Worked example — the 2026-07-27 incident, replayed against the new design

Profile `harish`, `schedule.times = ["09:00", "11:30", "14:00", "16:30", "19:00"]`, `graceMinutes = 90` (default), `weekdays = [1,2,3,4,5]` (default), reboot at 13:24, `serve start` run manually by the user at 14:04 (mirroring GUI login in the old design, now the moment the user restarts the daemon):

| Tick (local) | `now` | Evaluation of the `14:00` slot | Result |
|---|---|---|---|
| — | 13:24–14:04 | Daemon is down (D2: no autostart) — no ticks occur. | (no evaluation) |
| First tick after `serve start` | 14:04:00 | `now >= 14:00` (yes) and `now <= 14:00 + 90min = 15:30` (yes) and no `RunRecord` yet for `harish`/today with `startedAt` in `[14:00, 15:30]` — **owed**. | `OwedRun{ profile: "harish", date: "2026-07-27", slot: "14:00" }` returned. |
| Same tick, after spawn | 14:04:xx | Child spawns `jobbunny run --profile harish --headless`; run folder `profiles/harish/data/runs/2026-07-27/14-04/` is created (`formatRunTime` — actual start time, not slot, per D9). | Run proceeds; unlike the incident, it now happens. |
| Next tick | 14:04:30 | The reentrancy guard (§6.6) short-circuits: the previous tick's `await` on the still-running `harish` child has not resolved, so `ticking` is still `true` and this tick returns immediately — no `isRunOwed` evaluation happens at all. | Nothing evaluated by this tick. The served-slot check (Rule 6, §5.1 — `RunRecord{ startedAt: "14:04" } ∈ [14:00, 15:30]`) is what will prevent a duplicate spawn on the FIRST tick that runs after the child exits, not this tick. |
| A later tick, e.g. 16:00 | 16:00:00 | `16:30` slot: `now < 16:30` — not yet owed. `14:00` slot: already served. | No spawn. |

Contrast with the old `launchd` behavior: the `14:00` calendar interval elapsed while the agent was unloaded and was never replayed — the run simply never happened, with no record anywhere that it was skipped. Under this design, the same reboot-before-restart window instead produces exactly one late run at `14:04`, recorded identically to any other run.

If the user had **not** restarted the daemon until `15:45` (more than 90 minutes after `14:00`), the `14:00` slot would no longer be owed (`now > 15:30`) and would be skipped permanently for that date — the `16:30` slot would still be evaluated normally on its own schedule.

## 6. Daemon lifecycle

### 6.1 Commands

| Command | Behavior |
|---|---|
| `jobbunny serve start` | On darwin, first checks for stale `launchd` plists (D15/§8) — refuses if any are found. Otherwise: acquires the daemon pidfile (exclusive `wx` create, same mechanism as `ops/scheduling/run_lock.ts`'s `acquireRunLock`). Refuses (prints who holds it) if another daemon is already running (a live pid in the pidfile). Detaches (`spawn(process.execPath, [mainPath, 'serve', 'start', '--daemon-child'], { detached: true, stdio: 'ignore' })` + `unref()`) — the actual tick loop runs in that detached child, not in the foreground `serve start` process, which exits immediately after confirming the detached process is up. Writes the daemon's own pid (the detached process's pid) into the pidfile. |
| `jobbunny serve stop` | Reads the pidfile. If a `inFlight` child pid is recorded and alive, sends it `SIGTERM` (D10) — best-effort, no graceful wait beyond what the child's own shutdown does; the daemon does not block `stop` on the child's exit. Sends `SIGTERM` to the daemon pid itself. Removes the pidfile once both pids are confirmed dead (poll with `process.kill(pid,0)`, same bounded-poll shape as `launcher.ts`'s `killChrome`). |
| `jobbunny serve status` | Reads the pidfile. Reports: daemon running/not-running (pid liveness), `inFlight` child (if any) with its profile and elapsed time, and — via `nextFireAt` — the next scheduled slot(s) across all enabled profiles. Never mutates the pidfile. |

`serve` takes **no** `--profile` (D6) — it is registered in `src/cli/main.ts` as cross-profile, exactly like today's `schedule install` (see `main.ts`'s existing `schedule install` comment: "the one command that takes no `--profile`: it is cross-profile by design" — `serve` inherits that same posture and comment).

### 6.2 Pidfile

**Location**: repo-root `.jobbunny-daemon.pid` (sibling to the existing `.jobbunny-run.lock` from `ops/scheduling/run_lock.ts` — same directory convention, a different file so the daemon's own supervision state never collides with a single run's cross-process exclusive lock).

**Contents** (JSON):

```ts
interface DaemonPidfile {
  pid: number;           // the detached daemon process's own pid
  startedAt: string;     // ISO 8601
  inFlight?: {
    pid: number;         // the currently-running child jobbunny run process
    profile: string;
    startedAt: string;   // ISO 8601
  };
}
```

**Mechanism**: identical shape to `run_lock.ts`'s `RunLockDeps`/`acquireRunLock`/`releaseRunLock` — an injectable `PidfileDeps` (`{ path, pid, now, pidIsAlive, readFile, writeFileExclusive, updateFile, unlink }`) with a real default (`defaultPidfileDeps`) built from `node:fs`'s `readFileSync`/`writeFileSync({flag:'wx'})`/`unlinkSync` and `process.kill(pid,0)`. Unlike `run_lock.ts` (whose file is create-once, delete-on-release, no in-place update), the daemon pidfile is **updated in place** (`inFlight` set before each spawn, cleared after each exit) via a plain `writeFileSync` (no `wx`) once the daemon itself already holds exclusive ownership — the `wx` exclusivity only matters at the initial `serve start` acquisition, exactly mirroring why `run_lock.ts`'s own `tryCreate` is `wx` but its steal-then-retry path uses a plain `unlink`+recreate.

**Staleness**: a pidfile is judged stale (safe for a new `serve start` to steal) using the same two-part rule as `run_lock.ts`'s `isStale`: the recorded `pid` is not alive, OR the pidfile is older than a fixed max age (reuse `run_lock.ts`'s existing 4-hour `DEFAULT_MAX_AGE_MS` constant/pattern — the daemon itself is long-running by design, so "older than 4h" alone would wrongly flag a healthy daemon; staleness in practice is decided almost entirely by pid liveness, with the age check as the same defense-in-depth fallback `run_lock.ts` already documents for a recycled pid).

### 6.3 Detach mechanism

Per D5: `spawn(command, args, { detached: true, stdio: 'ignore' })` then `.unref()` — identical primitives to `launcher.ts`'s `launchChrome` (`spawn(chromePath, argv, { detached: true, stdio: 'ignore' }); child.unref();`). No new pattern is introduced; the daemon detaches itself from its own launching `serve start` invocation the same way Chrome is detached from the pipeline run that launches it.

The daemon child is started as `spawn(process.execPath, [mainPath, 'serve', 'start', '--daemon-child'], { detached: true, stdio: 'ignore' })` followed by `.unref()`. `--daemon-child` is an explicit internal flag, not a hidden sub-action — it is internal-only and deliberately omitted from the CLI's `USAGE` string. `serve start` invoked without `--daemon-child` performs the detach-and-exit path described above; `serve start --daemon-child` is the process that becomes the tick loop itself. The `detached: true` + `unref()` primitives remain fixed by D5 regardless of which of the two forms is running.

### 6.4 Sequential multi-profile execution

When `isRunOwed` returns multiple `OwedRun`s in one tick — because multiple profiles each have an owed slot, because a single profile has multiple slots owed simultaneously (D8: possible when that profile's `graceMinutes` exceeds its own smallest inter-slot gap), because a catch-up tick finds several distinct owed slots at once after downtime, or any combination of the above — the daemon spawns and awaits each child **one at a time**, in ascending `(slot, profile)` order — never concurrently. This directly ports the reasoning behind today's `;`-joined single-`launchd`-job-per-slot plist command (`adapters/scheduler/launchd/plist.ts`'s `buildCommand`) and behind `ops/scheduling/run_lock.ts`'s existence: exactly one Chrome/CDP session exists (port 9222, one `.chrome-debug/` user-data-dir) — two concurrent `jobbunny run` invocations would fight over it and corrupt each other's harvest.

The daemon does **not** rely on the cross-process `ops/scheduling/run_lock.ts` lock as its sole protection here — it never spawns a second child while the first is still running, by construction (the `await` in the tick's per-`OwedRun` loop). `run_lock.ts`'s lock remains a second, independent line of defense against a manual `jobbunny run` invoked by the user while the daemon also has a child in flight.

### 6.5 Deadline / run-cap interaction

The spawned child (`jobbunny run --profile <name> --headless`) remains self-bounding via `cli/commands/run.ts`'s `computeRunCapMs` (worst-case stage budgets × 1.25 margin) — this is the primary mechanism and is unchanged.

The daemon ADDITIONALLY arms a `setTimeout` backstop when it spawns a child, set to that child's run cap plus a 5-minute margin. This is the portable successor to the launchd `ExitTimeOut` backstop that today's plist carries (`ExitTimeOut` ≈ 16500s, then `SIGTERM`, 20s wait, then `SIGKILL` — see the deleted `adapters/scheduler/launchd/plist.ts` and its `DEFAULT_RUN_CAP_MS` of 16,200,000 ms, per D14). It exists because a wedged child cannot enforce its own cap — an internal guard cannot kill a wedged process, which is the entire point of an external backstop. This implements the external-backstop half of D3's "makes the run-cap watchdog a simple child kill".

On backstop expiry the daemon sends the child `SIGTERM`, waits 20 seconds, then sends `SIGKILL` if it is still alive — mirroring the escalation the plist performed. Per D10's documented Windows caveat, Node emulates both signals there as an unconditional terminate, so the escalation collapses to a single hard kill on Windows; this is acceptable and needs no separate code path.

The backstop timer is cleared when the child exits normally. The in-flight child's pid is already recorded in the daemon pidfile's `inFlight` field alongside the profile it belongs to (D10, §6.2) — no new pidfile field is needed for the backstop itself — so the child stays killable (by a human, or via `serve stop`) even if the daemon process dies and its in-memory `setTimeout` is lost with it.

`serve stop`'s `SIGTERM` (D10, §6.1) remains the daemon's own manually-triggered kill path, independent of and in addition to this automatic backstop.

### 6.6 Reentrancy guard

The tick loop uses `setInterval(tick, 30_000)` where `tick` is `async`. Node's timer does not skip a scheduled firing merely because the previous invocation's returned promise is still pending, so `tick` itself starts with an in-memory boolean guard (`if (ticking) return; ticking = true; try { ... } finally { ticking = false; }`) — a still-running batch of sequential child spawns (§6.4) must never be entered twice concurrently by the daemon's own timer.

## 7. Chrome discovery and process ownership

### 7.1 Three tiers

| Tier | Source | Always wins? |
|---|---|---|
| 1 | `JOBBUNNY_CHROME_PATH` env var (new — matches the existing `JOBBUNNY_SKIP_SESSION_CLEAR`/`JOBBUNNY_KEEP_BROWSER` naming convention in `launcher.ts`), checked first; otherwise the existing injectable `settings['cdp-chrome'].candidates` from `profile.json` (already threaded through `cli/wire.ts`'s `CdpChromeProvider` construction), checked second and used in full, in order, if non-empty. Whichever of the two is non-empty first is used **in place of** the other, never merged with it — see §7.2's resolution order. | Yes — checked before the per-OS table. |
| 2 | Per-OS candidate table (§7.2), built from environment variables, never hardcoded drive letters. | No — only consulted if tier 1 yields nothing. |
| 3 | The existing error naming every path checked (`resolveChromePath`'s current message shape: `` `no Chrome executable found (checked: ${candidates.join(', ')}) — install Google Chrome` `` — kept verbatim in shape, generalized to not say "Google Chrome" as the only fix when Edge is also a valid candidate on Windows). | — |

### 7.2 Per-OS candidate table

`src/adapters/browser/cdp-chrome/discovery/candidates.ts`:

```ts
export function chromeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[];
```

Pure — no `existsSync` call inside it; it only builds path strings from `env`, exactly mirroring how `resolveChromePath` already keeps its own existence-check (`deps.existsSync`) separate from the candidate list it's given. This is what makes Windows/Linux discovery unit-testable from a macOS dev machine: inject `platform: 'win32'` and a fake `env` object, assert on the returned string array, with no real filesystem or OS involved.

**Windows** (`platform === 'win32'`), in order:

1. `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`
2. `%PROGRAMFILES%\Google\Chrome\Application\chrome.exe`
3. `%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe`
4. `%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe` (last resort — Chromium-based, speaks CDP)

Each `%VAR%` above is `env.LOCALAPPDATA`, `env.PROGRAMFILES`, `env['PROGRAMFILES(X86)']` respectively, joined with the literal suffix via `path.win32.join` (or an equivalent explicit backslash join — this module must not depend on the *executing* platform's `path.join` separator, since a Windows candidate list may be constructed/tested from a non-Windows CI runner). An env var that is unset is skipped (its candidate path is simply not added), never templated with an empty string.

**Linux** (`platform === 'linux'`), in order:

1. `/usr/bin/google-chrome-stable`
2. `/usr/bin/google-chrome`
3. `/opt/google/chrome/chrome`
4. `/usr/bin/chromium`
5. `/usr/bin/chromium-browser`
6. `/snap/bin/chromium`

None of these depend on `env` — they are fixed absolute paths, included in the function's return value unconditionally (existence is still checked later by `resolveChromePath`'s `existsSync`, same as today).

**macOS** (`platform === 'darwin'`), in order: the existing `CHROME_PATH_CANDIDATES` four entries from `launcher.ts`, **plus** the same four suffixes rooted under `${env.HOME}/Applications/` (user-local installs) immediately after each system-wide counterpart:

1. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
2. `${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
3. `/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta`
4. `${HOME}/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta`
5. `/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`
6. `${HOME}/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`
7. `/Applications/Chromium.app/Contents/MacOS/Chromium`
8. `${HOME}/Applications/Chromium.app/Contents/MacOS/Chromium`

`${HOME}` is `env.HOME`; if unset, the four `~/Applications/` entries are skipped (same "unset env var skips the candidate" rule as Windows). `launcher.ts`'s exported `CHROME_PATH_CANDIDATES` constant remains the step-3 default candidate list on darwin specifically — `chromeCandidates('darwin', env)` supersedes it as *the* source of truth once wired; `CHROME_PATH_CANDIDATES` itself may stay exported for backward compatibility within `launcher.ts`'s own module but is no longer the default fed into `resolveChromePath` at the `cdp-chrome` composition point in `wire.ts` — `wire.ts` instead calls `chromeCandidates(process.platform, process.env)` only when steps 1 and 2 below both yield nothing, per the resolution order.

**Resolution order** — first non-empty wins; the winning source REPLACES the others, never merges:

1. `JOBBUNNY_CHROME_PATH` env var, if set and non-empty → `[process.env.JOBBUNNY_CHROME_PATH]` (single element).
2. Otherwise `settings['cdp-chrome'].candidates` from `profile.json`, if present and non-empty → that array used **in full and in order**, unchanged.
3. Otherwise `chromeCandidates(platform, env)` — the per-OS table above.

The resulting array is handed to the existing `resolveChromePath(candidates, deps)`, which returns the first entry that exists.

### 7.3 The pid file

**Location**: `.chrome-debug/.jobbunny-chrome.json` (inside the existing `DEFAULT_USER_DATA_DIR`, i.e. repo-root `.chrome-debug/`).

**Contents**:

```ts
interface ChromePidfile {
  pid: number;
  port: number;
  startedAt: string; // ISO 8601
}
```

**Written**: inside `launchChrome` (`launcher.ts`), immediately after `spawn()` returns a pid — using that same pid (the spawn-returned pid, not a resolved "real listener" pid — see §7.4 for why the old resolve-the-listener workaround is no longer needed the same way).

**Liveness**: `process.kill(pid, 0)` (throws `ESRCH` ⇒ dead), same primitive as `run_lock.ts`'s `pidIsAlive` and `launcher.ts`'s existing `defaultIsAlive`/`killChrome` polling.

**Age**: `Date.now() - Date.parse(startedAt)` — replaces `getProcessAgeMs`'s `ps -o etime=` parse. More accurate (exact spawn timestamp vs. OS-reported elapsed-time granularity) and available on every OS.

### 7.4 Recycle policy

`decideChromeAction` (`provider.ts`) keeps its existing pure shape (`{ reachable, ageMs, maxAgeMs } → 'launch' | 'recycle' | 'reuse'`), but its inputs are now sourced from the pid file rather than `lsof`/`ps`:

- **Reachable + pid file present + its pid alive**: this is a Chrome we (some past run of this codebase) spawned. `ageMs = Date.now() - pidfile.startedAt`. Feed into `decideChromeAction` exactly as before — `reuse` if `ageMs <= maxAgeMs` (24h, `CHROME_MAX_AGE_MS`, unchanged), `recycle` (kill via the pid file's `pid`, then respawn) if older.
- **Reachable + pid file present but its pid is dead**: self-heal — delete the pid file (it's stale/orphaned), then treat as "reachable, no pid file" (next bullet). A dead-pid, present-file case arises when Chrome was killed out-of-band (e.g. Task Manager / Activity Monitor) without going through `killChrome`.
- **Reachable + no pid file (or just self-healed away)**: this Chrome was not spawned by this codebase — attach (`reuse`), **never** recycle, **never** kill. Strengthens the existing `ownsProcess` guard in `provider.ts` (today's guard already refuses to kill a merely-attached Chrome at `close()` time; this extends the same "not mine" reasoning to the recycle decision itself, upstream of `close()`).
- **Not reachable**: `launch` — spawn fresh, write a new pid file at spawn time (§7.3).

This removes the need for `resolveListenerPid`'s original justification (a spawned pid can silently hand off to an already-running Chrome via the profile-singleton mechanism, per `launcher.ts`'s own module doc comment) in its old `lsof`-based form — the pid file is written from the pid `spawn()` itself returned, and liveness/ownership is now decided by whether *that exact* pid is both alive and recorded, not by re-deriving "whoever is listening on the port" via an OS tool. The hand-off risk still technically exists (a spawn can still exit having handed off to an existing profile-singleton Chrome), but the failure mode changes from "silently kill the wrong process" to "the pid file records a pid that immediately dies, self-heals to `no pid file`, and the next `launch()` call correctly falls into the reachable-no-pidfile branch (attach, never kill)" — a safe degradation rather than the old class of bug.

**Self-heal**: performed both at `launch()` decision time (above) and opportunistically whenever the pid file is read and found to reference a dead pid — always delete-on-detect, never leave a known-stale pid file in place for a later reader to trust.

### 7.5 Doctor check

New check (adapter-contributed, same wiring shape as today's `cdpReachableCheck` in `check.ts`, added to the `cdp-chrome` provider's own doctor surface): warns (`warn`, not `red` — a reachable Chrome is not itself broken) when the CDP port is reachable (`defaultCdpReachable` returns non-null) but `.chrome-debug/.jobbunny-chrome.json` does not exist or does not parse. Detail message names the accepted residual risk directly (§7.6) so a user reading `doctor` output understands why it's flagged.

### 7.6 Accepted residual risk

If the pid file is lost (e.g. `.chrome-debug/` partially cleared by hand, or the file is deleted out-of-band) while the Chrome process it described keeps running, that Chrome is permanently in the "reachable, no pid file" bucket — never recycled, potentially accumulating memory indefinitely. This is the same posture as the current `ownsProcess` guard's `false` case (a reused Chrome, kept alive on purpose) — the daemon/pipeline never kills something it doesn't provably own. Documented, not mitigated, per D12.

## 8. Migration from launchd

`serve start`, darwin only, before acquiring the daemon pidfile:

1. Globs `~/Library/LaunchAgents/` for `com.jobbunny.*.plist` (the exact label format `adapters/scheduler/launchd/plist.ts` already used, and that `cli/commands/schedule.ts`'s `runInstall` already prints — e.g. `com.jobbunny.1400`).
2. If zero matches: proceed normally.
3. If one or more matches: refuse to start (exit nonzero, no pidfile written, no daemon spawned) and print a cleanup block shaped like:

```
serve start: found N leftover launchd job(s) from the old scheduler. Run this first:

launchctl bootout gui/<uid>/com.jobbunny.0900
rm ~/Library/LaunchAgents/com.jobbunny.0900.plist
launchctl bootout gui/<uid>/com.jobbunny.1130
rm ~/Library/LaunchAgents/com.jobbunny.1130.plist
...

Then re-run: jobbunny serve start
```

`<uid>` is the real numeric uid (`process.getuid?.()` — Node exposes this on POSIX platforms; darwin always has it). One `bootout`+`rm` pair per plist found, sorted by filename for determinism. `N` and the label list are derived purely from the glob result — no `launchctl list`/`launchctl print` calls, no parsing of `launchd`'s own state; this is deliberately just "does this file exist" plus string templating, so **no** `launchd` adapter code (deleted per D14) needs to be retained to produce this message. Non-darwin platforms skip this check entirely (the glob path itself, `~/Library/LaunchAgents/`, is darwin-only and is never constructed on win32/linux).

## 9. Error handling

### 9.1 Fail-soft / fail-loud scenarios

| Situation | Fail-soft or fail-loud | Behavior |
|---|---|---|
| One profile's `profile.json` is unreadable/invalid during the daemon's schedule scan | Fail-soft | That profile is skipped for this tick (logged), the rest of the schedule scan and tick proceed — mirrors today's `collectScheduledJobs` per-profile skip. |
| A spawned child (`jobbunny run`) exits nonzero | Fail-soft at the daemon level | The daemon logs the nonzero exit and moves on to the next `OwedRun` in the batch (D7: the slot still counts as served — its own run folder/`result.json` records the failure; the runner's internal digest/notify path, unchanged, is what tells the user). The daemon itself never retries a failed run within the same tick. |
| The daemon pidfile is stale (dead pid, or older than the max-age fallback) at `serve start` | Fail-soft (recoverable) | Same two-part staleness rule as `run_lock.ts` (§6.2) — a stale pidfile is deleted and a fresh one is created; `serve start` proceeds normally. |
| The daemon pidfile is **not** stale (a live daemon already holds it) at `serve start` | Fail-loud (refuse, not a crash) | `serve start` prints the holder's pid/`startedAt` and exits nonzero without touching the pidfile — no second daemon is ever allowed to run concurrently (two daemons ticking independently could both decide the same slot is owed and double-spawn). |
| Two `serve start` invocations race at the same instant | Fail-loud for the loser | The pidfile's `wx`-exclusive create is the actual atomicity guarantee (identical mechanism to `run_lock.ts`'s `tryCreate`) — exactly one process wins the create; the other observes `EEXIST`, reads the winner's info, and refuses. |
| Chrome is unreachable when a spawned `jobbunny run` child reaches its `launch()` call | Fail-soft at the Chrome-provider level, then fail-loud only if launch itself fails | Unchanged from today: `decideChromeAction` returns `launch`, `launchChrome` spawns fresh. If even a fresh spawn can't be connected to within `connectMaxWaitMs`, `CdpChromeProvider.launch` throws (existing behavior, `provider.ts` — this is a whole-stage/whole-run failure, which is correct: a run with no browser cannot source LinkedIn jobs at all). The daemon does not distinguish this from any other nonzero child exit (previous row). |
| The grace window expires for a slot with no matching run folder | Fail-soft, by design (not an error) | `isRunOwed` simply stops returning that `OwedRun` once `now > slot + graceMinutes` — no error, no notification beyond whatever the next tick's `serve status` would show as "no next fire until <next slot>". This is the direct fix for the 2026-07-27 incident's failure mode changing from "silent, unrecorded skip" to "the daemon attempted it within its grace window, or explicitly stopped trying after 90 minutes" — still silent past the window, but only because the daemon was down the whole time, which `serve status` (§6.1) surfaces on demand. |
| A daemon's `inFlight` child pid in the pidfile is stale (daemon died mid-run, e.g. hard machine crash) | Fail-soft, self-healing | A subsequent `serve start` (after the stale-pidfile-recovery path above) simply does not know about the old `inFlight` entry — it was part of the now-discarded stale pidfile. The orphaned child (if it happens to still be running — the daemon dying does not itself kill its spawned child, since `spawn` for the child is **not** `detached` per §6.1, so on POSIX it would normally die with its parent's process group; on Windows job-object behavior can differ) is not specially hunted down by the new daemon; `ops/scheduling/run_lock.ts`'s existing per-run lock still prevents that orphan and a fresh daemon-spawned run from executing concurrently. |

### 9.2 The four failure domains

Errors are absorbed at the lowest domain that can still make progress, and escalate only when progress is impossible.

| Domain | Unit | What fails | What bounds it | What recovers it | Blast radius |
|---|---|---|---|---|---|
| 1. Daemon (new) | the clock | daemon process dies; machine off | `setInterval` tick; reentrancy guard (§6.6) | catch-up on next tick (§5); `serve status` reports down | all future runs |
| 2. Child run | one `jobbunny run` process | wedged process; OOM kill | `computeRunCapMs` internally, plus the daemon's `setTimeout` backstop (§6.5) | checkpoint + `--resume`; the next slot | one run |
| 3. Stage | one of the 10 pipeline stages | stage throws | per-stage timeout; per-stage retry attempts | checkpoint written after every stage | the remaining stages |
| 4. Adapter call | one URL, card, probe or request | bad selector; 404; call timeout | `ctx.signal` (AbortSignal) | `SoftError` — recorded, loop continues | one item |

Domain 4 is where CLAUDE.md's "fail-soft where breadth matters" rule lives.

The escalation rule: a stage that attempted work and captured NOTHING throws loud, because zero-from-everything is shaped like an expired login, not like one bad card.

`ctx.signal` is the spine of the whole model. CLAUDE.md's invariant — every CDP, network and LLM call is bound by it, no unbounded `await` in any adapter — is what makes domain 2's deadline actually enforceable: a cancel at the top propagates all the way down. This invariant is load-bearing for the daemon design and must not be weakened by this port.

### 9.3 The three hang classes

Each needs a different bound, and conflating them is how a hang escapes every guard:

1. **Silent stall** — process alive, event loop turning, no progress (e.g. a page whose ready selector never fires). Bounded by the stall watchdog in `pipeline/runner/guard.ts`: stages call `ctx.beat()`, and the absence of beats trips the abort. Timeouts alone do not catch this, because the process looks healthy.
2. **Blocked await** — a single call never returns. Bounded by `ctx.signal` at every I/O site. The invariant holds only while no bare `await` exists in an adapter, which is why CLAUDE.md states it as a hard rule rather than a convention.
3. **Wedged process** — the process can no longer help itself (OOM thrash, a native-layer Chrome hang, a subprocess ignoring signals). Nothing inside the process can fix this. This class is the entire justification for the daemon-side external backstop in §6.5 — `computeRunCapMs` is a promise the child makes to itself, and a wedged child cannot keep promises.

### 9.4 Heavy stages, ranked

Hang risk and memory pressure are not evenly distributed across the 10 stages; this ranking is what the backstop and the checkpoint boundaries are sized against. Evidence below is observed from the 2026-07-27 09:00 and 11:30 run folders.

1. **`farm` — LinkedIn over CDP. The highest-risk stage by a wide margin.** The only stage driving a real browser against a drifting, hostile DOM. Observed `01-farm.json` = 2.1 MB. The 2026-07-27 11:30 run died here on an invalid `p:nth(1)` selector. Config-driven selectors (`page_inventory/*.json`) mean DOM drift is a data fix, not a code fix — but drift lands here first.
2. **`source` → `compress` — the memory peak.** Observed `02-source.json` and `03-compress.json` both 5.6 MB — every job's JD text resident at once. This is why CLAUDE.md caps JD text at 2500 chars and why the structure stage passes markdown tables rather than JSON. Chrome is likely still alive across this window; if so, peak memory is Chrome's working set plus the Node heap, and Chrome dominates. This is the OOM neighbourhood.
3. **`structure` — the slowest external dependency.** Spawns the `claude` CLI as a subprocess. The 2026-07-27 09:00 run spent ~10.7 minutes and failed here after 2 attempts. A subprocess is a distinct hang class from an HTTP call: a CLI waiting on auth produces no bytes and no error.
4. **`sync` — Notion.** Many round trips, rate limits, and the only stage that mutates external state. Byte-exact select options mean schema drift throws rather than degrades.
5. **`reconcile`, `assemble`, `filter`, `dedup`, `rank` — near-zero risk.** Observed `00-reconcile.json` = 34 bytes. The four middle stages are pure core logic with no I/O; they fail only on programmer error, and they fail instantly.

### 9.5 What the daemon must NOT do

- **The daemon must not retry a failed child.** When a child exits nonzero the daemon records the outcome and moves on. Retry belongs inside the run, where the per-stage policy and the checkpoint live. A daemon that retries failed runs hammers a broken pipeline; D7 ("failed runs count as served") exists to prevent exactly this.
- **The daemon must not know about stages.** It knows the clock, the run-folder ledger, and how to spawn and kill a child. It has no pipeline knowledge, which is what keeps domain 1 small enough to be obviously correct.
- **`run_lock` still covers the human.** The daemon's sequential loop (§6.4) prevents self-collision by construction; `ops/scheduling/run_lock.ts` remains the defense against a user running `jobbunny run` manually while the daemon has a child in flight.
- **This port must not weaken the `ctx.signal` invariant.** Any new adapter code introduced by the Chrome-discovery work (§7) is bound by the same no-unbounded-await rule.

## 10. Testing strategy

### 10.1 Pure-core unit tests

`src/core/schedule/owed.test.ts` covers `isRunOwed`/`nextFireAt` with fabricated `Date`s, `ProfileSchedule[]`, and `RunRecord[]` — no fs, no timers, no process. Every branch in §5.1's numbered rule list gets its own case, including the exact 2026-07-27 worked example from §5.2 as a regression fixture (owed at 14:04, served after, not re-owed, and the "never restarted before 15:45" permanently-skipped variant).

### 10.2 Hermetic requirement (D17)

No test anywhere in `src/**/*.test.ts` or `test/**/*.test.ts` may: launch a real Chrome, make a real Notion API call, or make any real network request. This was already the repo's practice (every adapter in this codebase takes injectable deps for exactly this reason — `RunLockDeps`, `LauncherDeps`, `CdpChromeProviderDeps`, etc.) but D17 makes it a **hard, CI-enforced** requirement: any pre-existing test that currently launches a real Chrome or hits a real network endpoint must be converted to use its adapter's existing injectable-deps seam (or gain one, if it doesn't have one yet) as part of this port — before the CI matrix (§10.3) is added, since a non-hermetic test would fail nondeterministically (or hang) on a CI runner with no Chrome installed at all.

### 10.3 CI matrix

`.github/workflows/ci.yml`: a job matrix over `macos-latest`, `ubuntu-latest`, `windows-latest`, each running `npm ci` then `npm run check` (the existing single gate — `typecheck && lint && boundaries && test`, unchanged). No OS-specific steps beyond the matrix `runs-on` — Node 24 is set up via `actions/setup-node` reading the repo's own `.nvmrc`/`engines.node` (`>=24`), consistent across all three runners.

### 10.4 Injectable-from-macOS vs. genuinely-needs-a-runner

| Behavior | Testable from macOS via injection | Needs a real CI runner |
|---|---|---|
| `chromeCandidates('win32', fakeEnv)` returns the right Windows paths | Yes — pure function, no OS dependency in the function itself (§7.2). | — |
| `chromeCandidates('linux', fakeEnv)` returns the right Linux paths | Yes | — |
| `isRunOwed`/`nextFireAt` for any `now`/schedule/history combination, including DST-adjacent or midnight-adjacent times | Yes — pure `Date` arithmetic, no real clock. | — |
| Daemon pidfile create/steal/update/release logic (`ops/daemon/pidfile.ts`) | Yes — injectable `PidfileDeps` exactly like `run_lock.ts`'s `RunLockDeps`, fakeable on any OS. | — |
| Daemon tick loop spawning a fake child and awaiting a fake exit code | Yes — inject a fake `spawn` (same `SpawnFn`-shaped fake pattern `launcher.test.ts` already uses). | — |
| `resolveChromePath`'s candidate-selection logic given a fake `existsSync` | Yes (already true today — unchanged). | — |
| Whether `%PROGRAMFILES(X86)%` etc. are actually set the way Windows sets them, and whether Chrome/Edge is actually found at those real paths | No — this is an environment-shape assumption, not logic. | Yes — only `windows-latest` in CI (or a real Windows machine) proves the assumption; the unit test only proves "given this env shape, we compute this path list" (previous rows), not "this env shape is what real Windows provides". |
| `node:child_process.spawn(..., {detached:true})` actually detaching and surviving parent exit, on each OS | No — this is OS process-model behavior. | Yes — genuinely OS-dependent (`detached` semantics differ between POSIX process groups and Windows job objects), verified by the CI matrix actually running `serve start`/`stop`/`status` end-to-end per OS, not by a unit test with a fake `spawn`. |
| `SIGTERM` behavior difference on Windows (D10's documented caveat — Node emulates it as unconditional terminate) | No — this is a Node/OS behavior, not application logic. | Yes — `windows-latest` in CI is what actually exercises this path; the unit-level `serve stop` test can only assert "we called `process.kill(pid, 'SIGTERM')`", not what the OS does with it. |
| `npm run check` passing (typecheck/lint/boundaries/test) with zero Chrome/Notion/network available | Partially — running locally on macOS with `.chrome-debug/`/`.env` absent approximates it. | Yes, fully — `ubuntu-latest`/`windows-latest` runners have neither by default, which is the actual proof the hermetic requirement (D17) holds. |

## 11. Risks and accepted trade-offs

| Risk / trade-off | Accepted because |
|---|---|
| A reboot leaves the daemon down until the user manually runs `serve start` again (D2) — a multi-day reboot-without-restart still silently misses every slot in between, same failure class as the original incident, just requiring a longer gap to trigger. | Explicitly out of scope (D2) — the autostart seam (§2) is reserved for closing this gap later without redesigning the daemon itself; this spec's job is only to stop *reboot-then-prompt-login-before-grace-expires* from silently dropping a run, which it does. |
| A lost Chrome pid file (§7.6) permanently exempts a still-running Chrome from the 24h recycle policy, risking unbounded memory growth. | Accepted residual risk (D12) — the failure mode is a slow memory creep the user can notice and fix manually (delete `.chrome-debug/`, or kill Chrome by hand), not data loss or a broken pipeline. |
| Windows gets no graceful `SIGTERM` for `serve stop`'s child kill (D10) — an in-flight run is hard-terminated, mid-stage, on Windows. | Accepted (D10) — the daemon/run holds no unflushed in-memory state; every artifact is a checkpoint file on disk (`ops/observability/run_folder.ts`), and `--resume` already exists specifically to continue from an incomplete checkpoint. |
| 30-second tick granularity (D4) means a slot can be served up to ~30s later than its exact due instant, and two ticks landing within the same 30s window around a slot boundary must not double-spawn. | Accepted — 30s against `graceMinutes` (default 90 *minutes*) is negligible, and D9's "any run folder in `[slot, slot+grace]`" matching (not "exactly one tick may act") already makes double-spawns structurally impossible: the second tick's `isRunOwed` call sees the first tick's run folder and returns nothing for that slot. |
| The daemon's own crash mid-tick (e.g. OOM-killed while a child is `inFlight`) leaves an orphaned child process not tracked by any live daemon. | Accepted (§9, "stale `inFlight` pid" row) — `ops/scheduling/run_lock.ts`'s existing cross-process run lock, unrelated to and independent of the daemon pidfile, already prevents that orphan from colliding with a subsequent daemon-spawned run; the orphan itself simply runs to its own completion or is killed by whatever ends its own process tree. |
| Extending `core/config/schema.ts`'s `ScheduleSchema` (adding `enabled`/`weekdays`/`graceMinutes` with defaults, per D18) changes what `PipelineConfigSchema.parse` accepts, touching every profile's config validation, not just scheduling. | Mitigated by D18: accepted as additive-only (all three new fields have defaults, so an existing `profile.json` with only `{ enabled, times }` — today's shape — still parses) — no existing profile requires editing to keep working under the new schema. |
