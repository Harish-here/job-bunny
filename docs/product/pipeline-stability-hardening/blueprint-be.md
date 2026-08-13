# Backend Blueprint — Pipeline Stability Hardening

Slug: `pipeline-stability-hardening` · Author: product-be · 2026-08-13
Consumes: `spec.md` (27 requirements / 21 AC, frozen), `ux-notes.md` + `mockup.html` (frozen),
`.state.md`. Produces the server-side contracts `product-ui` consumes next.

**Classification:** change-to-existing, mature repo, stack settled (Node 24 / TS7 / zod / sqlite).
No stack question. This blueprint resolves the spec's three PROVISIONAL feasibility points (BE1,
BE2, BE3) with named, evidenced contracts, and a fourth cross-cutting problem the task specifically
flagged: the feature's own schema migration would otherwise trigger the exact D2 defect it exists
to fix.

---

## 0. Stack Summary (evidence)

- Runtime: Node 24, TS7 strict/erasable-syntax, zod, `node:sqlite` (`DatabaseSync`, synchronous).
  Runtime deps capped at `@notionhq/client`, `playwright`, `zod` (+`dotenv`) — confirmed no
  `node:dns`/`node:net` usage anywhere in `src/` today (recon, absence confirmed).
- Storage: one sqlite file per profile, `profiles/<name>/data/jobbunny.db`
  (`cli/wire/builders.ts:79-81` `canonicalDbPath`), forward-only migrations gated on
  `PRAGMA user_version`, `LATEST_SCHEMA_VERSION = 7` (`src/adapters/db/sqlite/store/migrations.ts:16`).
  A `user_version` greater than `LATEST_SCHEMA_VERSION` throws
  `` `jobbunny.db schema v${version} is newer than this build supports (v${LATEST_SCHEMA_VERSION})` ``
  from `openJobsDb` (`migrations.ts:155-158`) — the **sole** throw site for this condition.
- Daemon: `ops/daemon/daemon.ts`'s `createDaemon()`, a 30s tick loop (`TICK_MS = 30_000`,
  `daemon.ts:39`), long-lived, separate OS process from any `jobbunny run` child
  (`cli/commands/serve/start.ts`'s parent/child split). Supervision state lives in a JSON pidfile,
  not sqlite (`ops/daemon/pidfile.ts:30-36`), specifically so daemon-authored state survives a
  condition where a profile's own DB is unusable (load-bearing for BE2/D2 below).
- Composition: `cli/wire/compose.ts` is the primary adapter-instantiation chokepoint, but
  `.dependency-cruiser.cjs`'s `only-wire-imports-adapters` rule **already carves out five siblings**
  by name — `builders.ts`, `registry.ts` (type-only), `board.ts`, **`daemon.ts`**, `migrate.ts`
  (`.dependency-cruiser.cjs:49-72`, comment at :57-59: *"daemon.ts is the scheduling daemon's own
  composition point ... ops/daemon itself may not import adapters"*). This carve-out is the
  precedent every new daemon-side adapter access in this blueprint reuses — nothing here asks for
  a rule change.
- Boundary layers: `core/` pure (no I/O), `ports/` imports only `core`, `adapters/` no
  cross-family, `app/` only `ports`+`core`, only `cli` imports `app`, only the six carve-out files
  import adapters, nothing imports `cli`. Two-pair rule (folder = module, `index.ts` public
  surface, >2 impl files splits). File caps 400 impl / 800 test.
- Frozen for this feature: nothing under `src/pipeline/runner/` changes (AC8); the stall watchdog
  stays wall-clock; the gate lives in the daemon, reusing the `slot-expired-skipped` guard-clause
  shape at `daemon.ts:216-226` (decision #2).

---

## 1. The three provisional unknowns, resolved

### BE1 — Where does a deferred-slot record live?

**Read first-hand:** `ports/board.ts:124-138` (the write-surface invariant, verbatim: *"`jobs` and
the runs tables stay pipeline/runner-only — the split is structural, enforced here"*) and
`ports/run_store.ts:1-114` (the full `RunStore`/`RunStatus` vocabulary — no "not attempted" value
exists, and none is added by this blueprint).

**What the invariant actually forbids, precisely:** `BoardStore`'s write surface is `updateTracking`
only; `jobs` and `runs`/`run_events` are read-only from the board's side, and **the runner is the
only writer of `runs`**. The invariant is about *which existing tables* the board may write, and
about *who* writes `runs` — it says nothing about introducing a new table outside that family.

**Decision: a NEW table, `deferred_slots`, written exclusively by the daemon (via the `daemon.ts`
carve-out) and read exclusively by the board.** This does not touch `runs` or `jobs` at all — the
invariant is preserved literally, not reinterpreted. It is the exact structural mirror of an
existing precedent already in the repo: `run_intents` is a table **written by the board and read by
the daemon** (`ports/run_intents.ts`, `cli/wire/daemon.ts:146-231`'s `wireDaemonIntents`). This
blueprint's `deferred_slots` is the same shape with writer and reader swapped — written by the
daemon (via a new `cli/wire/daemon.ts` function, legal under the existing carve-out), read by the
board (via a new `BoardStore` method, legal under the existing "board reads read-only observability"
posture at `ports/board.ts:144-149`). No architecture-invariant change, no bounce needed — this is
additive, reuse-first, and symmetric with code that already ships.

**Rejected alternatives, with reasons:**
- *A `runs` row via the run-store port* — rejected outright. A gated slot must leave **no**
  attempts-ledger entry (R3/AC3) and a deferred slot is precisely a slot that was **not** attempted
  — writing a `runs` row for it would misrepresent it as an attempt, the opposite of what R22-R25
  need, and would require inventing a new `RunStatus` value the spec never asked for.
- *A read-time union computed purely in the board layer with no new storage* — rejected: there is
  no existing durable signal a board-layer join could read (the daemon's pidfile attempts ledger is
  process-lifetime-scoped and resets on every `serve stop`/`start`, per `pidfile.ts:1-13`'s own doc
  comment — it cannot be the source of truth for something the board must show correctly after a
  daemon restart, e.g. the next morning).
- *Folding into an existing daemon-owned surface (the pidfile)* — rejected as the **source of
  truth** (a board-read surface should not depend on process-lifetime JSON that resets on restart),
  but the pidfile is *still used* as the transient "what reason was last observed" scratch space
  that feeds the row `deferred_slots` eventually receives (§3.3 below) — the pidfile and the new
  table play different, non-overlapping roles.

### BE2 — Can the daemon reach a notifier, and how is one wired to it?

**Read first-hand:** `cli/wire/daemon.ts:1-92` (`wireDaemonRunHistory`'s pattern: fresh adapter
instance per call, never memoized, closed in `finally`), `cli/wire/builders.ts:211-214`
(`buildNotifier`, already exported from a carve-out sibling), `ports/notifier.ts:1-10` and
`adapters/notify/telegram/telegram.ts:32-57` (verbatim, both short — quoted below), and
`adapters/db/sqlite/config/store.ts:1-170` (`SqliteConfigStore`'s `readonly` lift mode).

**Wiring — legal, and it reuses code that already exists.** `daemon.ts` is already a legal
adapter-instantiation site (§0). `buildNotifier(name, settings)` (`builders.ts:211-214`) is already
exported from a sibling carve-out file — `cli/wire/daemon.ts` can import it directly, zero new
adapter code. The design: a new `wireDaemonNotifier(overrides)` in `cli/wire/daemon.ts`, built the
same way `wireDaemonScheduleConfig` already reads a profile's `profile.json`
(`wireConfigStore(name, { root, liftMode: 'readonly' })`), parses out `notifiers: string[]` and
`settings: Record<string, unknown>` (the same fields `compose.ts:303-305` reads), and calls
`buildNotifier` for each configured notifier name — returning a plain function
`(profile: string, event: NotifyEvent) => Promise<void>` that daemon.ts receives as an injected
`DaemonDeps` field, exactly like `spawnRun`/`log`/`readRunHistory` are injected today. `ops/daemon/
daemon.ts` itself never imports an adapter — the boundary is honored the same way it already is for
run history and intents.

**Reachability when the daemon is degraded — verified, not assumed.** Two independent facts, read
directly:

1. `TelegramNotifier.send()` (`adapters/notify/telegram/telegram.ts:40-56`) depends on nothing but
   `process.env.TELEGRAM_BOT_TOKEN` and global `fetch`. It never touches a `DatabaseSync` handle,
   directly or transitively. Confirmed independent of any profile's DB.
   ```ts
   async send(event: NotifyEvent): Promise<void> {
     const token = process.env.TELEGRAM_BOT_TOKEN;
     if (!token) throw new Error('telegram: TELEGRAM_BOT_TOKEN is not set');
     const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ chat_id: this.settings.chatId, text: event.text }),
       signal: AbortSignal.timeout(SEND_TIMEOUT_MS), // 10_000
     });
     if (!response.ok) throw new Error(`telegram: sendMessage failed with status ${response.status}`);
   }
   ```
2. **The harder question — can the notifier be *constructed*, i.e. can `chatId` be read from
   `profile.json` when the profile's own DB reports a schema newer than the running build?** Read
   `SqliteConfigStore`'s `readonly` lift mode (`adapters/db/sqlite/config/store.ts`, its own doc
   comment, point 3, and `openReadonly()`): readonly mode does **not** call `openJobsDb` — the
   *only* function that runs the `PRAGMA user_version` check and throws the schema-newer error
   (`migrations.ts:155-158`). It opens `new DatabaseSync(this.dbPath, { readOnly: true })` directly
   and only special-cases `no such table: config_docs` (an *older*-schema symptom). A `SELECT ...
   FROM config_docs` against a *newer*-schema DB succeeds at the SQL level, because `config_docs`
   is untouched by this feature's own migration (§4) — so reading `profile.json` via
   `liftMode: 'readonly'` **never triggers the schema-newer error, regardless of the DB's actual
   `user_version`.**

**Conclusion: the alert path (T6) is verified independent of the very resource it reports on.** The
degraded-daemon notifier is constructed via the same readonly-lift path `wireDaemonScheduleConfig`
already uses, and sends over plain `fetch` — neither step ever opens `runs`/`checkpoints` or runs
`openJobsDb`. This directly closes `ux-notes.md`'s open item #1 ("T6 may be unsendable by the
component it describes... product-be must confirm the alert path does not depend on the degraded
resource") — confirmed with a mechanism, not an assumption.

**Amendment (coordinator, 2026-08-13): detection is per-profile, the notification is daemon-level —
forced by AC14, not a preference.** Schema drift is genuinely a per-profile fact (each `jobbunny.db`
has its own `user_version`), and detection (§5 step 0.3) stays per-profile because that is what the
board (step 0.8) and doctor (step 0.9) accurately need for drill-down. But AC14 requires **exactly
one** notification for the schema-drift condition — a naive per-profile `notify` call would emit N
messages the first time N profiles are touched by the same deploy (the realistic case, since one
code update typically migrates every profile a `jobbunny run` invocation subsequently touches around
the same time), which directly violates that AC. The notification dispatch is therefore collapsed to
one, daemon-level, guarded by a single (not per-profile) pidfile flag, naming every affected profile
inside the one message it sends. See step 0.6 for the exact mechanism.

### BE3 — Where does dedup state live?

**Read first-hand:** `ports/state_store.ts:1-39` (`StateStore.readDoc`/`writeDoc`, a generic
per-profile JSON-document KV store already backed by the `state_docs` table — `migrations.ts:96-102`,
shipped in v3, untouched by this feature) and its 19-file usage across every pipeline stage
(`farm.ts:138`, `source.ts:147-172`, `dedup.ts:39`, etc. — confirmed via grep, not asserted).

**Decision: reuse `StateStore` — zero new table, zero new adapter, zero migration for BE3.**
`ctx.stateStore` is already wired into `PipelineCtx` by `compose.ts` and available inside
`cli/commands/run.ts`, the exact process where the digest-send decision already happens
(`run.ts:308-312`). A new document key, `notify/failure_dedup.json`, holds `{ signature: string;
firstSeenAt: string; lastNotifiedAt: string; consecutiveCount: number }`, read before the existing
`ctx.notify({ kind: 'digest', ... })` call and written after every notify decision. This persists
correctly across separate `jobbunny run` child processes (the requirement BE3 names explicitly)
because `StateStore` is sqlite-backed, not in-memory — the same durability property every other
pipeline stage's state already relies on.

**Why not the pidfile (BE1/BE2's answer for daemon-authored state) or a new table:** failure dedup
is scoped to `jobbunny run`'s own outcome, decided inside the run's own process, not the daemon —
the daemon never sees pass/fail outcomes directly. Reusing the run's own already-injected
`ctx.stateStore` is the smaller, more conventional surface; a new table would duplicate
`state_docs`'s existing purpose for no benefit (YAGNI).

---

## 2. The migration-ordering trap — resolved by splitting into two releases

**The trap, confirmed:** this feature's `deferred_slots` table and `runs.catchup_slots_json` column
(§4) require bumping `LATEST_SCHEMA_VERSION` 7→8. The moment any `jobbunny run` child (always
current, symlinked code) touches a profile's DB, it migrates that DB to v8. A daemon process that
has been running since *before* this feature's D2 fix landed has no self-heal logic in memory (it
predates the fix), so its next tick hits the v8-newer-than-v7 condition exactly as before — the
2026-08-11 outage, reproduced by this feature's own rollout, not by an accident.

**Resolution — ship D2 as its own release, first, with no migration, requiring one documented
manual restart; ship the migration-bearing rest of the feature only after that restart is
confirmed.** This is not a workaround invented for this blueprint — the spec's own decomposition
note already licenses it: *"D2 is independently shippable (it shares no code with the others)"*
(`spec.md` §7). Concretely:

- **Phase 0 (D2 only) needs zero schema change.** The fix is: stop constructing `SqliteRunStore`
  blind for a schema-newer profile (today's bug — no try/catch around `wireDaemonRunHistory`'s
  `new SqliteRunStore(dbPath)`, confirmed by reading `cli/wire/daemon.ts:67-92`: the per-profile
  loop has a `finally` for `store.close()` but no `catch` around construction at all — the throw
  propagates to `daemon.ts`'s `tick()` top-level `catch`, which logs `tick-failed` and swallows it,
  reproducing the incident's "75 occurrences, kept ticking uselessly" exactly). Phase 0 instead
  checks `PRAGMA user_version` **before** opening, using the exact read-only, non-throwing pattern
  already established at `adapters/db/sqlite/check.ts`'s `sqliteDbCheck` (quoted in full at §5,
  step 0.1) — no throw is ever produced, so there is nothing to migrate and nothing to catch.
- **Because Phase 0 has no migration, its own rollout carries no urgency** — nothing is broken
  before the operator restarts the daemon (v7 is still current), so the restart can happen at a
  calm moment, unlike the incident where the fix was needed *during* an active outage.
- **Phase 1 (the migration) gets a verification step, not just a hope.** Implementation step 1.0
  (§5) is a hard gate: before merging Phase 1, confirm (via `jobbunny doctor` or a running-process
  check) that the live daemon has been restarted since Phase 0 shipped. If it has not, Phase 1's
  own PR description must say so and the restart happens as part of that deploy, before the
  migration-bearing code reaches any profile's `jobbunny run` invocation.
- **A genuine secondary benefit, not just risk-avoidance:** this sequencing gives D2 a real,
  production integration test for free — Phase 1's own v7→v8 migration becomes the first live
  proof that D2's self-heal actually survives a real schema bump, observed in the wild before
  anything else in this feature depends on it.

This is called out again as a numbered, checkable implementation step in §5 (steps 0.10 and 1.0) —
not left as prose the executor might skip.

---

## 3. Data Contracts

| Datum | Type | Endpoint / port shape | Source of truth | Evidence / step |
|---|---|---|---|---|
| Suspend-gap decision | `boolean` | `wasHostSuspended(gapMs: number, tickMs: number): boolean` (pure) | Computed fresh every tick from `now − previousLastTickAt` | new `core/schedule/suspend.ts`, step 1.6 |
| Reachability decision | `boolean` | `probeReachable(deps): Promise<boolean>` | Computed fresh every tick, `node:dns` only | new `ops/daemon/reachability/`, step 1.8 |
| Gate decision + reason | `{ declined: boolean; reasonCode: 'host-asleep' \| 'network-unreachable' \| null; reason: string \| null }` | Computed once per `runOwedBatch()` call | `ops/daemon/daemon.ts`, step 1.11 | 
| Deferred slot (per profile DB) | `DeferredSlotRow` (incl. `notifiedAt: string \| null`) | new table `deferred_slots` (§4) | daemon-written, board-read | steps 1.1-1.3, 1.17 |
| Retrospective past-day deferred summary | Telegram digest text (`tg-deferred-day-no-catchup` variant) | daemon-authored, per profile, once per affected past day | `deferred_slots.notifiedAt` + `runs.hasRunOfKind` (durable, survives restart/day-rollover) | step 1.11a — coordinator-added requirement 2026-08-13, spec.md renumbering pending |
| Catch-up label on a run | `catchupSlots: string[] \| null` on `RunSummary`/`RunDetail` | new column `runs.catchup_slots_json` (§4) | run-store writer (`cli/commands/run.ts`, existing channel) | steps 1.1, 1.4-1.5 |
| Daemon degraded state (per profile, detection + board/doctor drill-down) | `{ degraded: boolean; schemaVersion: number \| null; buildVersion: number \| null; detectedAt: string \| null }` on `DaemonProfileSchedule` | extends `ports/board.ts`'s `DaemonStatus` | daemon pidfile `degraded[]` (`ops/daemon/pidfile.ts`), board-read | steps 0.2, 0.8 |
| Daemon degraded notification (daemon-level, exactly one — AC14-forced) | Telegram `NotifyEvent` (`kind: 'alert'`), text names every currently-degraded profile | dispatched via `DaemonDeps.notify`, sender = alphabetically-first scheduled profile **with a notifier configured** (`hasNotifierConfigured`, step 0.5a — not merely alphabetically-first), gated by pidfile `schemaDriftNotifiedAt` | daemon pidfile `schemaDriftNotifiedAt` — a single flag, deliberately NOT per-profile. If no scheduled profile has a notifier configured, no send occurs and the flag stays `null`; the board banner (step 0.8) and doctor (step 0.9) are the only channels in that case. | step 0.6, 0.5a |
| Notifier reachability from the daemon | `(profile: string, event: NotifyEvent) => Promise<void>` | new `DaemonDeps.notify` | `cli/wire/daemon.ts`'s `wireDaemonNotifier`, reuses `buildNotifier` | step 0.5 |
| Failure-signature dedup state | `{ signature: string; firstSeenAt: string; lastNotifiedAt: string; consecutiveCount: number }` | `StateStore` doc, key `notify/failure_dedup.json` | per-profile `state_docs` (existing table, v3) | step 1.16 |
| Catch-up ledger flag | synthetic `DaemonAttempt` with `slot: 'catchup'` | existing pidfile `attempts[]` (`ops/daemon/pidfile.ts:18-22`) | daemon pidfile, process-lifetime | step 1.11 (reuses R8a's own mechanism) |
| Last observed gate-decline reason | `{ reasonCode; reason; at: string } \| undefined` | new pidfile field `lastGateDecline` | daemon pidfile, process-lifetime scratch only | steps 0.2 extended in 1.9 |
| List of deferred slots for a profile | `{ rows: DeferredSlotRow[]; total: number }` | `GET /api/profiles/:name/deferred-slots?date=YYYY-MM-DD` | `BoardStore.listDeferredSlots` | step 1.17 |
| Daemon status (existing, extended) | `DaemonStatus` | `GET /api/daemon` (existing route, unchanged path) | `readBoardDaemonStatus` | step 0.8 |
| Doctor degraded-daemon finding | `DoctorFinding` (existing shape) | `jobbunny doctor --profile <name>` | extended `daemonLivenessCheck` | step 0.9 |
| Run-duration estimate (catch-up ETA, coordinator-added 2026-08-13, corrected round 2) | `RunDurationEstimate \| null` — `{ medianMs, sampleSize }` | `BoardStore.estimateRunDuration()`, surfaced as `RunDetailResponse.estimatedDurationMs` on `GET /api/profiles/:name/runs/:id` | median over the 10 most recent `passed`, `kind IN ('run','catchup')` rows in `runs` whose `run_events` show `already-done-url skips <= page-harvested` (excludes runs short-circuited by same-day URL reuse — verified against real data, not `resumed_from`, which is a no-op today); `null` below 3 samples | step 1.18 |

---

## 4. Schema & Migrations

### Phase 0 — no migration. `LATEST_SCHEMA_VERSION` stays 7.

### Phase 1 — one migration, index 7 in `MIGRATIONS` (`src/adapters/db/sqlite/store/migrations.ts`), v7 → v8:

```sql
-- v7 -> v8: deferred-slot visibility (D3b) + catch-up labeling (D1b)
CREATE TABLE deferred_slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date    TEXT NOT NULL,   -- 'YYYY-MM-DD' local, same convention as runs.run_date
  slot        TEXT NOT NULL,   -- 'HH:MM' local
  reason_code TEXT NOT NULL,   -- 'host-asleep' | 'network-unreachable' | 'daemon-unavailable'
  reason      TEXT NOT NULL,   -- human-readable text, mandatory per R23
  decided_at  TEXT NOT NULL,   -- ISO 8601 UTC, when this row was written (grace-expiry moment)
  notified_at TEXT              -- ISO 8601 UTC, nullable. Set once a deferred-day summary (live,
                                 -- step 1.11.4, or retrospective, step 1.11a — coordinator-added
                                 -- requirement 2026-08-13) has covered this row's date. NOT the
                                 -- catch-up-spawn ledger (that stays in the pidfile, R8a) — this
                                 -- column tracks "has a T4-shaped MESSAGE been sent for this date."
);
CREATE UNIQUE INDEX idx_deferred_slots_one_per_slot ON deferred_slots(run_date, slot);
CREATE INDEX idx_deferred_slots_date ON deferred_slots(run_date);

ALTER TABLE runs ADD COLUMN catchup_slots_json TEXT; -- nullable JSON string[] of 'HH:MM'
```

No `profile` column on `deferred_slots` — matches the existing `runs` table's own convention (no
`profile` column there either; the profile is implicit in which `jobbunny.db` file is open).

**LATEST_SCHEMA_VERSION** bumps to `8` at the same time (`migrations.ts:16`), in the same PR as
the migration array entry — never split across two PRs (a mismatch between the array length and
the constant is exactly the kind of drift the file's own header comment warns against).

**Migration safety — mandatory numbered steps (not proseware):**

1. **Step 1.0 (rehearsal, MUST run before merging Phase 1):**
   - Primary rehearsal target: `profiles/rajni/data/jobbunny.db` — the committed fixture, safe by
     design, already the repo's designated rehearsal target (per the `verify` skill).
     `cp profiles/rajni/data/jobbunny.db /tmp/rajni-migration-rehearsal.db`, point a throwaway
     `JOBBUNNY_HOME` at a scratch copy of `profiles/rajni/`, run `jobbunny doctor --profile rajni`
     (opens the DB, triggers `openJobsDb`, runs the migration in place) against the **copy only**,
     confirm `PRAGMA user_version` reads 8 afterward and every pre-existing row in `runs`,
     `run_intents`, `run_progress`, `config_docs` is untouched (`SELECT count(*)` before/after per
     table, byte-identical row counts).
   - Secondary rehearsal, realistic data volume: copy — **never open the live file directly** —
     `profiles/harish/data/jobbunny.db` to a scratch path outside the repo (e.g. under the
     session scratchpad), and repeat the same migration + row-count check against the **copy**.
     `profiles/harish/` itself is never touched, per CLAUDE.md's explicit rule against running
     experimental stages against real user data.
   - Rollback note: this migration adds a table and a nullable column only — no destructive
     `ALTER`, no data rewrite of existing rows. `openJobsDb`'s existing transaction-per-migration
     (`BEGIN`/`COMMIT`/`ROLLBACK` around each `MIGRATIONS[version]` step, `migrations.ts:163-171`)
     already makes a failed migration atomic: on any error the DB stays at v7, unmodified. No new
     rollback script is needed beyond restoring a pre-migration file backup, which the rehearsal
     step above exercises directly (the copy IS the backup for rehearsal purposes; a production
     rollback is "restore the last `jobbunny.db` file backup," unchanged from today's posture —
     this repo has no automated DB backups today, which is an existing gap this feature does not
     widen or narrow).
2. Expand → migrate → contract shape: not applicable in the Fowler sense here — this is a pure
   additive change (new table, new nullable column), so there is no "old reader breaks" case to
   sequence around *within* the schema itself. The actual expand/contract concern in this feature
   is the D2-before-D1 **release** sequencing in §2, which is the real parallel-change hazard.

---

## 5. Implementation Steps

Two phases, in order. Phase 1 does not start until Phase 0 has shipped and the daemon has been
restarted at least once since (step 1.0's own precondition, verified before Phase 1 work begins).

### Phase 0 — D2, no migration

**0.1 — Extract a shared, non-throwing schema-version reader.**
File: `src/adapters/db/sqlite/store/index.ts` (or a new sibling `version.ts` if the two-pair rule
requires the split). Add `readSchemaVersionReadonly(dbPath: string): number | undefined` —
identical logic to `adapters/db/sqlite/check.ts`'s inline block (`new DatabaseSync(path, {readOnly:
true})`, `PRAGMA user_version`, close in `finally`, `undefined` if the file doesn't exist or fails
to open). Refactor `sqliteDbCheck` (`check.ts`) to call it instead of duplicating the logic.
Done when: `sqliteDbCheck`'s existing tests still pass unchanged, and a new colocated test proves
`readSchemaVersionReadonly` never throws for a missing file, a corrupt file, or a schema-newer file.

**0.2 — Extend the daemon pidfile shape, additively.**
File: `src/ops/daemon/pidfile.ts`. Add to `DaemonPidfile` (line 30-36):
```ts
degraded: DaemonDegradedEntry[]; // per-profile detection — today's + any still-unresolved prior entries
schemaDriftNotifiedAt: string | null; // DAEMON-LEVEL, NOT per-profile — guards the single T6 send
  // (step 0.6). Kept as a separate field from `degraded` on purpose: `degraded` answers "which
  // profiles are affected" (board/doctor drill-down, step 0.8/0.9); this field answers "has the
  // one allowed notification already gone out" (AC14) — conflating the two would either re-notify
  // per newly-degraded profile (violates AC14) or suppress board/doctor detail to match the
  // notification count (wrong information to withhold).
```
```ts
export interface DaemonDegradedEntry {
  profile: string;
  schemaVersion: number;
  buildVersion: number;
  detectedAt: string; // ISO 8601
}
```
Default `[]`/`null` on a fresh pidfile (update `acquireDaemonPidfile`'s `initial` object). Parse
permissively in `parsePidfile` — an absent or malformed `degraded` array is treated as `[]`, an
absent/malformed `schemaDriftNotifiedAt` as `null`, same posture as `parseInFlight`'s "malformed ⇒
drop, not trust." Both fields clear only via a successful daemon restart wiping the whole pidfile
(matches the existing "attempts resets every `serve stop`/`start`" posture — `daemon.ts:179`'s own
comment) — no in-process "un-degrade" or "un-notify" path is needed, since the running build
genuinely cannot read the newer schema until it is replaced.

**Implementation note, load-bearing (checked against `pidfile.ts:109-130`'s actual code, not
assumed):** `parsePidfile`'s required-field gate (`typeof parsed.pid === 'number' && ... &&
Array.isArray(parsed.attempts)`) only validates `pid`/`startedAt`/`lastTickAt`/`attempts` — it does
not reference `degraded`/`schemaDriftNotifiedAt` at all, and more importantly **the function's
return object is an explicit field list, not a spread of `parsed`** (it constructs `{ pid,
startedAt, lastTickAt, inFlight: parseInFlight(parsed.inFlight), attempts }` by hand). Adding
`degraded`/`schemaDriftNotifiedAt` to the `DaemonPidfile` TS interface alone does **not** make them
survive a read — they must be explicitly added to this return construction, each behind its own
permissive parse helper (`parseDegraded(value): DaemonDegradedEntry[]` and
`parseSchemaDriftNotifiedAt(value): string | null`, both mirroring `parseInFlight`'s existing
shape-check-else-drop pattern immediately above `parsePidfile` in the same file) — or a
correctly-written pidfile would silently lose both fields on the very next read, discovered only at
runtime. Same posture applies to `lastGateDecline` (step 1.9) when Phase 1 lands.
Done when: `pidfile.test.ts` gains a case proving a pidfile with no `degraded`/`schemaDriftNotifiedAt`
keys parses with `degraded: []`/`schemaDriftNotifiedAt: null`, and a round-trip write/read test for
both populated — specifically written to fail if `parsePidfile`'s return construction is left
unmodified (i.e. the round-trip test must assert on the VALUE surviving, not merely that reading
doesn't throw).

**0.3 — Daemon-side schema guard, per profile, per tick.**
File: `src/cli/wire/daemon.ts`. New function:
```ts
export function wireDaemonSchemaGuard(
  overrides: DaemonWireOverrides = {},
): (profiles: readonly string[]) => Map<string, { schemaVersion: number; buildVersion: number }> {
```
For each profile: resolve `canonicalDbPath`, skip if the file doesn't exist (never-run profile,
same posture as `wireDaemonRunHistory`), else call `readSchemaVersionReadonly` (step 0.1). If the
returned version is greater than `LATEST_SCHEMA_VERSION` (imported from
`adapters/db/sqlite/store/index.ts`), add `{profile, schemaVersion, buildVersion:
LATEST_SCHEMA_VERSION}` to the returned map. Never throws (mirrors every other `wireDaemon*`
function's fail-soft posture).
Done when: a colocated test injects a `readSchemaVersionReadonly` fake returning 9 for one profile
and 7 for another, asserts the map contains only the first.

**0.4 — Exclude degraded profiles from this tick's owed-slot computation.**
File: `src/ops/daemon/daemon.ts`, inside `runOwedBatch()`, immediately after `scanProfileSchedules`
resolves `schedules` (currently line ~171-175). Filter `schedules` to drop any profile present in
this tick's schema-guard result **before** calling `deps.readRunHistory`/`isRunOwed` — a degraded
profile is excluded from spawning entirely this tick (never blindly respawned, R15's "holds an
explicit degraded state rather than ticking as if healthy"). `readRunHistory` itself is unchanged
(step 0.1's guard already prevents `wireDaemonRunHistory` from ever hitting the throw for that
profile, since the schema guard runs first and the profile is filtered out before `readRunHistory`
would be asked about it).
Done when: a `daemon.test.ts` case seeds one degraded profile among two scheduled profiles, asserts
zero spawn calls for the degraded one and normal spawning for the healthy one.

**0.5 — Daemon-reachable notifier.**
File: `src/cli/wire/daemon.ts`. New function:
```ts
export function wireDaemonNotifier(
  overrides: DaemonWireOverrides = {},
): (profile: string, event: NotifyEvent) => Promise<void> {
```
Per call: `wireConfigStore(profile, { root, liftMode: 'readonly' })`, `readText('profile.json')`,
parse with the existing `PipelineConfigSchema` (import from `core/config/index.ts` — read-only
parse, no validation side effects), extract `notifiers`/`settings`, build each via `buildNotifier`
(imported from `./builders.ts`, already in this file's carve-out family). `Promise.allSettled` over
`.send(event)`, logging (via a passed-in `log` callback, not console directly) any rejection —
mirrors `compose.ts:337-349`'s existing `ctx.notify` implementation almost verbatim, just wrapped
per-profile instead of closed over one profile's `ports.notifiers`. Never throws.
Done when: a colocated test with a fake `buildNotifier`-equivalent proves a missing/malformed
`profile.json` degrades to a no-op (no throw), and a valid config sends via the injected notifier
fake.

**0.5a — Sibling query: does a profile have a notifier configured at all?**
Same file, same carve-out. New function:
```ts
export function wireDaemonHasNotifierConfigured(
  overrides: DaemonWireOverrides = {},
): (profile: string) => Promise<boolean> {
```
Same read path as step 0.5 (`wireConfigStore(profile, { root, liftMode: 'readonly' })`,
`readText('profile.json')`, `PipelineConfigSchema` parse) but returns `notifiers.length > 0` —
a pure query, no send attempt, no adapter construction. This exists because the daemon-level T6
dispatch (step 0.6) must pick a **sender** profile deterministically, and picking one that turns
out to have zero notifiers configured would mean the one guaranteed alert in this entire design
goes silently nowhere — this function is what lets step 0.6 check before, not discover after.
Done when: a colocated test proves a profile with `notifiers: ['telegram']` returns `true`, a
profile with `notifiers: []` or a missing/malformed `profile.json` returns `false`, never throws.

**0.6 — Wire schema-guard + notifier into `DaemonDeps` and the tick loop.**
File: `src/ops/daemon/daemon.ts`. Add to `DaemonDeps` (interface at line 46-80):
```ts
checkSchemaDrift: (profiles: readonly string[]) => Map<string, { schemaVersion: number; buildVersion: number }>;
notify: (profile: string, event: NotifyEvent) => Promise<void>;
hasNotifierConfigured: (profile: string) => Promise<boolean>; // step 0.5a
```
(`NotifyEvent` imported from `ports/notifier.ts` — a type-only import, `ops/daemon` may import
`ports` freely per the boundary rules; only `adapters` imports are restricted.)

In `runOwedBatch()`, right after computing the schema-guard map (step 0.4's filter point):

1. For every profile present in this tick's schema-guard map but **not already present in the
   pidfile's per-profile `degraded` array** (read via `readDaemonPidfile` at the top of the batch,
   same pattern as the existing `pidfile` read at line 181), append a `DaemonDegradedEntry` via
   `updateDaemonPidfile` (fire-and-forget on failure, same posture as the heartbeat write). This
   part stays per-profile — it is accurate detection, and it is what the board (step 0.8) and
   doctor (step 0.9) read for drill-down.
2. **Collapse the notification itself to exactly one, daemon-level send — forced by AC14, not a
   style choice** (see the BE2 amendment note in §1). After step 1 above, if the pidfile's
   (now-updated) `degraded` array is non-empty **and** `schemaDriftNotifiedAt` is still `null`:
   compose ONE T6 message naming every profile currently in `degraded` (not just the ones newly
   added this tick — e.g. `Affected profiles: harish, rajni`), then pick a sender:
   ```
   senderProfile = schedules
     .map(s => s.profile)
     .sort((a, b) => a.localeCompare(b))            // same ordering runOwedBatch's own sort uses
     .find(async p => await deps.hasNotifierConfigured(p))
   ```
   **the alphabetically-first scheduled profile that has a notifier configured** — not merely the
   alphabetically-first scheduled profile. This distinction is load-bearing: the daemon-level T6
   alert is this design's one guaranteed notification, and selecting a profile with no notifier at
   all would send it silently nowhere, reproducing this feature's own core failure mode inside its
   own fix. If `senderProfile` is found: call `deps.notify(senderProfile, { kind: 'alert', profile:
   senderProfile, text })`, then set `schemaDriftNotifiedAt = now.toISOString()` via
   `updateDaemonPidfile`. **If no scheduled profile has a notifier configured at all:** do **not**
   send, and do **not** set `schemaDriftNotifiedAt` — leave it `null` so a later tick retries the
   check (cheap, read-only) in case the operator configures a notifier afterward, and log
   `schema-drift-notify-skipped-no-notifier` at `warn` once per occurrence (this is a benign,
   already board/doctor-visible condition, not a repeat of D2's original "kept ticking uselessly"
   fault — it does not gate spawning or ticking, only this one optional alert). **In this fallback
   case the board's degraded banner (step 0.8) and `jobbunny doctor` (step 0.9) are the only
   channels** — stated explicitly here and in §8 Failure Semantics, not left to be discovered at
   runtime. The T6 text itself is composed inline (a short pure template, no `formatDigest` reuse —
   T6 is not a digest) using the mockup's literal copy (`ux-notes.md` §4 T6) with the `Affected
   profiles: …` line inserted after the cause line, interpolating each affected profile's
   `schemaVersion`/`buildVersion`.
3. A profile that degrades on a **later** tick, after `schemaDriftNotifiedAt` is already set, is
   still added to `degraded` (step 1, board/doctor stay accurate) but triggers no second send — the
   remedy (restart the daemon) and the actionable content are identical regardless of which or how
   many profiles are affected, so a second alert would be noise, not new information.
Done when: (a) a `daemon.test.ts` case degrades two profiles in the SAME tick, asserts exactly one
`notify` call whose text names both; (b) a case degrades a THIRD profile on a LATER tick (after the
first send already happened) and asserts the cumulative `notify` count across every tick stays at
one; (c) a case where the alphabetically-first scheduled profile has NO notifier configured but a
later-sorted one does asserts the send goes through the later profile, not the first; (d) a case
where NO scheduled profile has a notifier configured asserts zero `notify` calls, `schemaDrift
NotifiedAt` stays `null` across multiple ticks, and the skip is logged (not silently dropped).

**0.7 — Thread the new deps through `serve start`.**
Files: `src/cli/commands/serve/index.ts` (`ServeDeps` interface, `defaultServeDeps()`),
`src/cli/commands/serve/start.ts` (`buildDaemonDeps`). Add `checkSchemaDrift`/`notify`/
`hasNotifierConfigured` fields to `ServeDeps`, default-wire them via `wireDaemonSchemaGuard({ root
})`/`wireDaemonNotifier({ root })`/`wireDaemonHasNotifierConfigured({ root })` (mirrors the
existing `readRunHistory: wireDaemonRunHistory({ root })` line exactly), thread them through
`buildDaemonDeps` into `DaemonDeps`.
Done when: `serve/start.test.ts` (existing) still passes, plus a new assertion that
`buildDaemonDeps` forwards all three fields unchanged from `ServeDeps`.

**0.8 — Surface degraded state on the board.**
File: `src/ports/board.ts`. Extend `DaemonProfileSchedule` (line 76-81):
```ts
degraded: boolean;
degradedReason: string | null; // human-readable, mirrors T6's cause line, null when not degraded
```
File: `src/cli/wire/board_daemon.ts`, `readDaemonProfileSchedules`. Read the pidfile's `degraded`
array once (already reading the pidfile in the caller `readBoardDaemonStatus` — pass it down or
re-read; re-reading is cheap and keeps this function's own signature unchanged) and set the two new
fields per profile.
Done when: `board_daemon.test.ts` gains a case with a pidfile carrying one degraded profile,
asserts that profile's `DaemonProfileSchedule.degraded` is `true` with a non-null reason and every
other profile's is `false`/`null`.

**0.9 — Doctor surfaces degraded state (R16, Should).**
File: `src/ops/doctor/aggregate.ts`, `daemonLivenessCheck` (line 168-210). After the existing
pid/heartbeat checks, before the final `ok` return, check the pidfile's `degraded` array for
`opts.profileName`; if present, return `status: 'warn'` (same non-red posture the function's own
doc comment already commits to) with a detail string naming the schema versions and the remedy
(`jobbunny serve stop && jobbunny serve start`).
Done when: `aggregate.test.ts` gains a case for a degraded profile, asserting `warn` with the
remedy text present.

**0.10 — Rollout note (checkable, not prose-only).**
No code change. PR description for Phase 0 must include: *"After merge, run `jobbunny serve stop &&
jobbunny serve start` at least once before Phase 1 (the schema migration) is merged. Phase 1's own
step 1.0 will not proceed without this."* This is the manual step §2 names — recorded here so it is
part of the reviewable plan, not a verbal aside.

### Phase 1 — D1 gate, D1b catch-up, D3 dedup, D3b deferred visibility (migration-bearing)

**1.0 — Precondition gate (MUST, blocks all following steps).**
Confirm the live daemon process has been restarted since Phase 0 shipped: run `jobbunny doctor
--profile <any scheduled profile>` and confirm the `daemon-liveness` check's `detail` reflects a
`startedAt` timestamp after Phase 0's merge commit time (pidfile's `startedAt`, surfaced via
`readDaemonPidfile`). If the daemon has not been restarted, restart it now (`jobbunny serve stop &&
jobbunny serve start`) as a step of *this* deploy, before continuing.

**1.1 — Migration v7→v8.** As specified in §4, including the rehearsal sub-steps. `LATEST_SCHEMA_
VERSION` becomes 8 in the same commit as the `MIGRATIONS` array append.

**1.2 — `DeferredSlotStore` port.**
New file `src/ports/deferred_slots.ts`:
```ts
export interface DeferredSlotRow {
  runDate: string;   // 'YYYY-MM-DD'
  slot: string;      // 'HH:MM'
  reasonCode: 'host-asleep' | 'network-unreachable' | 'daemon-unavailable';
  reason: string;
  decidedAt: string;        // ISO 8601
  notifiedAt: string | null; // ISO 8601, set once a deferred-day summary has covered this date
}
export interface DeferredSlotStore {
  /** Idempotent: a second call for the same (runDate, slot) is a no-op —
   * satisfies R24 (one entry, not one per tick) by construction. */
  recordIfAbsent(entry: Omit<DeferredSlotRow, 'decidedAt' | 'notifiedAt'> & { decidedAt: string }): void;
  listForDate(runDate: string): DeferredSlotRow[];
  /** Distinct `runDate`s strictly before `beforeDate` that still have at
   * least one row with `notifiedAt` null — the retrospective sweep's
   * (step 1.11a) own query surface. Coordinator-added requirement
   * (2026-08-13): without this, a calendar day that never gets a
   * same-day catch-up chance produces no message at all once it rolls
   * into "yesterday." */
  listUnnotifiedDatesBefore(beforeDate: string): string[];
  /** Marks every row for `runDate` notified — idempotent, called once
   * after either sending the retrospective no-catchup summary or
   * confirming a same-day catch-up already covered that date. */
  markNotified(runDate: string, notifiedAt: string): void;
  close(): void;
}
```

**1.3 — `SqliteDeferredSlotStore` adapter.**
New folder `src/adapters/db/sqlite/deferred/` (`index.ts` + `store.ts`, two-pair rule). Lazy-open
via `openJobsDb` (same pattern as `SqliteRunStore`), `recordIfAbsent` uses `INSERT OR IGNORE INTO
deferred_slots (...) VALUES (...)` relying on the unique index from §4 — no read-before-write race
window. `listUnnotifiedDatesBefore` is `SELECT DISTINCT run_date FROM deferred_slots WHERE
notified_at IS NULL AND run_date < ? ORDER BY run_date`. `markNotified` is `UPDATE deferred_slots
SET notified_at = ? WHERE run_date = ?`. Fail-soft posture matches every other writer this
daemon-side path touches (never throws; a failed write is logged by the caller, never fatal to the
tick).
Done when: a colocated `store.test.ts` proves two `recordIfAbsent` calls for the same
`(runDate, slot)` produce exactly one row; `listForDate` returns rows only for the requested date;
`listUnnotifiedDatesBefore` excludes dates that are `>= beforeDate` and dates already fully
`markNotified`; a `markNotified` call updates every row for that date and is itself idempotent
(a second call is a no-op, same value).

**1.4 — Extend `RunKind` and `RunStoreWriter`/reader shapes.**
File: `src/ports/run_store.ts`. `RunKind` becomes `'run' | 'stage' | 'reconcile' | 'catchup'`
(additive, TEXT column, no migration impact — `runs.kind` was never constrained by a `CHECK`).
`RunStoreWriter.startRun`'s `meta` param gains optional `catchupSlots?: string[]`. `RunSummary`/
`RunDetail` gain `catchupSlots: string[] | null`. `RunStoreReader` gains:
```ts
/** True iff a run of `kind` exists for `date` — durable (survives daemon
 * restart AND day rollover), unlike the pidfile's attempts ledger, which
 * is pruned to only today's entries (D19's "A9" comment) and resets on
 * every `serve stop`/`start`. Added for step 1.11a's retrospective sweep:
 * "did a catch-up actually run for a PAST date" cannot be answered from
 * the pidfile at all once the date has rolled over — `runs` can. */
hasRunOfKind(date: string, kind: RunKind): boolean;
```

**1.5 — Adapter persistence for `catchupSlots` and `hasRunOfKind`.**
File: `src/adapters/db/sqlite/runs/store.ts`. `startRun` writes `catchup_slots_json` (JSON-
stringify the array, `null` when absent) alongside the existing insert columns. Read paths
(`listRuns`/`getRun`) parse it back, `null` when the column is `null`. `hasRunOfKind` is
`SELECT 1 FROM runs WHERE run_date = ? AND kind = ? LIMIT 1` — fail-soft like every other reader
here (a query failure returns `false`, never throws, matching the port's own file-header contract).
Done when: existing `runs/store.test.ts` cases pass unchanged, plus a new case round-tripping a
`catchupSlots` value through `startRun` → `getRun`, and a case proving `hasRunOfKind` returns `true`
only for the exact `(date, kind)` pair inserted.

**1.6 — Pure suspend-gap detector.**
New file `src/core/schedule/suspend.ts` (core stays pure — this is arithmetic on two `Date`s
already handed to it, no clock read inside):
```ts
export const TICK_MS = 30_000; // re-exported/mirrored from ops/daemon/daemon.ts's own constant —
  // do not import across the ops/core boundary; core may not import ops. Keep the two values equal
  // by a shared test (see below), not a shared import.
export const SUSPECTED_SUSPEND_GAP_MS = TICK_MS * 4; // 120_000ms — "far exceeds the tick interval"
  // (R1's own wording). Judgment call, no incident-derived exact threshold exists; see NOTES.
export function wasHostSuspended(gapMs: number): boolean {
  return gapMs > SUSPECTED_SUSPEND_GAP_MS;
}
```
A colocated `suspend.test.ts` includes one cross-check test asserting
`SUSPECTED_SUSPEND_GAP_MS > TICK_MS` stays true against `ops/daemon/daemon.ts`'s exported
`TICK_MS` (imported only inside the *test* file — tests may cross the core/ops boundary that
production code may not, matching this repo's existing test-only import conventions elsewhere).
Done when: `wasHostSuspended` is proven true for a 121s gap and false for a 30s gap.

**1.7 — Pure deferred-sweep derivation.**
New file `src/core/schedule/deferrals.ts`:
```ts
export interface DeferralCandidate { profile: string; date: string; slot: string; graceEndAt: Date; }
/** Every (profile, slot) whose grace window has fully closed as of `now`,
 * per today's schedules, that has no serving RunRecord in `history` — pure,
 * mirrors isRunOwed's own served-check exactly (do not re-derive it
 * differently; import and reuse the same `served` predicate shape). */
export function deriveExpiredUnserved(
  now: Date,
  schedules: readonly ProfileSchedule[],
  history: readonly RunRecord[],
): DeferralCandidate[]
```
Done when: a colocated test proves a slot whose grace has NOT yet expired is excluded, a served
slot is excluded (R25), and an expired+unserved slot is included exactly once regardless of how
many times the function is called across simulated ticks (idempotent by construction — the caller,
not this function, is responsible for not re-inserting via `recordIfAbsent`'s own idempotency,
step 1.2).

**1.8 — Bounded reachability probe, `node:` builtins only.**
New folder `src/ops/daemon/reachability/` (`index.ts` + `probe.ts`, two-pair rule):
```ts
export interface ReachabilityProbeDeps {
  lookup: (hostname: string) => Promise<unknown>; // node:dns.promises.lookup, injected for tests
  timeoutMs: number; // default 2500
}
export async function probeReachable(deps: ReachabilityProbeDeps): Promise<boolean> {
  // Promise.race([deps.lookup('www.linkedin.com'), a manual setTimeout-rejection at deps.timeoutMs]);
  // true on resolve, false on ANY rejection (timeout or real DNS failure) — never throws outward.
}
export function defaultReachabilityProbeDeps(): ReachabilityProbeDeps { /* real node:dns.promises.lookup */ }
```
Target host `www.linkedin.com` deliberately mirrors the incident's actual failure signature
(`net::ERR_NAME_NOT_RESOLVED` against LinkedIn specifically) rather than a generic host like
`1.1.1.1` — a probe that passes against a generic host while LinkedIn's own DNS is still degraded
would produce a false-negative gate (spawns a doomed run). `node:dns` only — no new dependency,
satisfies R4/AC6.
Done when: a colocated test with an injected `lookup` fake proves both the timeout path and the
rejection path return `false`, and a resolving fake returns `true`.

**1.9 — Extend the pidfile with the transient gate-decline reason.**
File: `src/ops/daemon/pidfile.ts`. Add optional field:
```ts
lastGateDecline?: { reasonCode: 'host-asleep' | 'network-unreachable'; reason: string; at: string };
```
Single rolling value (not an array) — the gate is host-level, computed once per tick and applied
uniformly to every owed entry that tick (§5 step 1.11), so there is exactly one current reason at
any moment, never a per-slot history. Parsed permissively (absent/malformed ⇒ `undefined`), same
posture as `inFlight`/`degraded`.

**1.10 — Wire the deferred-slot writer/reader.**
File: `src/cli/wire/daemon.ts`. New function `wireDaemonDeferredSlots(overrides)` returning an
object whose field names are exactly what `daemon.ts`'s `DaemonDeps` receives (step 1.11/1.11a
reference these names directly — kept 1:1 so there is no renaming indirection to track):
```ts
{
  recordDeferral: (profile: string, entry: Omit<DeferredSlotRow, 'decidedAt' | 'notifiedAt'> & { decidedAt: string }) => void; // delegates to DeferredSlotStore.recordIfAbsent
  listForDate: (profile: string, runDate: string) => DeferredSlotRow[];
  listUnnotifiedDatesBefore: (profile: string, beforeDate: string) => string[];
  markNotified: (profile: string, runDate: string, notifiedAt: string) => void;
}
```
Each function opens a fresh `SqliteDeferredSlotStore` per call (same never-memoized discipline as
every other `wireDaemon*` function here), delegates to the matching port method, closes. Never
throws — a failed read degrades to `[]`, a failed write is logged by the caller and dropped. Spread
directly into `DaemonDeps` (`recordDeferral`/`listForDate`/`listUnnotifiedDatesBefore`/`markNotified`
become four separate `DaemonDeps` fields, not one nested object — matches the flat-field convention
every other injected dependency in this interface already follows).

**1.11 — The gate, the deferred sweep, and the catch-up decision — all in `runOwedBatch()`.**
File: `src/ops/daemon/daemon.ts`. This is the step the "deliberately opposite ledger rules" warning
governs; read it twice before touching this function.

1. **Capture the pre-tick heartbeat, before it's overwritten.** In `tick()` (line 267-304), the
   heartbeat write is currently the first statement and already overwrites `lastTickAt` before
   `runOwedBatch` runs. Change the write to first `readDaemonPidfile` (capturing
   `previousLastTickAt`), THEN write the new `lastTickAt` — pass `previousLastTickAt` into
   `runOwedBatch(previousLastTickAt)` as a new parameter. This is the one change to `tick()`'s own
   body; everything else in this step lives inside `runOwedBatch`.
2. **Compute the gate decision once per batch**, immediately after `sorted` owed runs are computed
   (current line ~194-198), before the `for (const owed of sorted)` loop:
   ```
   gapMs = now.getTime() - Date.parse(previousLastTickAt)
   suspected = wasHostSuspended(gapMs)          // step 1.6, no I/O
   reachable = suspected ? undefined : await probeReachable(deps.probeReachable) // step 1.8, only probed if not already suspected-suspended (cheap short-circuit, avoids needless network I/O)
   gate = suspected
     ? { declined: true, reasonCode: 'host-asleep', reason: 'Job Bunny declined to start this run because the host was asleep.' }
     : reachable === false
       ? { declined: true, reasonCode: 'network-unreachable', reason: 'Job Bunny declined to start this run because the network was unreachable.' }
       : { declined: false, reasonCode: null, reason: null }
   ```
   `probeReachable` runs **at most once per tick**, and only when `sorted` is non-empty (no owed
   entries this tick ⇒ no reason to probe at all — keeps the daemon's steady-state network usage
   at zero, matching today's behavior when nothing is owed).
3. **Insert the gate as a new guard clause, BEFORE the existing grace-revalidate block** (currently
   at line 216-226), inside the per-entry loop:
   ```
   if (gate.declined) {
     deps.log('gate-declined', { profile: owed.profile, slot: owed.slot, reasonCode: gate.reasonCode });
     if (gate.reasonCode) {
       updateDaemonPidfile(root, (c) => ({ ...c, lastGateDecline: { reasonCode: gate.reasonCode, reason: gate.reason, at: now.toISOString() } }), pidfile); // step 1.9, best-effort
     }
     continue; // R3/AC3 — no ledger append happens below this line for a gated entry.
   }
   ```
   **This `continue` sits ABOVE the existing ledger-append block (line 228-259) and above the
   existing grace-revalidate block (line 216-226) — the gate must be the FIRST guard an owed entry
   can hit, strictly before anything that could consume the slot.** This is the exact ordering
   R3/AC3 requires: a gated slot never reaches the ledger append, stays "owed," and is retried the
   next tick.
4. **After the per-entry loop completes** (all owed entries either gated, expired, ledgered+spawned,
   or ledger-failed), run the deferred sweep and the catch-up decision, once, at the end of
   `runOwedBatch()`:
   ```
   candidates = deriveExpiredUnserved(now, schedules, history)  // step 1.7, reuses the SAME
     // `schedules`/`history` already computed earlier in this function — no re-fetch.
   for (const c of candidates) {
     reason = (pidfileNow.lastGateDecline defined AND its `at` falls within [c's slotAt, c's graceEndAt])
       ? pidfileNow.lastGateDecline
       : { reasonCode: 'daemon-unavailable', reason: "Job Bunny's scheduler was not running during this scheduled window." }
     deps.recordDeferral(c.profile, { runDate: c.date, slot: c.slot, reasonCode: reason.reasonCode, reason: reason.reason, decidedAt: now.toISOString() })
   }
   if (candidates.length > 0) {
     for each distinct profile in candidates, grouped:
       alreadyLedgeredToday = pidfile.attempts.some(a => a.profile === profile && a.date === today && a.slot === 'catchup')
       todaysRows = deps.listForDate(profile, today)  // step 1.10
       t4AlreadySentToday = todaysRows.length > 0 && todaysRows.every(r => r.notifiedAt !== null)
         // i.e. every one of today's deferred_slots rows already has notifiedAt set — this is the
         // T4-MESSAGE guard (deferred_slots.notifiedAt, step 1.2), a SEPARATE concern from the
         // catch-up-SPAWN guard below (pidfile attempts ledger, R8a) — they are decoupled on
         // purpose: R8a exists to stop a 30s respawn storm, this exists to stop a duplicate T4
         // message, and conflating them would tie a message-dedup bug to a spawn-dedup bug or vice
         // versa.
       if (!t4AlreadySentToday) {
         send T4 (deferred-day summary, live/same-day variant) via deps.notify(profile, {kind:'digest', ...})  // BEFORE spawning, per the mockup's own ordering ("Catch-up run starting now — digest to follow")
         deps.markNotified(profile, today, now.toISOString())  // step 1.2/1.10 — marks today's deferred_slots rows covered, regardless of what the spawn below does
       }
       if (!alreadyLedgeredToday) {
         ledger the catch-up attempt: updateDaemonPidfile(... attempts: [...current, {profile, date: today, slot: 'catchup'}] ...)  // R8a — same D19 pattern, BEFORE spawn
         if (ledgered) {
           standingInFor = every deferred_slots row for `profile`+today (deps.listForDate(profile, today))
           await deps.spawnCatchup({ profile, date: today, slot: 'catchup', standingInFor })  // subject to the SAME gate check as any owed entry — if gate.declined, skip spawning THIS tick, do NOT ledger (mirrors R3's own principle — an unledgered catch-up retries next tick); T4 has already been sent above regardless, so a delayed spawn never produces a delayed or duplicate message
         }
       }
   }
   ```
   T4's text composition (banner, list of today's deferred slots for this profile, catch-up-starting
   or next-slot-tomorrow line) is a new pure function in `ops/observability/report/`
   (`deferred_day.ts`, sibling to `digest.ts`, same two-pair-compliant folder) — not `formatDigest`
   itself, since T4 is not a `RunResult`-shaped digest. This same function is reused by step 1.11a
   for the retrospective (previous-day) variant, parameterized by a `catchupFired: boolean` flag.
Done when: `daemon.test.ts` gains cases for: (a) a suspend-gap tick declines every owed entry with
no ledger writes and no spawns; (b) a reachable, non-suspended tick behaves exactly as today
(regression); (c) a day with 5 expired-unserved slots produces exactly 5 `deferred_slots` rows,
exactly one T4 `notify` call, and exactly one `spawnCatchup` call; (d) a second tick the same day,
after both T4 and the catch-up are already recorded, produces zero further `notify`/`spawnCatchup`
calls even after many simulated ticks (AC12); (e) a failed catch-up (spawn resolves nonzero) is not
retried later the same day (AC13, verified by the ledger already being written before spawn
regardless of outcome — the same mechanism that already protects every other slot); (f) a tick where
the gate declines the catch-up spawn itself still sends exactly one T4 that same tick (message and
spawn are decoupled, per the guard split above).

**1.11a — Retrospective past-day deferred summary (coordinator-added requirement, 2026-08-13; final
spec.md requirement number pending the coordinator's own renumbering pass).**
**Why this step exists, traced from the coordinator's own example:** lid closes Monday noon; the
host never wakes again that calendar day; Monday's remaining slots defer (step 1.11.4 writes their
`deferred_slots` rows as each one's grace expires); no catch-up ever fires for Monday, because
catch-up is bounded to the same calendar day and the host was never available during it (R9); step
1.11.4's own T4 guard never fires either, because it only ever evaluates `today`, and by the time the
host wakes on Tuesday, Monday is no longer `today`. Without this step, **Monday produces no message
at all** — a silently lost day, exactly the failure mode this entire feature exists to eliminate.
The mockup already designed and shipped the copy for this (`tg-deferred-day-no-catchup`); only the
trigger was missing, which this step wires.

Wiring addendum to step 1.4/1.5: `cli/wire/daemon.ts` gets one more small function,
`wireDaemonHasCatchupRun(overrides): (profile: string, date: string) => boolean`, following the
exact same never-memoized, fresh-`SqliteRunStore`-per-call discipline as `wireDaemonRunHistory`
(§ step 0.1's sibling pattern) — opens the store, calls the new `hasRunOfKind(date, 'catchup')`
(step 1.4/1.5), closes, degrades to `false` on any failure (never throws). Injected into
`DaemonDeps` as `hasCatchupRun`, wired through `buildDaemonDeps`/`ServeDeps` exactly like every
other daemon-side dependency in this blueprint (step 0.7's pattern).

File: `src/ops/daemon/daemon.ts`, inside `runOwedBatch()`, run once per tick, per profile, **after**
step 1.11's per-entry loop and its own live (today) T4/catch-up block. Cheap by construction — the
underlying query is `notified_at IS NULL AND run_date < today`, indexed, and normally returns
nothing once a healthy operating pattern resumes:
```
for (const profile of schedules.map(s => s.profile)) {
  staleDates = deps.listUnnotifiedDatesBefore(profile, today)  // step 1.10
  for (const date of staleDates) {
    hadCatchup = deps.hasCatchupRun(profile, date)  // wiring addendum above — durable, survives
      // restart AND day rollover, unlike the pidfile's day-pruned attempts ledger (D19's "A9"),
      // which is why this check goes through `runs`, not the pidfile.
    if (!hadCatchup) {
      slots = deps.listForDate(profile, date)  // step 1.10
      nextRun = nextFireAt(deps.now(), [scheduleForProfile])  // EXISTING pure helper, reused as-is,
        // core/schedule/owed.ts:84-111 — no new "what's next" logic invented.
      text = composeDeferredDaySummary({ date, slots, catchupFired: false, nextRunAt: nextRun?.at ?? null })
        // step 1.11's own deferred_day.ts, the SAME function step 1.11.4 uses — reuses the
        // mockup's existing `tg-deferred-day-no-catchup` copy verbatim, no new UX design needed.
      await deps.notify(profile, { kind: 'digest', profile, text })
    }
    deps.markNotified(profile, date, deps.now().toISOString())  // resolved either way: sent, or
      // correctly skipped because a same-day catch-up already covered it (T5 already reported it)
  }
}
```
This is a genuinely separate trigger from step 1.11.4's live mechanism — it exists specifically for
the day-rollover case that mechanism structurally cannot reach (a live tick only ever reasons about
`today`). Both mechanisms share the same `deferred_slots.notifiedAt` bookkeeping, so a given date is
never covered twice, but only this step consults the durable `runs` table (`hasRunOfKind`) rather
than the pidfile, because only `runs` can answer "did anything happen on a date that has already
rolled over and possibly survived a daemon restart since."
Done when: `daemon.test.ts` gains cases for: (a) a profile with 5 `deferred_slots` rows dated
yesterday and no `catchup`-kind run that date ⇒ exactly one `notify` call carrying the no-catchup
variant text, and `markNotified` called once for that date; (b) the same fixture ticked a second
time produces zero further `notify` calls for that date (idempotent via `notifiedAt`); (c) a profile
whose yesterday DID have a `kind: 'catchup'` run in `runs` produces zero `notify` calls (already
covered by T5 the same day) but still calls `markNotified`, so the query stays empty going forward;
(d) a profile with unnotified deferred rows across TWO distinct past dates produces exactly two
`notify` calls, one per date, per the coordinator's "one message per affected day" wording.

**1.12 — Extend the real spawn executor for catch-up.**
File: `src/ops/daemon/supervise/supervise.ts`. `SpawnRun`'s parameter type (currently `OwedRun`,
imported from `core/schedule`) widens to a new exported union in `daemon.ts`:
```ts
export type SpawnTarget = OwedRun | (OwedRun & { standingInFor: readonly string[] });
```
`createSpawnRun`'s argv builder (line 88-92) checks `'standingInFor' in owed`; when present, appends
`'--catchup-slots', owed.standingInFor.join(',')` to the argv array before `'--headless'`. Add a
`DaemonDeps.spawnCatchup: (target: OwedRun & { standingInFor: readonly string[] }) => Promise<number>`
field — real implementation is the SAME `createSpawnRun(superviseDeps)` function reused for both
(it already branches on the shape), so `buildDaemonDeps` (step 0.7's file) wires `spawnCatchup:
spawnRun` (literally the same function reference) — no duplicate executor.
Done when: a `supervise.test.ts` case asserts the child argv includes `--catchup-slots=09:00,11:30`
when `standingInFor` is present and omits the flag when it isn't (regression-proven for the
existing non-catchup path).

**1.13 — CLI flag plumbing.**
Files: `src/cli/main.ts` (`PARSE_ARGS_OPTIONS`, add `'catchup-slots': { type: 'string' }`),
`src/cli/commands/run.ts` (`RunCommandOptions` gains `catchupSlots?: string[]`, parsed from the
comma-separated flag at the `main.ts` → command boundary — the split-on-comma happens in
`main.ts`'s `buildOptions`, matching how other list-shaped flags are already parsed there).
`runCommand` passes `kind: opts.catchupSlots ? 'catchup' : 'run'` and
`catchupSlots: opts.catchupSlots` into `ctx.runStore.startRun(...)` (currently line 262-268).

**1.14 — Failure-signature dedup, pure decision function.**
New file `src/ops/observability/notify/dedup.ts`:
```ts
export interface DedupState { signature: string; firstSeenAt: string; lastNotifiedAt: string; consecutiveCount: number; }
export type DedupAction =
  | { action: 'send'; nextState: DedupState }          // first failure of a signature, or a different one breaking through
  | { action: 'remind'; nextState: DedupState }          // same signature, ≥24h since lastNotifiedAt
  | { action: 'suppress'; nextState: DedupState };       // same signature, <24h since lastNotifiedAt
export function decideNotification(
  prior: DedupState | undefined,
  signature: string,
  now: string,
): DedupAction
```
Pure, colocated `dedup.test.ts` covering AC16/AC17 exactly: N consecutive same-signature failures
in <24h ⇒ exactly one `send` (the first) then all `suppress` until a `remind` fires past 24h; a
signature change while another is suppressed ⇒ immediate `send` (never `suppress`), and the
`nextState` carries the NEW signature forward (old one is not "remembered" as still-open in this
state — T3's "STILL OPEN" line, if kept, is a `run.ts`-level compose concern using the PRIOR state
before it's overwritten, not this function's job to retain both).

**1.15 — `formatDigest` extension for catch-up (T5), and the T2/T3 wrapper.**
File: `src/ops/observability/report/digest.ts`. `formatDigest`'s `opts` param gains
`catchupSlots?: string[]` — when present, inserts the `CATCH-UP RUN — stood in for N missed slots.`
line (mockup T5) immediately after the separator, before the dry-run/failed-stage lines. New
sibling file `src/ops/observability/report/failure_notice.ts` (two-pair: `digest.ts` +
`failure_notice.ts` + `deferred_day.ts` from step 1.11 — three impl files, over the two-pair cap;
split `report/` into `report/digest/` and `report/notice/` subfolders to stay compliant) exports
`composeFailureNotice(base: string, action: DedupAction['action'], count: number,
suppressedSignature?: string): string` — wraps `formatDigest`'s own output with the T2 "STILL
FAILING (xN)" prefix or the T3 "NEW FAILURE" + "STILL OPEN" block, per the mockup's literal copy.
Pure, colocated test.

**1.16 — Wire dedup into `run.ts`'s notify call site.**
File: `src/cli/commands/run.ts`, around the existing `ctx.notify({ kind: 'digest', ... })` call
(line 308-312). Before it: if `result.outcome === 'passed'`, send unconditionally (R20 — success
digests are never suppressed; skip the dedup path entirely). If `'failed'`: read
`ctx.stateStore.readDoc('notify/failure_dedup.json', DedupStateSchema)`, compute a signature
(reuse the existing failure shape — `result.failedStage` + the top-level error string already in
`RunFailure`, joined deterministically), call `decideNotification`, and:
- `send`/`remind` ⇒ compose the wrapped text (`composeFailureNotice`, step 1.15) and call
  `ctx.notify`.
- `suppress` ⇒ do not call `ctx.notify` at all.
Always `ctx.stateStore.writeDoc('notify/failure_dedup.json', action.nextState)` regardless of
action (keeps `consecutiveCount`/`lastNotifiedAt` current even when suppressing).
Done when: `run.test.ts` gains cases for AC16 (two failures, same signature, one send + suppress),
AC17 (signature change breaks through), AC18 (a pass while suppressed still sends).

**1.17 — Board read surface for deferred slots.**
File: `src/ports/board.ts`. New `BoardStore` method:
```ts
listDeferredSlots(query: { date?: string }): { rows: DeferredSlotRow[]; total: number };
```
File: `src/adapters/db/sqlite/board/` (existing `SqliteBoardStore` implementation folder — extend,
do not duplicate). File: `src/app/features/runs/routes.ts` — new route
`GET /api/profiles/:name/deferred-slots`, query-validated the same way `ListRunsQuerySchema`
already is, `date` optional (default: today, local). Response shape:
```ts
export interface ListDeferredSlotsResponse { rows: DeferredSlotRow[]; total: number; date: string; }
```
Done when: a route test proves a profile with 5 deferred rows for today returns exactly those 5,
scoped correctly by date, and an unknown profile 404s the same way every other runs route already
does.

**1.18 — Run-duration estimate for the catch-up banner's ETA (coordinator-added requirement,
2026-08-13; reopened after spec/ux/product-ui each independently flagged the same gap and none
closed it).** Needs no schema — a read over columns `runs` already has (`started_at`, `finished_at`,
`status`, `kind`, `resumed_from`). Does not touch the Phase 0/Phase 1 split, `deferred_slots`,
`schemaDriftNotifiedAt`, or the retrospective sweep — purely additive, can ship in either phase; placed
in Phase 1 because it serves the catch-up banner (D1b), but nothing here depends on step 1.1's
migration landing first.

*Eligibility filter — corrected after the coordinator's own DB query caught a wrong rationale on
round 1 (`resumed_from` is empty on all 14 real passed runs, making that clause a no-op; the real
cause was misdiagnosed). This round's filter was verified directly against the live `harish` profile
DB (`~/.jobbunny/profiles/harish/data/jobbunny.db`, read-only `sqlite3` queries — not reasoned about
in the abstract), not merely reasoned about:*

- `status = 'passed'` — already decided (a failed run's duration measures when it died).
- `kind IN ('run', 'catchup')` — excludes `kind = 'stage'`/`'reconcile'`, neither of which measures
  a full pipeline's duration.
- `resumed_from IS NULL` — **kept, but reframed honestly.** It is currently a no-op on this profile's
  real data (confirmed: `resumed_from` is empty on all 14 passed runs) and does **not** explain the
  observed short-run cluster — that was my round-1 error. It is retained only as a still-logically-
  valid, independent, currently-inert guard against a genuinely different contamination source (a
  manual `jobbunny run --resume`, which the daemon itself never issues but an operator could run by
  hand and which *would* legitimately record a partial-pipeline duration) — cheap to keep, provably
  harmless today, not the load-bearing clause.
- **The actual discriminator, found by querying `run_events` for the real short runs (ids 26, 15, 13,
  8; 1.2–2.8 min each) and reading what they logged:** none of them hit the LinkedIn throttle
  breaker — that hypothesis was wrong too, and I checked it before proposing it (`msg LIKE
  '%skipping this fire without launching a browser%'` matched **zero** of their events). What they
  actually did: the LinkedIn lane's own same-day resume-state (`lane.ts`'s "Multi-fire same-day
  schedules" cache) found nearly every search URL already captured by an *earlier* fire that same
  calendar day, logged once per URL as `linkedin lane: skipping already-done url`, and fetched almost
  no fresh pages (`linkedin lane: page harvested`). Measured directly: the four short runs logged
  20 already-done skips against only 2–6 fresh page-harvests each; every one of the ten genuine
  full-scrape runs logged 0–6 already-done skips against 78–93 fresh page-harvests — a clean,
  wide, verified gap with no overlap. The self-relative comparison **(count of `skipping
  already-done url` events) ≤ (count of `page harvested` events)** separates them with zero tunable
  threshold — no magic number, scale-invariant to however many search URLs the profile configures,
  and directly interpretable: "did this run do more fresh fetching than URL-skipping, or less?"
  Verified by literally running the exclusion query against the real DB (14 real passed runs): all
  four short runs are excluded, all ten (in fact eleven, once the window isn't capped at 14 rows)
  genuine full-scrape runs are retained.
- **Why exclude "already mostly done" runs at all, rather than let them contribute** (a real catch-up
  *can* legitimately hit this case too, e.g. two of five slots succeeded before the lid closed):
  because the cost of the two error directions is asymmetric. The ETA is only ever shown while a
  catch-up is *actively* running — if the true run happens to be an "already mostly done" fast case,
  finishing well before an estimate built on full-scrape data simply means the banner disappears
  early (harmless, and it's the direction the "never negative" clamp already protects). The dangerous
  direction is the one the coordinator named: a median dragged down by short runs would show "almost
  done" while a genuine 28-minute scrape is still running underneath it. Biasing the estimate toward
  the full-scrape population is the conservative, safer error direction for a number shown *during*
  an active wait, not merely a formal exclusion. This directly closes the fragility the coordinator
  flagged: short "nothing new to fetch" runs are no longer eligible to enter the sample at all, so
  they cannot flip the median even if they became a majority of recent activity.

This required no `result_json` parsing (the coordinator's fallback offer) — `run_events`, which
`BoardStore` already reads for the existing `listRunHealth`/`breakerOpen` check
(`adapters/db/sqlite/board/runs_read.ts`), was the more precise and better-precedented source.

*Sample size and recency (my call, as invited):* the 10 most recent eligible rows for this profile
(`ORDER BY started_at DESC LIMIT 10`), no separate recency cutoff. Reasoning: bounding by
most-recent-N already behaves like a recency window in practice — at roughly 5 scheduled slots/day
this profile's last 10 eligible runs span only the last 1-3 days, so a stale outlier ages out within
days without a second, harder-to-tune day-based cutoff that would need re-deriving if the schedule
ever changes (the same "don't hand-tune a threshold that drifts with the schedule" reasoning already
used for the freshness success metric in spec.md). A **minimum of 3** eligible rows is required to
return an estimate at all — below that, the median of 1-2 points is not a meaningful "typical"
duration, and the contract returns `null` rather than a number built on too little evidence. Verified
against the real profile: the corrected filter's most-recent-10 eligible sample is `[28.2, 28.3,
28.5, 28.6, 28.6, 29.0, 30.7, 32.0, 38.8, 45.9]` minutes, median **28.8 min** — tight, representative,
and immune to the short-run contamination the round-1 filter would have let through under a worse
future mix.

*Contract:*
```ts
// src/ports/board.ts
export interface RunDurationEstimate {
  medianMs: number;
  sampleSize: number; // how many eligible runs contributed, always >= MIN_DURATION_SAMPLE_SIZE
}
export const MIN_DURATION_SAMPLE_SIZE = 3;

export interface BoardStore {
  // ...existing methods unchanged...
  /** Median duration (ms) of this profile's most recent eligible runs —
   * passed, kind 'run'/'catchup', and NOT short-circuited by the
   * LinkedIn lane finding most of today's search URLs already captured
   * by an earlier same-day fire (the `already_done <= harvested`
   * `run_events` comparison — see blueprint-be.md step 1.18; this is the
   * load-bearing filter, verified against real data, NOT `resumed_from`,
   * which is currently a no-op on this profile and kept only as an
   * independent, cheap, still-valid guard against a different and
   * currently-inert contamination source).
   * `null` when fewer than `MIN_DURATION_SAMPLE_SIZE` such runs exist —
   * absence, not a guess, is the correct answer when history is thin. */
  estimateRunDuration(): RunDurationEstimate | null;
}
```
File: `src/adapters/db/sqlite/board/` (existing `SqliteBoardStore` folder — extend, do not
duplicate). Query:
```sql
WITH counts AS (
  SELECT r.id,
    SUM(CASE WHEN e.msg LIKE '%page harvested%' THEN 1 ELSE 0 END) AS harvested,
    SUM(CASE WHEN e.msg LIKE '%skipping already-done url%' THEN 1 ELSE 0 END) AS already_done
  FROM runs r
  LEFT JOIN run_events e ON e.run_id = r.id
  WHERE r.status = 'passed' AND r.kind IN ('run', 'catchup') AND r.resumed_from IS NULL
    AND r.finished_at IS NOT NULL
  GROUP BY r.id
)
SELECT r.started_at, r.finished_at
FROM runs r
JOIN counts c ON c.id = r.id
WHERE c.already_done <= c.harvested  -- the verified discriminator; excludes "already mostly
                                       -- done, nothing fresh to fetch" short-circuited runs
ORDER BY r.started_at DESC
LIMIT 10
```
(A run with zero `run_events` of either kind — e.g. a very old row predating this event vocabulary —
has `harvested = 0` and `already_done = 0`, so `0 <= 0` is `true` and it stays eligible rather than
being silently dropped by a `NULL` comparison; `SUM(CASE ...)` over an empty `LEFT JOIN` group
returns `0`, not `NULL`, so this falls out of the query as written without a separate `COALESCE`.)
Compute each row's duration in ms (`finished_at − started_at`), sort ascending, take the standard
median (average of the two middle values on an even count — this is the ordinary definition, not a
reintroduction of the "mean across a wide spread" problem the median was chosen to avoid, since it
only ever averages two adjacent, already-similarly-ranked values). Return `null` if fewer than 3
rows matched.

*Where it's exposed:* not a new endpoint. Folded into the existing per-run detail response the
catch-up banner's live polling already fetches (`GET /api/profiles/:name/runs/:id`,
ux-notes.md §5 S2: "extends `LiveRunHeader`, which already renders stage progress off `run.progress`
and elapsed time"). File: `src/app/features/runs/routes.ts` — a new response-only type, following
the exact precedent `RunListRow extends RunSummary` already sets (composed at the route layer, not
baked into the port's own `RunDetail`, since this is a profile-wide aggregate, not a fact about the
one run being fetched):
```ts
export interface RunDetailResponse extends RunDetail {
  /** Only populated when `status === 'running'` — a finished run already
   * has an actual duration and has no use for an estimate. `null` when
   * not running, OR when `BoardStore.estimateRunDuration()` itself
   * returned `null` (insufficient history) — the UI's existing
   * elapsed-only fallback (ux-notes.md §5 S2, already designed) covers
   * both cases identically and needs no branching on which one it is. */
  estimatedDurationMs: number | null;
}
export type GetRunResponse = RunDetailResponse; // was RunDetail — additive field only
```
The handler calls `store.estimateRunDuration()` only when the fetched run's own `status ===
'running'`, attaches `medianMs` (or `null`) as `estimatedDurationMs`; every other status gets
`estimatedDurationMs: null` without running the query at all (cheap by construction — `LIMIT 10` off
an existing index-friendly column set — but there is no reason to run it for a completed run's
detail view either).

*Clamping — the one explicit call the coordinator left open:* the backend exposes the raw
`estimatedDurationMs` only, never a precomputed "remaining." Remaining-time and the
never-negative clamp (`max(0, estimatedDurationMs − elapsedMs)`) are a **client-side** computation,
because elapsed time is already tracked client-side for smooth between-poll ticking (ux-notes.md
§5 S2's existing `LiveRunHeader` mechanism) — baking a server-computed "remaining" into the response
would freeze at the instant of that particular poll and immediately go stale, and would require the
server to reason about "now" for a value the client already reasons about locally every second. What
the UI *shows* once elapsed reaches or exceeds the estimate (e.g. "almost done" vs "0 min left") is
copy, not a contract value — left to `product-ui`, same as every other display-string decision in
this blueprint's Read-Write Path Map.

Done when: a colocated adapter test proves (a) fewer than 3 eligible rows ⇒ `null`; (b) a mix of
`kind: 'stage'`/`resumed_from` non-null/`status: 'failed'` rows alongside eligible ones only counts
the eligible ones; (c) a run whose `run_events` show more `skipping already-done url` than `page
harvested` entries is excluded even though it is `passed`/`kind: 'run'`/not resumed (the actual
discriminator, not the inert `resumed_from` clause); (d) a run with zero matching `run_events` of
either kind stays eligible (the `0 <= 0` case, not silently dropped); (e) an even-count sample
computes the true two-value-average median, not the mean of the full set; (f) exactly 10 eligible
rows present ⇒ `sampleSize: 10`, and an 11th older eligible row is excluded. A test fixture seeded
from this blueprint's own verified real-data shape (4 short-circuited runs at 1-3 min alongside 10+
genuine runs at 28-46 min) should be included directly, since it is the concrete case this filter
exists to get right. A route test proves `estimatedDurationMs` is `null` on a `status: 'passed'`
run's detail response even when the store has enough history to answer, and populated only for a
`status: 'running'` run.

---

## 6. Read-Write Path Map

| Screen (mockup) | State | Server path |
|---|---|---|
| S1 runs page, deferred day — deferred group | default | `GET /api/profiles/:name/deferred-slots?date=<today>` → `BoardStore.listDeferredSlots` → `deferred_slots` table (step 1.17) |
| S1 — deferred group | empty | Never empty by construction (R25) — endpoint returns `rows: []`, UI renders nothing (no server change; existing "absent ⇒ don't render" convention) |
| S1 — deferred group | loading | Client-side only (existing skeleton idiom); no new server state |
| S1 — deferred group | error | `GET .../deferred-slots` 5xx (store-open failure) — same `ErrorRetry` shape every other board list already returns on a thrown store method |
| S1 — catch-up run row | default/success | `GET /api/profiles/:name/runs` (existing route, unchanged path) — `RunSummary.catchupSlots` now populated (step 1.4-1.5) |
| S2 catch-up banner | running | Existing live-run polling path (`GET .../runs/:id`), `RunDetail.catchupSlots` non-null distinguishes it; **ETA now backed** by `RunDetailResponse.estimatedDurationMs` (step 1.18, coordinator-added 2026-08-13) — the median of this profile's recent full non-resumed passed runs, `null` (existing elapsed-only fallback, ux-notes.md's own designed degrade path) when history is too thin |
| S2 catch-up banner — **variant 2b is the shipping variant** (`catchup-banner-stop-unavailable`, no Stop button) | — | This is the variant `product-ui` should build. Backed entirely by the existing catch-up run-detail data (step 1.4/1.5's `catchupSlots` + elapsed time) — no new endpoint. |
| S2 — variant 2a, the stoppable banner (`catchup-banner-stop`) | — | **Not implemented by this blueprint — do not build the Stop button.** R11 is a Should, and stopping a catch-up requires routing it through the cancellable `run_intents` path, which scheduled/catch-up spawns explicitly do NOT use today (`daemon.ts:120-125`'s own comment: intents are deliberately kept separate from the schedule/ledger mechanisms). See Out of Scope. |
| S3 run detail, catch-up | default | `GET /api/profiles/:name/runs/:id` → `RunDetail.catchupSlots` (step 1.4-1.5) |
| S4 daemon degraded — global strip | degraded | `GET /api/daemon` → `DaemonStatus.profiles[].degraded`/`degradedReason` (step 0.8) |
| S4 — Settings → Schedule status line | degraded | same `GET /api/daemon` (existing route, no new endpoint) |
| S4 — Settings → Schedule status line | error (`/api/daemon` unreachable) | existing behavior, unchanged — this is a network/process failure, not a data path this feature adds |
| T1 first failure | — | `cli/commands/run.ts` notify call, `decideNotification` returns `send` on a fresh signature (step 1.16) |
| T2 daily reminder | — | same call site, `decideNotification` returns `remind` (step 1.16) |
| T3 new signature while suppressed | — | same call site, `decideNotification` returns `send` for the new signature (step 1.16) |
| T4 deferred-day summary (live, same-day) | — | daemon-authored, `wireDaemonNotifier` (step 0.5) + the catch-up-decision block (step 1.11.4) |
| T4 deferred-day summary, no-catchup variant (retrospective, previous day) | — | daemon-authored, `wireDaemonNotifier` (step 0.5) + the retrospective sweep (step 1.11a — coordinator-added 2026-08-13) |
| T5 catch-up digest | — | `formatDigest` extended (step 1.15), sent via the EXISTING per-run `ctx.notify` path (unchanged call site, just richer `opts`) |
| T6 daemon degraded | — | `wireDaemonNotifier` (step 0.5) + the schema-guard block (step 0.6) |
| `jobbunny doctor` degraded finding | — | `daemonLivenessCheck` extended (step 0.9) |

---

## 7. Requirements Coverage

| Req | Server-side delivery |
|---|---|
| R1 | Step 1.6 (`wasHostSuspended`) + step 1.11.2 (computed once per tick) |
| R2 | Step 1.8 (`probeReachable`) + step 1.11.2 |
| R3 | Step 1.11.3 — gate `continue` placed strictly before the ledger-append block |
| R4 | Step 1.8 — `node:dns` only, no new dependency |
| R5 | Step 1.6/1.8 — pure Date arithmetic + `node:dns`, no darwin-only API; cross-OS test in `npm run check`'s 3-OS matrix |
| R6 | No step touches `src/pipeline/runner/`; verified by AC8's own `git diff` check, not re-asserted here |
| R7 | Step 1.11.3's `deps.log('gate-declined', ...)` call, reusing the existing `daemon.log` logger already injected into `DaemonDeps` |
| R8 | Step 1.11.4 — fires per profile whenever `deriveExpiredUnserved` is non-empty for it, regardless of other slots' outcomes |
| R8a | Step 1.11.4 — ledgered via the existing `attempts` array with sentinel `slot: 'catchup'`, BEFORE `spawnCatchup` |
| R8b | Step 1.11.4 — ledger write happens before spawn regardless of outcome, same mechanism that already protects every scheduled slot |
| R9 | Step 1.11.4 — one `spawnCatchup` call per profile per day, covering every candidate in one run (`standingInFor` carries the full list) |
| R10 | Step 1.4-1.5 (`catchupSlots` on `RunSummary`/`RunDetail`) + step 1.15 (T5 label) |
| R11 | **Not delivered — Should, explicitly Out of Scope** (§9); the mechanism it would need (routing catch-up through `run_intents`) is a real architecture change this blueprint does not make silently |
| R12 | Step 0.3 (`wireDaemonSchemaGuard`) — detects via `PRAGMA user_version`, not a per-tick log line |
| R13 | Step 0.6 — a single daemon-level `schemaDriftNotifiedAt` flag (deliberately not the per-profile `degraded` array) gates the one `notify` call, per AC14 |
| R14 | Step 0.8 — `DaemonStatus.profiles[].degraded`/`degradedReason`, per-profile (detection stays granular even though the notification is collapsed — see step 0.6) |
| R15 | Step 0.4 — degraded profiles excluded from spawn consideration, not ticked as healthy |
| R16 | Step 0.9 — `daemonLivenessCheck` extension |
| R17 | Step 1.14/1.16 — `decideNotification` `send` on first-seen signature |
| R18 | Step 1.14/1.16 — `remind` action, `consecutiveCount` carried |
| R19 | Step 1.14/1.16 — a signature change always yields `send`, never `suppress` |
| R20 | Step 1.16 — success path bypasses dedup entirely |
| R21 | Step 1.11.4 (T4) + step 1.17 (board visibility) — deferred slots never individually page |
| R22 | Step 1.2-1.3, 1.17 — `deferred_slots` is a wholly separate read path from `RunStatus` |
| R23 | Step 4 schema — `reason`/`reason_code` both `NOT NULL` at the DB level |
| R24 | Step 1.3 — `INSERT OR IGNORE` + unique index on `(run_date, slot)` |
| R25 | Step 1.7 — `deriveExpiredUnserved` only includes genuinely unserved slots; a slot that later runs is never a candidate in the first place (no delete/resolve step needed) |
| **R-NEW** — retrospective past-day summary (coordinator-added 2026-08-13; spec.md renumbering pending) | Step 1.11a — one message per affected past calendar day, stating no catch-up ran and the next scheduled run, wired to the mockup's existing `tg-deferred-day-no-catchup` copy |

Cross-cutting: **AC1-AC21** are each covered by the "Done when" line of the step(s) above (see §5's
per-step test criteria — not restated as a separate table to avoid duplicating the same mapping
twice; every AC traces to at least one step's Done-when clause). The new coordinator-added
requirement (R-NEW above) will need its own acceptance criterion once spec.md is renumbered; step
1.11a's own "Done when" clause (§5) is written to be that criterion's direct source.

---

## 8. Failure Semantics

| Path | Criticality | Failure mode |
|---|---|---|
| Suspend-gap check (1.6) | Non-critical to correctness of other profiles | Pure function, cannot fail; a wrong `previousLastTickAt` (e.g. first tick ever) degrades to "not suspended" (no gap to compare), fail-open toward normal spawning — matches today's first-tick behavior exactly |
| Reachability probe (1.8) | Non-critical, fail-soft | Any rejection (timeout, DNS error, thrown) ⇒ `false` (declines to spawn) — the SAFER of the two possible wrong answers, since a false decline costs 30s (AC4) while a false "reachable" risks a doomed run |
| `deferred_slots` write (1.3/1.10) | Non-critical to the gate/catch-up decision itself | `recordIfAbsent` failure is caught and logged by the caller, never fatal to `runOwedBatch` — a missed deferred-row write degrades board visibility for that slot, never blocks the next tick or the catch-up decision |
| `wireDaemonNotifier` (0.5) / T4/T6 send | Non-critical to the daemon's own liveness | `Promise.allSettled`, every rejection logged, never thrown — mirrors `compose.ts`'s existing `ctx.notify` posture exactly; a notify failure never stalls or fails a tick |
| T6 sender selection — no scheduled profile has a notifier configured (step 0.6, 0.5a) | Non-critical to the daemon's liveness, but a REAL documented coverage gap, not silently papered over | No T6 is ever sent; `schemaDriftNotifiedAt` stays `null` so the check is retried (cheap, read-only) on every subsequent tick in case a notifier is configured later; the condition is logged once per tick at `warn` (not repeat-suppressed, since it never gates spawning and is already visible on two other channels). **The board's degraded banner (step 0.8) and `jobbunny doctor` (step 0.9) become the only channels for this condition** in that case — this is the one place in the design where Telegram genuinely cannot be the primary channel, and it is stated here rather than discovered at runtime |
| Schema guard (0.3) | **Critical, by design** — this IS the fail-loud-to-fail-visible conversion D2 exists to make | Was: silent, repeat-logged, tick-failed 75x. Now: detected once, recorded durably (pidfile), surfaced on 3 channels (Telegram, board, doctor) — still never crashes the daemon process itself (that would trade "silently deaf" for "silently dead," strictly worse) |
| Catch-up spawn (1.11.4/1.12) | Same criticality as any scheduled spawn | Reuses the existing `createSpawnRun` backstop (SIGTERM→SIGKILL, `BACKSTOP_MARGIN_MS`) unchanged — no new failure surface, same bounded-wait guarantee already proven for scheduled slots |
| Dedup state read/write (1.16) | Non-critical to the run's own outcome | `StateStore.readDoc` returning `undefined` (first-ever failure) is treated as "no prior state," always `send` — fails toward MORE notification, never toward silently swallowing a genuine first failure. `writeDoc` is LOUD per `StateStore`'s own port contract (`state_store.ts:35-37`) but is called AFTER `ctx.notify` inside `run.ts`'s existing `finally`-guarded flow, so a write failure here cannot suppress a notification that already went out — it can only fail to update the dedup bookkeeping for NEXT time, logged, not fatal to this run's own exit code |

**Idempotency / bounded waits, per new path:**
- Gate check: idempotent by construction (pure re-evaluation every tick, no side effect on decline).
- `deferred_slots` write: idempotent (`INSERT OR IGNORE` + unique index, step 1.3).
- Catch-up ledger: idempotent in effect (checked-then-written, same race-acceptance posture the
  existing attempts ledger already has — daemon ticks are sequential, never concurrent, per D6).
- Reachability probe: bounded by an explicit timeout (step 1.8's `timeoutMs`, default 2500ms) —
  never an unbounded await, per CLAUDE.md's hard rule.
- Telegram sends (T4/T6 from the daemon): bounded by `TelegramNotifier`'s own existing
  `SEND_TIMEOUT_MS = 10_000` (`telegram.ts:30`) — unchanged, reused as-is.
- Catch-up spawn: bounded by the existing `runCapMs + BACKSTOP_MARGIN_MS` watchdog
  (`supervise.ts:31,163`) — unchanged, reused as-is.

---

## 9. Risks & Assumptions

- **`SUSPECTED_SUSPEND_GAP_MS = 120_000` (step 1.6) is a judgment call, not an incident-derived
  number.** The spec says "far exceeding the tick interval" without a number. 4× the tick interval
  gives comfortable margin over normal `setInterval` jitter while staying well under the incident's
  observed ~15-minute DarkWake gaps. Flagged for product-ui/QA to treat as tunable, not sacred.
- **RESOLVED by coordinator amendment (2026-08-13):** the "no catch-up will fire" T4 variant
  (`tg-deferred-day-no-catchup`) previously had no requirement naming its trigger. It is now wired
  by step 1.11a (the retrospective past-day sweep), which the coordinator added as a new
  requirement after tracing a genuine hole: a host that stays asleep for the rest of a calendar day
  never gets a same-day catch-up chance, and without step 1.11a that day produces no message at all
  once it rolls into "yesterday" — reproducing the feature's own core failure mode. See step 1.11a.
- **A catch-up itself declined by the gate is not re-notified via T4** — only the FIRST detection of
  "today has deferred slots" sends the LIVE (same-day) T4 (guarded by `deferred_slots.notifiedAt`,
  step 1.11.4). If the catch-up attempt is later gated (host still unreachable at that exact tick)
  and retries silently on a subsequent tick, the operator already received T4's "Catch-up run
  starting now" line even though the actual spawn may be delayed by a few ticks. This mirrors AC4's
  own "transient decline costs ~30s, not the slot" tolerance and is judged acceptable — flagged, not
  silently smoothed over. (If the host never does wake again that day, step 1.11a's retrospective
  sweep is what catches the fully-lost case the next time the daemon ticks.)
- **RESOLVED by coordinator amendment (2026-08-13):** T6's per-profile-vs-daemon-global mismatch is
  no longer a mismatch — it was forced into a decision (§1 BE2 amendment, step 0.6): detection stays
  per-profile (accurate), the notification is daemon-level (AC14-forced), and the message names
  every affected profile inline. No product-ui decision needed here anymore.
- **No automated DB backup exists in this repo today** — the migration's rollback story (§4) is "the
  transaction is atomic, and a file-level backup is the operator's own responsibility," an existing
  gap this feature neither creates nor closes.
- **The two-release split (§2) assumes the operator actually restarts the daemon between Phase 0
  and Phase 1**, verified by step 1.0's precondition check rather than assumed silently — but there
  is no code-level enforcement preventing someone from merging Phase 1 without ever having
  restarted. This is a process gate, not a technical one; flagged explicitly rather than treated as
  closed.

---

## 10. Out of Scope

| Cut | Reason |
|---|---|
| R11 — stoppable catch-up from the board (mockup variant 2a, `catchup-banner-stop`) | Should, not Must. Requires routing catch-up spawns through `run_intents`, which the daemon's schedule path deliberately does not use today (`daemon.ts:120-125`) — a real architecture change, not a small addition, so this blueprint does not make it silently. **Confirmed: variant 2b (`catchup-banner-stop-unavailable`, no Stop button) is the variant this blueprint supports and the one `product-ui` should implement — it ships with zero backend change, per ux-notes.md §2's own "Only variant 2a depends on R11" framing.** Costs nothing to cut: everything else in U2 (label, stand-in count, Chrome sentence, ETA, message T4) is Must-only and ships either way. |
| ~~Catch-up duration estimate / ETA source~~ | **No longer out of scope — delivered by step 1.18** (coordinator-added requirement, 2026-08-13). Left here struck through rather than silently deleted, so the reversal is visible in a diff. |
| Automated daemon self-restart on schema drift | Explicitly out of scope per spec.md's own Out of Scope table — a process cannot reload its own code; this blueprint's D2 fix is detection + alert + degrade, not restart automation. |
| Retry/auto-resume of a failed scheduled run | Different problem per spec.md; `--resume` stays opt-in, untouched by this blueprint. |
| A dedicated "recovered" notification | Cut in spec.md; success digests already cover it (R20 preserves this — success always sends). |
| Automated DB backup/restore tooling | Pre-existing gap, not created or worsened by this migration; the rehearsal step (§4) is the mitigation this feature specifically owns. |
| Making all pipeline deadlines monotonic-aware | Named architectural debt in spec.md, explicitly deferred beyond this slice. |

---

## Notes for product-ui

- `DaemonStatus.profiles[]` already existed; only two fields (`degraded`, `degradedReason`) are
  added — the existing `nextRunAt`/`enabled` shape is untouched.
- `RunSummary`/`RunDetail` gain exactly one new field (`catchupSlots: string[] | null`) — every
  other field is unchanged, so existing UI code that doesn't know about catch-up keeps working
  (Postel: consumers tolerate the new field being absent/null).
- The deferred-slots endpoint is intentionally separate from `GET .../runs`, not merged into it —
  the UI is expected to do two parallel fetches for S1 (mirrors how daemon status is already a
  separate fetch from runs today). This keeps the `runs` response contract byte-stable for every
  existing consumer.
- `reasonCode` is the machine-stable value for icon/species selection; `reason` is the literal
  human string for display — product-ui should key any conditional rendering off `reasonCode`, not
  off parsing `reason` text.
- **S2/R11 — build variant 2b only.** Implement `catchup-banner-stop-unavailable` (no Stop button,
  "Runs to completion — about N min left"). Do **not** implement variant 2a's Stop button
  (`catchup-banner-stop`) — there is no backend support for cancelling a catch-up, confirmed and
  accepted by the coordinator (§10 Out of Scope).
- **S2's ETA is now backed by real data (step 1.18, coordinator-added 2026-08-13) — reverses the
  earlier "elapsed-only" framing.** `GET .../runs/:id`'s response gains `estimatedDurationMs: number
  | null` (populated only while `status === 'running'`). Compute `remaining = max(0,
  estimatedDurationMs - elapsed)` **client-side** (elapsed is already tracked locally for smooth
  ticking) — the backend deliberately does not precompute or clamp "remaining" itself. When
  `estimatedDurationMs` is `null` (either not running, or fewer than 3 eligible historical runs
  exist for this profile yet), fall back to elapsed-only exactly as originally designed — same
  fallback, now reached less often. What to display once elapsed reaches/exceeds the estimate (e.g.
  "almost done" vs "0 min left") is copy — product-ui's call.
- **T4's `tg-deferred-day-no-catchup` variant is now live**, not dead mockup copy — it is sent by
  step 1.11a whenever the host never wakes during a calendar day that had deferred slots. No new UX
  work needed; the mockup's existing copy is reused verbatim.
- **T6 (`tg-daemon-degraded`) is sent at most once per daemon lifetime, daemon-level, not
  per-profile** — the text names every currently-affected profile inline (e.g. "Affected profiles:
  harish, rajni"). The board's per-profile `degraded`/`degradedReason` fields remain granular for
  drill-down even though the Telegram alert is collapsed to one message — do not assume a 1:1
  relationship between board rows and Telegram sends for this condition. If no scheduled profile has
  a Telegram notifier configured at all, T6 never sends — the board banner (S4) and doctor are the
  only channels in that case (§8). The board's own display is unaffected either way (it does not
  depend on whether T6 fired), so this needs no UI-side branching — flagged here only so it is
  understood, not implemented around.
