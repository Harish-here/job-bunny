# Scheduling Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `launchd`-based scheduling with an in-process daemon (`jobbunny serve start|stop|status`) that ticks a wall clock every 30 seconds and reasons about "is a run owed right now" against local time, so a reboot-before-login produces a late run instead of a silently skipped one.

**Architecture:** A pure core (`src/core/schedule/`) decides, given `now`, a set of `ProfileSchedule`s, and a merged history of actual run folders plus in-flight attempt records, which `(profile, slot)` pairs are owed right now (`isRunOwed`) — zero I/O, fully unit-testable. An orchestration layer (`src/ops/daemon/`) scans `profiles/*/profile.json` and `profiles/*/data/runs/<date>/` on disk, maintains a heartbeat-and-attempts-ledger pidfile mirroring `ops/scheduling/run_lock.ts`'s injectable-deps shape, and spawns `jobbunny run --profile <name> --headless` as a child process one at a time.

**Tech Stack:** TypeScript 7 (strict, erasable-syntax-only), Node 24 stdlib only (`node:fs`, `node:path`, `node:os`, `node:child_process`, `node:test` + `node:assert/strict`), zod (for the one config-schema extension in Task 1).

## Global Constraints

- Node >= 24, ESM, TypeScript 7 strict with erasable-syntax-only (no enums, no namespaces).
- Runtime dependencies must NOT increase. Current: `@notionhq/client`, `dotenv`, `playwright`, `zod`. The entire daemon is Node stdlib only (D5).
- Two-pair rule: a folder exceeding two implementation files (test pairs and `index.ts` excluded) gets split into subfolders first.
- Every module is a folder with an `index.ts` public surface; internals are not imported across module boundaries.
- Colocated tests: `foo.ts` pairs with `foo.test.ts`.
- Boundary rules enforced by `npm run boundaries`: `core/` imports nothing outward; `ports/` imports only `core`; `adapters/` may not import `pipeline`, `routines`, `ops`, or `cli`; only `cli/wire.ts` imports `src/adapters/**`; nothing imports `cli`.
- Tests must be hermetic — no real network, no real Chrome, no real Notion, no real timers where avoidable. Keep the repo's zero-violation record.
- `npm run check` (typecheck + lint + boundaries + test) is the gate, and every task must end with it green.
- The daemon spawns `jobbunny run` as a CHILD PROCESS; it never imports the pipeline, adapters, or cli (D3).
- This plan depends on the Foundation plan (`2026-07-27-cross-platform-foundation.md`) only for the CI matrix; it does not consume any of its code — `src/core/schedule/`, `src/ops/daemon/`, and the config-schema extension below are all net-new and independent of `src/adapters/browser/cdp-chrome/discovery/`.

---

### Task 1: extend `ScheduleSchema` (D18)

**Files:**
- Modify: `/Users/harishamutha/Job-bunny/src/core/config/schema.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/core/config/schema.test.ts`

**Motivating fact:** `schedule.enabled` in `profiles/harish/profile.json:5` is silently stripped by zod today — the schema declares no such key and zod strips unknown keys by default. It is honored only by the looser `RawScheduleSchema` in `src/cli/commands/schedule.ts:71-76`, which a later task in the companion daemon-CLI plan deletes. Without this schema change the daemon has no validated way to know which profiles are enabled.

**Interfaces:**

Consumes: nothing new — extends the existing `ScheduleSchema` zod object in place.

Produces (replaces `schema.ts:10-12` verbatim):
```ts
export const ScheduleSchema = z.object({
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')),
  enabled: z.boolean().default(true),
  weekdays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  graceMinutes: z.number().int().positive().default(90),
});
```

Rules: all three new fields are optional-with-defaults, so `profiles/harish/profile.json` and `profiles/rajni/profile.json` remain valid with **no edit** — do not edit either file as part of this task. `schedule` stays `.optional()` on `PipelineConfigSchema` (line 19, unchanged) — a profile with no `schedule` block is simply never scheduled. Per CLAUDE.md's "Seeding never clobbers" rule, `jobbunny profile build` (out of scope for this task) must fill these only when absent, never overwrite a user-set value.

- [ ] **Step 1: Write the five failing tests against the extended schema.**

  Append to `/Users/harishamutha/Job-bunny/src/core/config/schema.test.ts`:

  ```ts
  test('schedule with only times gets enabled/weekdays/graceMinutes defaults', () => {
    const cfg = PipelineConfigSchema.parse({
      connector: 'notion',
      schedule: { times: ['09:00'] },
    });
    assert.deepEqual(cfg.schedule, {
      times: ['09:00'],
      enabled: true,
      weekdays: [1, 2, 3, 4, 5],
      graceMinutes: 90,
    });
  });

  test('schedule with explicit enabled/weekdays/graceMinutes preserves them', () => {
    const cfg = PipelineConfigSchema.parse({
      connector: 'notion',
      schedule: {
        times: ['09:00'],
        enabled: false,
        weekdays: [0, 6],
        graceMinutes: 45,
      },
    });
    assert.deepEqual(cfg.schedule, {
      times: ['09:00'],
      enabled: false,
      weekdays: [0, 6],
      graceMinutes: 45,
    });
  });

  test('rejects an out-of-range weekday', () => {
    assert.throws(() =>
      PipelineConfigSchema.parse({
        connector: 'notion',
        schedule: { times: ['09:00'], weekdays: [7] },
      }),
    );
  });

  test('rejects a non-positive graceMinutes', () => {
    assert.throws(() =>
      PipelineConfigSchema.parse({
        connector: 'notion',
        schedule: { times: ['09:00'], graceMinutes: 0 },
      }),
    );
  });

  test('a config with no schedule key at all still parses fine', () => {
    const cfg = PipelineConfigSchema.parse({ connector: 'notion' });
    assert.equal(cfg.schedule, undefined);
  });
  ```

- [ ] **Step 2: Run the test file and see the new assertions fail.**

  ```bash
  node --test src/core/config/schema.test.ts
  ```

  Expected failure: the first two tests fail on `assert.deepEqual` — `cfg.schedule` has only `{ times: [...] }` today, because the current schema declares no `enabled`/`weekdays`/`graceMinutes` keys and zod strips them. The two `assert.throws` tests fail because `PipelineConfigSchema.parse` does **not** throw today — `weekdays`/`graceMinutes` are unrecognized keys, silently stripped rather than validated. The fifth test already passes (`schedule` is already `.optional()`).

- [ ] **Step 3: Replace `ScheduleSchema` with the extended version.**

  In `/Users/harishamutha/Job-bunny/src/core/config/schema.ts`, replace:

  ```ts
  export const ScheduleSchema = z.object({
    times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')),
  });
  ```

  with:

  ```ts
  export const ScheduleSchema = z.object({
    times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')),
    enabled: z.boolean().default(true),
    weekdays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
    graceMinutes: z.number().int().positive().default(90),
  });
  ```

- [ ] **Step 4: Run the test file again and see everything pass.**

  ```bash
  node --test src/core/config/schema.test.ts
  ```

  Expected: `# pass 8` (3 pre-existing tests + 5 new ones), `# fail 0`.

- [ ] **Step 5: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green. This also confirms `profiles/harish/profile.json` and `profiles/rajni/profile.json` still parse — nothing in the repo constructs a `PipelineConfig` from a fixture that would now fail validation, since all three new fields are optional-with-defaults.

- [ ] **Step 6: Commit.**

  ```bash
  git add src/core/config/schema.ts src/core/config/schema.test.ts
  git commit -m "$(cat <<'EOF'
  feat(config): validate schedule.enabled/weekdays/graceMinutes (D18)

  ScheduleSchema silently stripped `enabled` (and had no `weekdays`/
  `graceMinutes` at all), honored only by a looser, now-obsolete raw
  schema in cli/commands/schedule.ts. All three fields are
  optional-with-defaults so every existing profile.json keeps parsing
  unmodified — this is what gives the scheduling daemon a validated
  way to know which profiles are enabled.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: schedule types + run-folder name parsing

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/core/schedule/types.ts`
- Create: `/Users/harishamutha/Job-bunny/src/core/schedule/types.test.ts`
- Create: `/Users/harishamutha/Job-bunny/src/core/schedule/index.ts`

**Placement rationale:** pure domain types plus pure string-parsing helpers, zero I/O — `src/core/schedule/` per the executor's placement rules (pure domain logic, zero I/O). `core-is-pure` is satisfied: this module imports nothing outward.

**Interfaces:**

Consumes: nothing.

Produces:
```ts
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ProfileSchedule {
  profile: string;
  enabled: boolean;
  times: string[];       // "HH:MM", local wall clock
  weekdays: Weekday[];
  graceMinutes: number;
}

export interface RunRecord {
  profile: string;
  date: string;      // "YYYY-MM-DD" local
  startedAt: string; // "HH:MM" local
}

export interface OwedRun {
  profile: string;
  date: string;  // "YYYY-MM-DD" local
  slot: string;  // "HH:MM" local
}

export function parseRunFolderName(name: string): string | undefined;
export function formatLocalDate(d: Date): string;
export function localHhMm(d: Date): string;
export function hhMmToMinutes(hhMm: string): number;
```

- [ ] **Step 1: Write the failing tests.**

  Create `/Users/harishamutha/Job-bunny/src/core/schedule/types.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { formatLocalDate, hhMmToMinutes, localHhMm, parseRunFolderName } from './types.ts';

  test('parseRunFolderName: a plain HH-MM folder parses to HH:MM', () => {
    assert.equal(parseRunFolderName('14-04'), '14:04');
  });

  test('parseRunFolderName: a collision-suffixed HH-MM-N folder strips the suffix', () => {
    assert.equal(parseRunFolderName('14-04-2'), '14:04');
  });

  test('parseRunFolderName: a non-run-folder name is undefined', () => {
    assert.equal(parseRunFolderName('sync_dryrun.json'), undefined);
  });

  test('parseRunFolderName: an unpadded single-digit hour is undefined (run_folder.ts always zero-pads)', () => {
    assert.equal(parseRunFolderName('9-00'), undefined);
  });

  test('formatLocalDate: formats a fixed local Date as YYYY-MM-DD', () => {
    assert.equal(formatLocalDate(new Date(2026, 6, 27, 14, 4)), '2026-07-27');
  });

  test('localHhMm: formats a fixed local Date as HH:MM', () => {
    assert.equal(localHhMm(new Date(2026, 6, 27, 14, 4)), '14:04');
  });

  test('localHhMm: zero-pads single-digit hour and minute', () => {
    assert.equal(localHhMm(new Date(2026, 6, 27, 9, 5)), '09:05');
  });

  test('hhMmToMinutes: converts HH:MM to minutes since local midnight', () => {
    assert.equal(hhMmToMinutes('00:00'), 0);
    assert.equal(hhMmToMinutes('14:04'), 844);
    assert.equal(hhMmToMinutes('23:59'), 1439);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `types.ts` does not exist yet.**

  ```bash
  node --test src/core/schedule/types.test.ts
  ```

  Expected failure: `Cannot find module '.../core/schedule/types.ts'` (module resolution error, not an assertion failure — the file doesn't exist yet).

- [ ] **Step 3: Implement `types.ts`.**

  Create `/Users/harishamutha/Job-bunny/src/core/schedule/types.ts`:

  ```ts
  /**
   * core/schedule/types.ts — the pure vocabulary the daemon's owed-slot
   * decision (owed.ts) is built from. Local wall-clock time throughout, never
   * UTC: run-folder names (ops/observability/run_folder.ts's formatRunTime)
   * are local, and using UTC here is a bug this project already hit once —
   * run.log timestamps are UTC while folder names are local, and conflating
   * the two silently misaligns "is this slot served" checks.
   */

  export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

  export interface ProfileSchedule {
    profile: string;
    enabled: boolean;
    times: string[]; // "HH:MM", local wall clock
    weekdays: Weekday[]; // default [1, 2, 3, 4, 5]
    graceMinutes: number; // default 90
  }

  /**
   * Evidence that a run happened OR was attempted for a given
   * (profile, date, time) — sourced from either an on-disk run folder
   * (actual start time, via parseRunFolderName below) or a synthetic entry
   * the daemon derives from its pidfile attempts ledger (D19: an owed slot
   * the daemon attempted to spawn but which crashed before writing a run
   * folder). Both sources produce the identical shape below; a caller
   * cannot and need not distinguish them.
   */
  export interface RunRecord {
    profile: string;
    date: string; // "YYYY-MM-DD" local
    startedAt: string; // "HH:MM" local
  }

  export interface OwedRun {
    profile: string;
    date: string; // "YYYY-MM-DD" local
    slot: string; // "HH:MM" local
  }

  // Matches ops/observability/run_folder.ts's TIME_DIR_RE (`^\d{2}-\d{2}(-\d+)?$`)
  // exactly: always zero-padded HH-MM, optionally suffixed -N on a same-minute
  // collision. A folder that doesn't match (e.g. "sync_dryrun.json") is not a
  // run folder at all and yields undefined.
  const RUN_FOLDER_RE = /^(\d{2})-(\d{2})(?:-\d+)?$/;

  /**
   * Maps a run-folder directory name to "HH:MM", stripping any -N collision
   * suffix — two folders in the same minute (e.g. "14-04" and "14-04-2")
   * therefore yield the same result, which is harmless: served-detection
   * only asks whether ANY record falls in the owed window, not how many.
   * Returns undefined for anything that is not a run-folder name.
   */
  export function parseRunFolderName(name: string): string | undefined {
    const match = RUN_FOLDER_RE.exec(name);
    if (!match) return undefined;
    const hh = match[1] as string;
    const mm = match[2] as string;
    return `${hh}:${mm}`;
  }

  /** Local calendar date as YYYY-MM-DD — never UTC (see module doc comment). */
  export function formatLocalDate(d: Date): string {
    const yyyy = String(d.getFullYear()).padStart(4, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Local wall-clock time as HH:MM — never UTC (see module doc comment). */
  export function localHhMm(d: Date): string {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  /** "14:04" -> 844 (minutes since local midnight) — used to sort OwedRun[]
   * by slot ascending without re-parsing a Date each comparison. */
  export function hhMmToMinutes(hhMm: string): number {
    const parts = hhMm.split(':');
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    return hh * 60 + mm;
  }
  ```

- [ ] **Step 4: Run it and see it pass.**

  ```bash
  node --test src/core/schedule/types.test.ts
  ```

  Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 5: Create the module's public surface.**

  Create `/Users/harishamutha/Job-bunny/src/core/schedule/index.ts`:

  ```ts
  export * from './types.ts';
  ```

- [ ] **Step 6: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 7: Commit.**

  ```bash
  git add src/core/schedule/types.ts src/core/schedule/types.test.ts src/core/schedule/index.ts
  git commit -m "$(cat <<'EOF'
  feat(schedule): add core schedule types and run-folder name parsing

  ProfileSchedule/RunRecord/OwedRun plus parseRunFolderName (matches
  run_folder.ts's HH-MM[-N] naming exactly, stripping any collision
  suffix) and local-time formatting helpers — the pure vocabulary
  isRunOwed (next) is built from. Local wall-clock throughout, never
  UTC, per the run.log-vs-folder-name UTC mismatch this project has
  already hit once.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: `isRunOwed` and `nextFireAt` (the pure core)

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/core/schedule/owed.ts`
- Create: `/Users/harishamutha/Job-bunny/src/core/schedule/owed.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/core/schedule/index.ts`

**Interfaces:**

Consumes: `ProfileSchedule`, `RunRecord`, `OwedRun`, `Weekday`, `formatLocalDate`, `hhMmToMinutes` from `./types.ts`.

Produces:
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

Rules (each stated once, each covered by a test below):

1. Only slots for `now`'s local calendar date are evaluated — no midnight-straddling grace.
2. A profile is skipped entirely when `enabled` is `false`, or when `now`'s local weekday is not in `weekdays`.
3. A slot is owed when `now >= slot` AND `now <= slot + graceMinutes` AND it is not served.
4. A slot is served when ANY `RunRecord` for that profile and date has `startedAt` within `[slot, slot + graceMinutes]`.
5. `isRunOwed` MAY return multiple `OwedRun`s for the same profile (when `graceMinutes` exceeds the smallest inter-slot gap). Results are sorted ascending by `(slot, profileName)`.
6. `nextFireAt` returns only strictly future slots, never consults `history`, and exists only for `serve status`'s "next scheduled run" line — it MUST NOT drive scheduling (D4).
7. DST handled by construction: comparing local wall-clock `HH:MM` never crosses the DST boundary arithmetically — `now` is already whatever local time the runtime reports. A spring-forward-skipped slot never occurs locally that day; a fall-back-repeated slot could match twice, but served-detection (rule 4) prevents a second run either way.

- [ ] **Step 1: Write the 2026-07-27 worked-example tests (spec §5.2).**

  Create `/Users/harishamutha/Job-bunny/src/core/schedule/owed.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { isRunOwed, nextFireAt } from './owed.ts';
  import type { ProfileSchedule, RunRecord } from './types.ts';

  // 2026-07-27 is a Monday, matching the incident this design fixes.
  function schedule(overrides: Partial<ProfileSchedule> & { profile: string }): ProfileSchedule {
    return {
      enabled: true,
      times: ['09:00', '11:30', '14:00', '16:30', '19:00'],
      weekdays: [1, 2, 3, 4, 5],
      graceMinutes: 90,
      ...overrides,
    };
  }

  test('worked example: the 14:00 slot is owed at 14:04 with no run folder yet', () => {
    const now = new Date(2026, 6, 27, 14, 4);
    const owed = isRunOwed(now, [schedule({ profile: 'harish' })], []);
    assert.deepEqual(owed, [{ profile: 'harish', date: '2026-07-27', slot: '14:00' }]);
  });

  test('worked example: the 14:00 slot is no longer owed once a RunRecord falls in its window', () => {
    const now = new Date(2026, 6, 27, 14, 4);
    const history: RunRecord[] = [{ profile: 'harish', date: '2026-07-27', startedAt: '14:04' }];
    const owed = isRunOwed(now, [schedule({ profile: 'harish' })], history);
    assert.deepEqual(owed, []);
  });

  test('worked example: at 15:45 with no record, the 14:00 slot is NOT owed (grace expired at 15:30)', () => {
    const now = new Date(2026, 6, 27, 15, 45);
    const owed = isRunOwed(now, [schedule({ profile: 'harish' })], []);
    assert.deepEqual(owed, []);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `owed.ts` does not exist yet.**

  ```bash
  node --test src/core/schedule/owed.test.ts
  ```

  Expected failure: `Cannot find module '.../core/schedule/owed.ts'`.

- [ ] **Step 3: Implement `isRunOwed`.**

  Create `/Users/harishamutha/Job-bunny/src/core/schedule/owed.ts`:

  ```ts
  /**
   * core/schedule/owed.ts — the pure decision at the heart of the
   * scheduling daemon: given `now`, every profile's schedule, and the
   * history of what has already run today, which (profile, slot) pairs are
   * owed right now? Zero I/O — `now` is always a parameter, never read from
   * the wall clock internally, per CLAUDE.md's core-purity convention.
   */
  import { formatLocalDate, hhMmToMinutes } from './types.ts';
  import type { OwedRun, ProfileSchedule, RunRecord, Weekday } from './types.ts';

  /** Local wall-clock moment for `time` ("HH:MM") on `date` ("YYYY-MM-DD").
   * No UTC conversion anywhere in this file — see types.ts's module doc
   * comment for why that distinction matters here specifically. */
  function parseLocal(date: string, time: string): Date {
    const dateParts = date.split('-');
    const timeParts = time.split(':');
    const year = Number(dateParts[0]);
    const month = Number(dateParts[1]);
    const day = Number(dateParts[2]);
    const hour = Number(timeParts[0]);
    const minute = Number(timeParts[1]);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  /**
   * A slot (profile, date, time) is owed at `now` iff: the profile is
   * enabled; `now`'s local weekday is in schedule.weekdays; `now` is at or
   * after the slot and at or before slot+graceMinutes; and no RunRecord
   * (real run folder OR synthetic attempts-ledger entry — the daemon merges
   * both into `history` before calling this) falls in that same window.
   * Only `now`'s own local calendar date is ever evaluated — no
   * midnight-straddling grace (accepted scope limit, see spec §5.1).
   */
  export function isRunOwed(
    now: Date,
    schedules: readonly ProfileSchedule[],
    history: readonly RunRecord[],
  ): OwedRun[] {
    const date = formatLocalDate(now);
    const weekday = now.getDay() as Weekday;
    const owed: OwedRun[] = [];

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      if (!schedule.weekdays.includes(weekday)) continue;

      for (const slot of schedule.times) {
        const slotAt = parseLocal(date, slot);
        const graceEndAt = new Date(slotAt.getTime() + schedule.graceMinutes * 60_000);
        if (now < slotAt || now > graceEndAt) continue;

        const served = history.some((record) => {
          if (record.profile !== schedule.profile || record.date !== date) return false;
          const startedAt = parseLocal(date, record.startedAt);
          return startedAt >= slotAt && startedAt <= graceEndAt;
        });
        if (served) continue;

        owed.push({ profile: schedule.profile, date, slot });
      }
    }

    // Rule 5: sort ascending by (slot, profileName) — the daemon's own
    // sequential-execution loop (Task 7) relies on this ordering rather than
    // re-deriving it, but isRunOwed guarantees it here regardless.
    owed.sort((a, b) => {
      const slotCmp = hhMmToMinutes(a.slot) - hhMmToMinutes(b.slot);
      return slotCmp !== 0 ? slotCmp : a.profile.localeCompare(b.profile);
    });

    return owed;
  }

  /**
   * Pure informational helper for `serve status`'s "next scheduled run"
   * line only — it does NOT drive the daemon's timing (D4: no
   * timer-to-next-fire; the daemon always ticks every 30s and re-evaluates
   * isRunOwed against the real clock). Returns only STRICTLY FUTURE slots
   * and never consults `history`, so it cannot know whether an
   * already-passed, still-in-grace slot was served — `serve status` calls
   * isRunOwed directly for that.
   */
  export function nextFireAt(
    now: Date,
    schedules: readonly ProfileSchedule[],
  ): { at: Date; runs: OwedRun[] } | null {
    const date = formatLocalDate(now);
    const weekday = now.getDay() as Weekday;
    let best: { at: Date; runs: OwedRun[] } | undefined;

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      if (!schedule.weekdays.includes(weekday)) continue;

      for (const slot of schedule.times) {
        const slotAt = parseLocal(date, slot);
        if (slotAt <= now) continue; // strictly future only.

        if (!best || slotAt.getTime() < best.at.getTime()) {
          best = { at: slotAt, runs: [{ profile: schedule.profile, date, slot }] };
        } else if (slotAt.getTime() === best.at.getTime()) {
          best.runs.push({ profile: schedule.profile, date, slot });
        }
      }
    }

    if (!best) return null;
    best.runs.sort((a, b) => a.profile.localeCompare(b.profile));
    return best;
  }
  ```

- [ ] **Step 4: Run it and see the three worked-example tests pass.**

  ```bash
  node --test src/core/schedule/owed.test.ts
  ```

  Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Write the remaining `isRunOwed` rule tests.**

  Append to `owed.test.ts`:

  ```ts
  test('a disabled profile returns nothing, even inside its grace window', () => {
    const now = new Date(2026, 6, 27, 14, 4);
    const owed = isRunOwed(now, [schedule({ profile: 'harish', enabled: false })], []);
    assert.deepEqual(owed, []);
  });

  test('a Saturday returns nothing for a Mon-Fri schedule', () => {
    // 2026-08-01 is a Saturday.
    const now = new Date(2026, 7, 1, 14, 4);
    const owed = isRunOwed(now, [schedule({ profile: 'harish' })], []);
    assert.deepEqual(owed, []);
  });

  test('two profiles sharing a slot both return, sorted by (slot, profileName)', () => {
    const now = new Date(2026, 6, 27, 14, 4);
    const owed = isRunOwed(
      now,
      [schedule({ profile: 'rajni' }), schedule({ profile: 'harish' })],
      [],
    );
    assert.deepEqual(owed, [
      { profile: 'harish', date: '2026-07-27', slot: '14:00' },
      { profile: 'rajni', date: '2026-07-27', slot: '14:00' },
    ]);
  });

  test('a profile whose graceMinutes exceeds its own inter-slot gap can have two slots owed at once', () => {
    const now = new Date(2026, 6, 27, 11, 35);
    const owed = isRunOwed(
      now,
      [schedule({ profile: 'harish', times: ['09:00', '11:30'], graceMinutes: 200 })],
      [],
    );
    assert.deepEqual(owed, [
      { profile: 'harish', date: '2026-07-27', slot: '09:00' },
      { profile: 'harish', date: '2026-07-27', slot: '11:30' },
    ]);
  });
  ```

- [ ] **Step 6: Run it and see all seven `isRunOwed` tests pass.**

  ```bash
  node --test src/core/schedule/owed.test.ts
  ```

  Expected: `# pass 7`, `# fail 0` — no implementation change needed, `isRunOwed` already covers every rule above.

- [ ] **Step 7: Write the `nextFireAt` tests.**

  Append to `owed.test.ts`:

  ```ts
  test('nextFireAt returns the earliest strictly-future slot', () => {
    const now = new Date(2026, 6, 27, 10, 0);
    const result = nextFireAt(now, [schedule({ profile: 'harish' })]);
    assert.equal(result?.at.getTime(), new Date(2026, 6, 27, 11, 30).getTime());
    assert.deepEqual(result?.runs, [{ profile: 'harish', date: '2026-07-27', slot: '11:30' }]);
  });

  test('nextFireAt never returns a slot that has already arrived, even if still unserved', () => {
    const now = new Date(2026, 6, 27, 14, 4);
    const result = nextFireAt(now, [schedule({ profile: 'harish' })]);
    assert.equal(result?.runs[0]?.slot, '16:30'); // 14:00 already arrived — not "next".
  });

  test('nextFireAt returns null when no schedule has a future slot today', () => {
    const now = new Date(2026, 6, 27, 20, 0);
    const result = nextFireAt(now, [schedule({ profile: 'harish' })]);
    assert.equal(result, null);
  });

  test('nextFireAt groups multiple profiles sharing the identical next slot, sorted by profile', () => {
    const now = new Date(2026, 6, 27, 10, 0);
    const result = nextFireAt(now, [
      schedule({ profile: 'rajni' }),
      schedule({ profile: 'harish' }),
    ]);
    assert.deepEqual(result?.runs, [
      { profile: 'harish', date: '2026-07-27', slot: '11:30' },
      { profile: 'rajni', date: '2026-07-27', slot: '11:30' },
    ]);
  });
  ```

- [ ] **Step 8: Run it and see all eleven tests pass.**

  ```bash
  node --test src/core/schedule/owed.test.ts
  ```

  Expected: `# pass 11`, `# fail 0`.

- [ ] **Step 9: Update the module's public surface.**

  `/Users/harishamutha/Job-bunny/src/core/schedule/index.ts` already re-exports everything via `export * from './types.ts';`. Modify it to also re-export `owed.ts`:

  ```ts
  export * from './types.ts';
  export * from './owed.ts';
  ```

- [ ] **Step 10: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 11: Commit.**

  ```bash
  git add src/core/schedule/owed.ts src/core/schedule/owed.test.ts src/core/schedule/index.ts
  git commit -m "$(cat <<'EOF'
  feat(schedule): add isRunOwed/nextFireAt, the pure owed-slot decision

  isRunOwed(now, schedules, history) answers "which (profile, slot)
  pairs are owed right now" with zero I/O, replaying the 2026-07-27
  reboot-before-login incident as a regression fixture: owed at 14:04,
  served once a run folder lands in the grace window, permanently
  skipped once the grace window elapses unserved. nextFireAt is a
  strictly-informational forward scan for `serve status` only — it
  never drives scheduling (D4).

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: profile and run-history scanning

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/scan/scan.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/scan/scan.test.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/scan/index.ts`

**Placement rationale:** `src/ops/daemon/` will hold `daemon.ts` (Task 7) and `pidfile.ts` (Task 5) — exactly the two-implementation-file cap — so filesystem scanning goes into its own subfolder rather than a third top-level file. `ops/` may not import `adapters/` (and doesn't need to here — this reads JSON off disk through injected fs deps); `ops/` importing `core/` is unrestricted by `npm run boundaries`, so this module freely consumes `core/config` (Task 1's `PipelineConfigSchema`) and `core/schedule` (Task 2's `ProfileSchedule`/`RunRecord`/`parseRunFolderName`).

**Real repo fact confirmed by reading the code**: `PipelineConfigSchema` is exported from `src/core/config/index.ts` via `export * from './schema.ts';`, so `scanProfileSchedules` below imports it from `'../../../core/config/index.ts'` exactly as this task assumes.

**Interfaces:**

Consumes: `ProfileSchedule`, `RunRecord`, `parseRunFolderName` from `../../../core/schedule/index.ts`; `PipelineConfigSchema` from `../../../core/config/index.ts`.

Produces:
```ts
export interface ScanDeps {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string): string;
}

export function scanProfileSchedules(profilesDir: string, deps: ScanDeps): ProfileSchedule[];
export function scanRunHistory(
  profilesDir: string,
  profiles: readonly string[],
  date: string,
  deps: ScanDeps,
): RunRecord[];
export function defaultScanDeps(): ScanDeps;
```

Rules: `scanProfileSchedules` skips (never throws for) a profile whose `profile.json` is missing, unreadable, malformed JSON, or fails `PipelineConfigSchema` validation — fail-soft, one bad profile must not stop the daemon (spec §9.1). It also skips any profile with no `schedule` block or `schedule.enabled === false`. `scanRunHistory` maps each subdirectory of `profiles/<name>/data/runs/<date>/` through `parseRunFolderName`, dropping anything that returns `undefined`; a missing `runs/<date>/` directory yields `[]`, not a throw. All paths are built with `node:path` `join`, never string concatenation.

- [ ] **Step 1: Write the failing tests for `scanProfileSchedules`'s enabled/disabled split and malformed-JSON tolerance.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/scan/scan.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { join } from 'node:path';
  import { test } from 'node:test';
  import { defaultScanDeps, scanProfileSchedules, scanRunHistory } from './scan.ts';
  import type { ScanDeps } from './scan.ts';

  const PROFILES_DIR = '/fake/profiles';

  function fakeDeps(files: Record<string, string>, dirs: Record<string, string[]>): ScanDeps {
    return {
      existsSync: (p) => p in files || p in dirs,
      readdirSync: (p) => {
        const entries = dirs[p];
        if (!entries) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return entries;
      },
      readFileSync: (p) => {
        const content = files[p];
        if (content === undefined) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return content;
      },
    };
  }

  function profilePath(name: string): string {
    return join(PROFILES_DIR, name, 'profile.json');
  }

  test('scanProfileSchedules: returns only the enabled profile, skipping the disabled one', () => {
    const deps = fakeDeps(
      {
        [profilePath('harish')]: JSON.stringify({
          connector: 'notion',
          schedule: { times: ['09:00', '14:00'], enabled: true },
        }),
        [profilePath('rajni')]: JSON.stringify({
          connector: 'notion',
          schedule: { times: ['09:00'], enabled: false },
        }),
      },
      { [PROFILES_DIR]: ['harish', 'rajni'] },
    );

    const schedules = scanProfileSchedules(PROFILES_DIR, deps);
    assert.deepEqual(
      schedules.map((s) => s.profile),
      ['harish'],
    );
    assert.deepEqual(schedules[0]?.times, ['09:00', '14:00']);
    assert.equal(schedules[0]?.graceMinutes, 90);
  });

  test('scanProfileSchedules: a profile with invalid JSON is skipped, not thrown', () => {
    const deps = fakeDeps(
      { [profilePath('broken')]: 'not json{{{' },
      { [PROFILES_DIR]: ['broken'] },
    );
    assert.doesNotThrow(() => scanProfileSchedules(PROFILES_DIR, deps));
    assert.deepEqual(scanProfileSchedules(PROFILES_DIR, deps), []);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `scan.ts` does not exist yet.**

  ```bash
  node --test src/ops/daemon/scan/scan.test.ts
  ```

  Expected failure: `Cannot find module '.../ops/daemon/scan/scan.ts'`.

- [ ] **Step 3: Implement `scan.ts`.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/scan/scan.ts`:

  ```ts
  /**
   * ops/daemon/scan/scan.ts — filesystem -> ProfileSchedule[] / RunRecord[].
   * Injected fs deps (mirrors ops/scheduling/run_lock.ts's shape) so this is
   * fully unit-testable without a real filesystem. One bad profile.json
   * (missing, unreadable, malformed, or schema-invalid) is skipped, never
   * thrown — the daemon's schedule scan must survive a single broken
   * profile (spec §9.1's fail-soft row for the schedule scan).
   */
  import { existsSync, readdirSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { PipelineConfigSchema } from '../../../core/config/index.ts';
  import { parseRunFolderName } from '../../../core/schedule/index.ts';
  import type { ProfileSchedule, RunRecord } from '../../../core/schedule/index.ts';

  export interface ScanDeps {
    existsSync(path: string): boolean;
    readdirSync(path: string): string[];
    readFileSync(path: string): string;
  }

  /** Every enabled profile's schedule, read from `<profilesDir>/<name>/profile.json`.
   * Profiles are visited in sorted order for determinism. A profile is
   * skipped (not thrown for) when its profile.json is missing, unreadable,
   * malformed JSON, fails PipelineConfigSchema validation, has no `schedule`
   * block, or has `schedule.enabled === false`. */
  export function scanProfileSchedules(profilesDir: string, deps: ScanDeps): ProfileSchedule[] {
    let names: string[];
    try {
      names = deps.readdirSync(profilesDir);
    } catch {
      return [];
    }

    const schedules: ProfileSchedule[] = [];
    for (const name of [...names].sort()) {
      const profilePath = join(profilesDir, name, 'profile.json');
      if (!deps.existsSync(profilePath)) continue;

      let raw: string;
      try {
        raw = deps.readFileSync(profilePath);
      } catch {
        continue; // unreadable — fail-soft, skip this profile.
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        continue; // malformed JSON — fail-soft, skip this profile.
      }

      const result = PipelineConfigSchema.safeParse(parsedJson);
      if (!result.success) continue; // invalid config — fail-soft, skip this profile.

      const schedule = result.data.schedule;
      if (!schedule || !schedule.enabled) continue;

      schedules.push({
        profile: name,
        enabled: schedule.enabled,
        times: schedule.times,
        weekdays: schedule.weekdays as ProfileSchedule['weekdays'],
        graceMinutes: schedule.graceMinutes,
      });
    }
    return schedules;
  }

  /** RunRecord[] for the given profiles on `date`, built from
   * `<profilesDir>/<profile>/data/runs/<date>/`'s subdirectory names. A
   * missing runs/<date>/ directory yields no records for that profile — not
   * a throw. */
  export function scanRunHistory(
    profilesDir: string,
    profiles: readonly string[],
    date: string,
    deps: ScanDeps,
  ): RunRecord[] {
    const records: RunRecord[] = [];
    for (const profile of profiles) {
      const runsDir = join(profilesDir, profile, 'data', 'runs', date);
      if (!deps.existsSync(runsDir)) continue;

      let entries: string[];
      try {
        entries = deps.readdirSync(runsDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const startedAt = parseRunFolderName(entry);
        if (startedAt === undefined) continue;
        records.push({ profile, date, startedAt });
      }
    }
    return records;
  }

  /** Builds the real (non-test) ScanDeps. */
  export function defaultScanDeps(): ScanDeps {
    return {
      existsSync: (p) => existsSync(p),
      readdirSync: (p) => readdirSync(p),
      readFileSync: (p) => readFileSync(p, 'utf8'),
    };
  }
  ```

- [ ] **Step 4: Run it and see both tests pass.**

  ```bash
  node --test src/ops/daemon/scan/scan.test.ts
  ```

  Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 5: Write the remaining tests.**

  Append to `scan.test.ts`:

  ```ts
  test('scanProfileSchedules: a profile with no schedule block is skipped', () => {
    const deps = fakeDeps(
      { [profilePath('noschedule')]: JSON.stringify({ connector: 'notion' }) },
      { [PROFILES_DIR]: ['noschedule'] },
    );
    assert.deepEqual(scanProfileSchedules(PROFILES_DIR, deps), []);
  });

  test('scanRunHistory: parses run-folder names, including a collision-suffixed one', () => {
    const runsDir = join(PROFILES_DIR, 'harish', 'data', 'runs', '2026-07-27');
    const deps = fakeDeps({}, { [runsDir]: ['09-00', '14-04', '14-04-2', 'sync_dryrun.json'] });
    const history = scanRunHistory(PROFILES_DIR, ['harish'], '2026-07-27', deps);
    assert.deepEqual(
      history.map((r) => r.startedAt).sort(),
      ['09:00', '14:04', '14:04'],
    );
    assert.ok(history.every((r) => r.profile === 'harish' && r.date === '2026-07-27'));
  });

  test('scanRunHistory: a missing runs directory yields []', () => {
    const deps = fakeDeps({}, {});
    const history = scanRunHistory(PROFILES_DIR, ['harish'], '2026-07-27', deps);
    assert.deepEqual(history, []);
  });

  test('defaultScanDeps: builds a working real-fs deps object shape', () => {
    const deps = defaultScanDeps();
    assert.equal(typeof deps.existsSync, 'function');
    assert.equal(typeof deps.readdirSync, 'function');
    assert.equal(typeof deps.readFileSync, 'function');
  });
  ```

- [ ] **Step 6: Run it and see all six tests pass.**

  ```bash
  node --test src/ops/daemon/scan/scan.test.ts
  ```

  Expected: `# pass 6`, `# fail 0` — no implementation change needed.

- [ ] **Step 7: Create the module's public surface.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/scan/index.ts`:

  ```ts
  export * from './scan.ts';
  ```

- [ ] **Step 8: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 9: Commit.**

  ```bash
  git add src/ops/daemon/scan/scan.ts src/ops/daemon/scan/scan.test.ts src/ops/daemon/scan/index.ts
  git commit -m "$(cat <<'EOF'
  feat(daemon): scan profile schedules and run history from disk

  scanProfileSchedules reads every profiles/<name>/profile.json,
  validates it with PipelineConfigSchema, and skips (never throws for)
  a profile that's missing, unreadable, malformed, schema-invalid, or
  disabled — one bad profile must not stop the daemon's tick.
  scanRunHistory maps run-folder directory names to RunRecords via
  parseRunFolderName. Split into its own scan/ subfolder so
  ops/daemon/ stays under the two-implementation-file cap once
  daemon.ts and pidfile.ts land.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: daemon pidfile — heartbeat, ledger, synchronous atomic updates

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/pidfile.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/pidfile.test.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/index.ts`

**Interfaces:**

Consumes: nothing outside `node:fs`/`node:path`/`node:process` (injected via `DaemonPidfileDeps`).

Produces:
```ts
export interface DaemonAttempt {
  profile: string;
  date: string;  // "YYYY-MM-DD" local
  slot: string;  // "HH:MM" local
}

export interface DaemonInFlight {
  pid: number;         // pid of the child run currently executing
  profile: string;
  startedAt: string;   // ISO 8601
}

export interface DaemonPidfile {
  pid: number;
  startedAt: string;   // ISO 8601
  lastTickAt: string;  // ISO 8601
  inFlight?: DaemonInFlight;
  attempts: DaemonAttempt[];
}

export interface DaemonPidfileDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  writeFileSyncExclusive(path: string, data: string): boolean; // wx flag; false on EEXIST
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  pidIsAlive(pid: number): boolean;
  now(): Date;
}

export const HEARTBEAT_STALE_MS: number; // 5 * 60_000

export function daemonPidfilePath(root: string): string;
export function acquireDaemonPidfile(root: string, pid: number, deps: DaemonPidfileDeps): boolean;
export function readDaemonPidfile(root: string, deps: DaemonPidfileDeps): DaemonPidfile | undefined;
export function updateDaemonPidfile(
  root: string,
  mutate: (current: DaemonPidfile) => DaemonPidfile,
  deps: DaemonPidfileDeps,
): void;
export function releaseDaemonPidfile(root: string, deps: DaemonPidfileDeps): void;
export function isDaemonPidfileStale(file: DaemonPidfile | undefined, deps: DaemonPidfileDeps): boolean;
export function defaultDaemonPidfileDeps(): DaemonPidfileDeps;
```

Rules:

- File is `<root>/.jobbunny-daemon.pid`, sibling to the existing `.jobbunny-run.lock`.
- Initial acquisition uses `writeFileSyncExclusive` (`wx`) — that exclusive create IS the mutual-exclusion guarantee, identical mechanism to `run_lock.ts`'s `tryCreate`. Initial contents record the acquiring process's own pid as a placeholder (overwritten with the detached child's pid by the daemon-spawning CLI command, out of scope for this task), so a concurrent `serve start` reading it mid-acquisition sees a live pid and correctly refuses, and a crash before spawn leaves a dead pid that the staleness rule self-heals.
- ALL in-place updates (`inFlight` set/clear, `attempts` append, `lastTickAt` heartbeat) go through `updateDaemonPidfile`, which is SYNCHRONOUS temp+rename: `writeFileSync('<path>.tmp', ...)` then `renameSync('<path>.tmp', path)`. This is a deliberate divergence from `ops/observability/run_folder.ts`'s ASYNC `writeAtomic` — same shape, synchronous variant. Reason: on Node's single-threaded event loop, a synchronous write-then-rename runs to completion without yielding, so the heartbeat write (which Task 7 places OUTSIDE the reentrancy guard) can never interleave with the guarded body's own pidfile updates, and no two writers can ever collide on the temp path. An async pattern would not give that guarantee.
- Staleness: stale when the recorded pid is not alive, OR `lastTickAt` is older than `HEARTBEAT_STALE_MS` (5 minutes = 10 ticks at the 30s cadence). The 4-hour `DEFAULT_MAX_AGE_MS` rule from `run_lock.ts` is explicitly NOT reused here — it is correct for `run_lock` (a single bounded run) and wrong for a process designed to live for days; reusing it would judge any daemon older than four hours stale and start a second one.
- Reader rule: a reader that fails to parse the pidfile retries once before treating it as corrupt — same "unreadable ⇒ stale ⇒ safe to steal" posture `run_lock.ts` already documents for its own lock file. (Implementation note: since this module's read functions are synchronous by this task's own interface, the retry is an immediate second parse attempt rather than a real timed delay — a blocking `sleep` inside a synchronous daemon-critical-path function would be worse than the problem it solves; see this task's NOTES.)
- `defaultDaemonPidfileDeps` mirrors `defaultRunLockDeps`: `node:fs` sync functions, `process.kill(pid, 0)` for liveness wrapped so `ESRCH` returns `false` rather than throwing.

- [ ] **Step 1: Write the first two failing tests.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/pidfile.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import {
    acquireDaemonPidfile,
    daemonPidfilePath,
    type DaemonPidfile,
    type DaemonPidfileDeps,
    defaultDaemonPidfileDeps,
    HEARTBEAT_STALE_MS,
    isDaemonPidfileStale,
    readDaemonPidfile,
    releaseDaemonPidfile,
    updateDaemonPidfile,
  } from './pidfile.ts';

  const ROOT = '/fake/root';

  function fakeDeps(): DaemonPidfileDeps & {
    _files: Map<string, string>;
    _alivePids: Set<number>;
    _advance: (ms: number) => void;
  } {
    const files = new Map<string, string>();
    const alivePids = new Set<number>();
    let nowMs = Date.parse('2026-07-27T14:00:00.000Z');

    const notFound = (): never => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };

    return {
      _files: files,
      _alivePids: alivePids,
      _advance: (ms) => {
        nowMs += ms;
      },
      existsSync: (p) => files.has(p),
      readFileSync: (p) => files.get(p) ?? notFound(),
      writeFileSync: (p, data) => {
        files.set(p, data);
      },
      writeFileSyncExclusive: (p, data) => {
        if (files.has(p)) return false;
        files.set(p, data);
        return true;
      },
      renameSync: (from, to) => {
        const content = files.get(from) ?? notFound();
        files.delete(from);
        files.set(to, content);
      },
      unlinkSync: (p) => {
        if (!files.has(p)) notFound();
        files.delete(p);
      },
      pidIsAlive: (pid) => alivePids.has(pid),
      now: () => new Date(nowMs),
    };
  }

  test('daemonPidfilePath: sibling to .jobbunny-run.lock', () => {
    assert.equal(daemonPidfilePath('/fake/root'), '/fake/root/.jobbunny-daemon.pid');
  });

  test('acquireDaemonPidfile: succeeds on a clean directory', () => {
    const deps = fakeDeps();
    const acquired = acquireDaemonPidfile(ROOT, 1000, deps);
    assert.equal(acquired, true);
    const stored = readDaemonPidfile(ROOT, deps);
    assert.equal(stored?.pid, 1000);
    assert.deepEqual(stored?.attempts, []);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `pidfile.ts` does not exist yet.**

  ```bash
  node --test src/ops/daemon/pidfile.test.ts
  ```

  Expected failure: `Cannot find module '.../ops/daemon/pidfile.ts'`.

- [ ] **Step 3: Implement `pidfile.ts` in full.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/pidfile.ts`:

  ```ts
  /**
   * ops/daemon/pidfile.ts — the scheduling daemon's own supervision state:
   * a heartbeat (lastTickAt, D22) instead of an age check (unlike
   * ops/scheduling/run_lock.ts's 4-hour DEFAULT_MAX_AGE_MS — see
   * isDaemonPidfileStale below for why that rule is wrong here), an
   * attempts ledger (D19, closes the respawn-storm gap left by run folders
   * being created lazily), and an inFlight child pid so `serve stop` can
   * find and kill an in-progress run even if the daemon itself has died.
   *
   * File location: `<root>/.jobbunny-daemon.pid`, sibling to
   * `<root>/.jobbunny-run.lock` — same directory convention, a different
   * file, so the daemon's own long-lived supervision state never collides
   * with a single run's cross-process exclusive lock.
   */
  import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';

  export interface DaemonAttempt {
    profile: string;
    date: string; // "YYYY-MM-DD" local
    slot: string; // "HH:MM" local
  }

  export interface DaemonInFlight {
    pid: number; // pid of the child run currently executing
    profile: string;
    startedAt: string; // ISO 8601
  }

  export interface DaemonPidfile {
    pid: number;
    startedAt: string; // ISO 8601
    lastTickAt: string; // ISO 8601
    inFlight?: DaemonInFlight;
    attempts: DaemonAttempt[];
  }

  export interface DaemonPidfileDeps {
    existsSync(path: string): boolean;
    readFileSync(path: string): string;
    writeFileSync(path: string, data: string): void;
    writeFileSyncExclusive(path: string, data: string): boolean; // wx flag; false on EEXIST
    renameSync(from: string, to: string): void;
    unlinkSync(path: string): void;
    pidIsAlive(pid: number): boolean;
    now(): Date;
  }

  /** 5 minutes = 10 missed ticks at the 30s cadence (D22). Replaces
   * run_lock.ts's 4-hour age rule, which is correct for a single bounded
   * run and wrong for a process meant to live for days: from hour 4 onward
   * it would judge every healthy daemon stale and let a new `serve start`
   * steal a live daemon's pidfile. */
  export const HEARTBEAT_STALE_MS = 5 * 60_000;

  export function daemonPidfilePath(root: string): string {
    return join(root, '.jobbunny-daemon.pid');
  }

  function hasCode(err: unknown, code: string): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === code
    );
  }

  /** Creates the pidfile via an exclusive (`wx`) write — the actual
   * mutual-exclusion guarantee, identical mechanism to run_lock.ts's
   * tryCreate. Returns false (does not throw) if a pidfile already exists;
   * the caller is responsible for staleness-checking and stealing it. */
  export function acquireDaemonPidfile(
    root: string,
    pid: number,
    deps: DaemonPidfileDeps,
  ): boolean {
    const path = daemonPidfilePath(root);
    const initial: DaemonPidfile = {
      pid,
      startedAt: deps.now().toISOString(),
      lastTickAt: deps.now().toISOString(),
      attempts: [],
    };
    return deps.writeFileSyncExclusive(path, JSON.stringify(initial));
  }

  /** Shape-checks a parsed `inFlight` value: either absent, or the full
   * `DaemonInFlight` object (`pid`/`profile`/`startedAt`) — never the old
   * bare-number form. A partially-shaped object is treated the same as
   * absent (malformed ⇒ safe to drop, not safe to trust). */
  function parseInFlight(value: unknown): DaemonInFlight | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as Partial<DaemonInFlight>;
    if (
      typeof candidate.pid === 'number' &&
      typeof candidate.profile === 'string' &&
      typeof candidate.startedAt === 'string'
    ) {
      return { pid: candidate.pid, profile: candidate.profile, startedAt: candidate.startedAt };
    }
    return undefined;
  }

  function parsePidfile(raw: string): DaemonPidfile | undefined {
    try {
      const parsed = JSON.parse(raw) as Partial<DaemonPidfile>;
      if (
        typeof parsed.pid === 'number' &&
        typeof parsed.startedAt === 'string' &&
        typeof parsed.lastTickAt === 'string' &&
        Array.isArray(parsed.attempts)
      ) {
        return {
          pid: parsed.pid,
          startedAt: parsed.startedAt,
          lastTickAt: parsed.lastTickAt,
          inFlight: parseInFlight(parsed.inFlight),
          attempts: parsed.attempts as DaemonAttempt[],
        };
      }
      return undefined; // malformed shape — treated the same as unreadable.
    } catch {
      return undefined; // corrupt JSON — same treatment.
    }
  }

  /** Reads and parses the pidfile. A reader that fails to parse retries
   * once — the same "unreadable ⇒ stale ⇒ safe to steal" posture
   * run_lock.ts already documents for its own lock file — before treating
   * the file as corrupt and returning undefined. Returns undefined (never
   * throws) when the pidfile doesn't exist. */
  export function readDaemonPidfile(
    root: string,
    deps: DaemonPidfileDeps,
  ): DaemonPidfile | undefined {
    const path = daemonPidfilePath(root);
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: string;
      try {
        raw = deps.readFileSync(path);
      } catch (err) {
        if (hasCode(err, 'ENOENT')) return undefined;
        throw err;
      }
      const parsed = parsePidfile(raw);
      if (parsed) return parsed;
      // First attempt failed to parse — retry once before giving up.
    }
    return undefined;
  }

  /** Every in-place update (heartbeat, inFlight, attempts) goes through
   * here: SYNCHRONOUS write-to-temp then rename-over-target. Synchronous,
   * not run_folder.ts's async writeAtomic, so the heartbeat write Task 7
   * places outside the reentrancy guard can never interleave with this same
   * function's own guarded-body calls — Node's single-threaded event loop
   * runs a sync write-then-rename to completion without yielding. A no-op
   * if the pidfile is currently unreadable (nothing safe to mutate). */
  export function updateDaemonPidfile(
    root: string,
    mutate: (current: DaemonPidfile) => DaemonPidfile,
    deps: DaemonPidfileDeps,
  ): void {
    const current = readDaemonPidfile(root, deps);
    if (!current) return;
    const next = mutate(current);
    const path = daemonPidfilePath(root);
    const tmpPath = `${path}.tmp`;
    deps.writeFileSync(tmpPath, JSON.stringify(next));
    deps.renameSync(tmpPath, path);
  }

  /** Removes the pidfile. Tolerates an already-absent file (nothing to do). */
  export function releaseDaemonPidfile(root: string, deps: DaemonPidfileDeps): void {
    const path = daemonPidfilePath(root);
    try {
      deps.unlinkSync(path);
    } catch (err) {
      if (!hasCode(err, 'ENOENT')) throw err;
    }
  }

  /** Stale (safe to steal) when the recorded pid is dead, OR the heartbeat
   * (lastTickAt) is older than HEARTBEAT_STALE_MS — NOT run_lock.ts's
   * 4-hour DEFAULT_MAX_AGE_MS, which is the wrong rule for a long-lived
   * daemon (see HEARTBEAT_STALE_MS's doc comment above). An undefined
   * (missing or corrupt) pidfile is always stale. */
  export function isDaemonPidfileStale(
    file: DaemonPidfile | undefined,
    deps: DaemonPidfileDeps,
  ): boolean {
    if (!file) return true;
    if (!deps.pidIsAlive(file.pid)) return true;
    const age = deps.now().getTime() - Date.parse(file.lastTickAt);
    return Number.isFinite(age) && age > HEARTBEAT_STALE_MS;
  }

  /** Builds the real (non-test) DaemonPidfileDeps. Mirrors
   * run_lock.ts's defaultRunLockDeps exactly. */
  export function defaultDaemonPidfileDeps(): DaemonPidfileDeps {
    return {
      existsSync: (p) => existsSync(p),
      readFileSync: (p) => readFileSync(p, 'utf8'),
      writeFileSync: (p, data) => {
        writeFileSync(p, data, 'utf8');
      },
      writeFileSyncExclusive: (p, data) => {
        try {
          writeFileSync(p, data, { encoding: 'utf8', flag: 'wx' });
          return true;
        } catch (err) {
          if (hasCode(err, 'EEXIST')) return false;
          throw err;
        }
      },
      renameSync: (from, to) => renameSync(from, to),
      unlinkSync: (p) => unlinkSync(p),
      pidIsAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          // ESRCH: no such process — dead. EPERM: exists but owned by
          // someone else — still alive. Anything else: assume alive.
          return !hasCode(err, 'ESRCH');
        }
      },
      now: () => new Date(),
    };
  }
  ```

- [ ] **Step 4: Run it and see both tests pass.**

  ```bash
  node --test src/ops/daemon/pidfile.test.ts
  ```

  Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 5: Write the remaining tests.**

  Append to `pidfile.test.ts`:

  ```ts
  function advance(deps: DaemonPidfileDeps, ms: number): void {
    (deps as unknown as { _advance: (ms: number) => void })._advance(ms);
  }

  function markAlive(deps: DaemonPidfileDeps, pid: number): void {
    (deps as unknown as { _alivePids: Set<number> })._alivePids.add(pid);
  }

  function setRaw(deps: DaemonPidfileDeps, content: string): void {
    (deps as unknown as { _files: Map<string, string> })._files.set(
      daemonPidfilePath(ROOT),
      content,
    );
  }

  test('acquireDaemonPidfile: fails when the pidfile exists with a live pid', () => {
    const deps = fakeDeps();
    acquireDaemonPidfile(ROOT, 1000, deps);
    markAlive(deps, 1000);
    const acquired = acquireDaemonPidfile(ROOT, 2000, deps);
    assert.equal(acquired, false);
  });

  test('isDaemonPidfileStale: a dead pid is stale', () => {
    const deps = fakeDeps();
    acquireDaemonPidfile(ROOT, 1000, deps);
    // 1000 is never marked alive — simulates a crashed daemon.
    const file = readDaemonPidfile(ROOT, deps);
    assert.equal(isDaemonPidfileStale(file, deps), true);
  });

  test('isDaemonPidfileStale: a fresh lastTickAt on a live pid is NOT stale', () => {
    const deps = fakeDeps();
    acquireDaemonPidfile(ROOT, 1000, deps);
    markAlive(deps, 1000);
    const file = readDaemonPidfile(ROOT, deps);
    assert.equal(isDaemonPidfileStale(file, deps), false);
  });

  test('isDaemonPidfileStale: a lastTickAt six minutes old on a live pid IS stale', () => {
    const deps = fakeDeps();
    acquireDaemonPidfile(ROOT, 1000, deps);
    markAlive(deps, 1000);
    advance(deps, 6 * 60_000);
    const file = readDaemonPidfile(ROOT, deps);
    assert.equal(isDaemonPidfileStale(file, deps), true);
  });

  test('isDaemonPidfileStale: exactly at HEARTBEAT_STALE_MS is NOT yet stale', () => {
    const deps = fakeDeps();
    acquireDaemonPidfile(ROOT, 1000, deps);
    markAlive(deps, 1000);
    advance(deps, HEARTBEAT_STALE_MS);
    const file = readDaemonPidfile(ROOT, deps);
    assert.equal(isDaemonPidfileStale(file, deps), false);
  });

  test('updateDaemonPidfile: writes to a .tmp path then renames it over the real path, in order', () => {
    const deps = fakeDeps();
    acquireDaemonPidfile(ROOT, 1000, deps);
    const path = daemonPidfilePath(ROOT);
    const calls: string[] = [];
    const tracked: DaemonPidfileDeps = {
      ...deps,
      writeFileSync: (p, data) => {
        calls.push(`write:${p}`);
        deps.writeFileSync(p, data);
      },
      renameSync: (from, to) => {
        calls.push(`rename:${from}->${to}`);
        deps.renameSync(from, to);
      },
    };
    const inFlight = { pid: 4242, profile: 'harish', startedAt: '2026-07-27T14:00:00.000Z' };
    updateDaemonPidfile(ROOT, (current) => ({ ...current, inFlight }), tracked);
    assert.deepEqual(calls, [`write:${path}.tmp`, `rename:${path}.tmp->${path}`]);
    assert.deepEqual(readDaemonPidfile(ROOT, deps)?.inFlight, inFlight);
  });

  test('updateDaemonPidfile: appends an attempts-ledger entry', () => {
    const deps = fakeDeps();
    acquireDaemonPidfile(ROOT, 1000, deps);
    updateDaemonPidfile(
      ROOT,
      (current) => ({
        ...current,
        attempts: [...current.attempts, { profile: 'harish', date: '2026-07-27', slot: '14:00' }],
      }),
      deps,
    );
    assert.deepEqual(readDaemonPidfile(ROOT, deps)?.attempts, [
      { profile: 'harish', date: '2026-07-27', slot: '14:00' },
    ]);
  });

  test('readDaemonPidfile: unparseable content is treated as stale (undefined)', () => {
    const deps = fakeDeps();
    setRaw(deps, 'not json{{{');
    const file = readDaemonPidfile(ROOT, deps);
    assert.equal(file, undefined);
    assert.equal(isDaemonPidfileStale(file, deps), true);
  });

  test('releaseDaemonPidfile: removes the pidfile', () => {
    const deps = fakeDeps();
    acquireDaemonPidfile(ROOT, 1000, deps);
    releaseDaemonPidfile(ROOT, deps);
    assert.equal(readDaemonPidfile(ROOT, deps), undefined);
  });

  test('releaseDaemonPidfile: is a no-op when the pidfile is already absent', () => {
    const deps = fakeDeps();
    assert.doesNotThrow(() => releaseDaemonPidfile(ROOT, deps));
  });

  test('defaultDaemonPidfileDeps: builds a working real-fs deps object shape', () => {
    const deps = defaultDaemonPidfileDeps();
    assert.equal(typeof deps.now, 'function');
    assert.equal(typeof deps.pidIsAlive, 'function');
    assert.equal(deps.pidIsAlive(process.pid), true); // our own process is definitely alive.
  });
  ```

- [ ] **Step 6: Run it and see all thirteen tests pass.**

  ```bash
  node --test src/ops/daemon/pidfile.test.ts
  ```

  Expected: `# pass 13`, `# fail 0` — no implementation change needed.

- [ ] **Step 7: Create the `ops/daemon/` module's public surface.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/index.ts`:

  ```ts
  export * from './pidfile.ts';
  ```

- [ ] **Step 8: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 9: Commit.**

  ```bash
  git add src/ops/daemon/pidfile.ts src/ops/daemon/pidfile.test.ts src/ops/daemon/index.ts
  git commit -m "$(cat <<'EOF'
  feat(daemon): add the daemon pidfile (heartbeat, ledger, atomic updates)

  DaemonPidfile carries a heartbeat (lastTickAt, D22) instead of
  run_lock.ts's 4-hour age check — the right staleness rule for a
  process meant to live for days, not a single bounded run — plus an
  attempts ledger (D19) so a slot that crashes before its first
  checkpoint doesn't respawn every tick for the rest of its grace
  window. All in-place updates use a synchronous write-temp-then-
  rename, not run_folder.ts's async pattern, so the heartbeat write
  (kept outside the tick's reentrancy guard by design) can never
  interleave with a guarded update.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: log directory, rotation, append fds

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/logs/logs.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/logs/logs.test.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/logs/index.ts`

**Placement rationale:** same two-implementation-file cap reasoning as Task 4's `scan/` — `ops/daemon/` already holds `daemon.ts` (Task 7) and `pidfile.ts` (Task 5), so log-file management gets its own subfolder.

**Interfaces:**

Consumes: nothing outside `node:fs`/`node:path`/`node:os` (injected via `LogDeps`).

Produces:
```ts
export interface LogDeps {
  existsSync(path: string): boolean;
  mkdirSync(path: string): void;
  statSync(path: string): { size: number };
  renameSync(from: string, to: string): void;
  openSync(path: string, flags: string): number;
  closeSync(fd: number): void;
}

export const LOG_ROTATE_BYTES: number; // 10 * 1024 * 1024

export function jobbunnyLogDir(home: string): string;   // <home>/.jobbunny/logs
export function daemonLogPath(home: string): string;    // <dir>/daemon.log
export function runsLogPath(home: string): string;      // <dir>/runs.log
export function rotateIfLarge(path: string, deps: LogDeps): void;
export function openAppendFd(path: string, deps: LogDeps): number;
export function defaultLogDeps(): LogDeps;
```

Rules: `~/.jobbunny/logs/` replaces the macOS-only `~/Library/Logs/JobBunny/` — built with `node:path` `join` and `node:os` `homedir` (the caller passes `homedir()`'s result in as `home`, keeping this module free of a hidden `os` dependency inside the function bodies below it). `rotateIfLarge` renames to `<path>.1`, replacing any existing `.1` — one generation, no dependency chain; a no-op when the file is missing or under `LOG_ROTATE_BYTES`. `openAppendFd` creates the directory if needed and opens with flag `'a'`.

Asymmetry (relied on by Task 7 and the eventual `serve start` CLI command, out of scope here): `runs.log` is rotated before each child spawn — the safe quiet point, since D6 mandates sequential execution and no child is writing at that instant — whereas `daemon.log` is rotated only at daemon start, because its fd is fixed at the detached spawn and can't be re-handed to a running process, and renaming an open-handle file fails on Windows. This stays acceptable because the daemon writes to `daemon.log` on events only (start, spawn, child exit, skipped expired slot, error, stop), never once per tick.

- [ ] **Step 1: Write the failing tests for path composition and the under-threshold no-op.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/logs/logs.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import {
    daemonLogPath,
    defaultLogDeps,
    jobbunnyLogDir,
    LOG_ROTATE_BYTES,
    type LogDeps,
    openAppendFd,
    rotateIfLarge,
    runsLogPath,
  } from './logs.ts';

  function fakeDeps(sizes: Record<string, number> = {}): LogDeps & { _calls: string[] } {
    const calls: string[] = [];
    const existing = new Set(Object.keys(sizes));
    const dirs = new Set<string>();
    return {
      _calls: calls,
      existsSync: (p) => existing.has(p) || dirs.has(p),
      mkdirSync: (p) => {
        calls.push(`mkdir:${p}`);
        dirs.add(p);
      },
      statSync: (p) => ({ size: sizes[p] ?? 0 }),
      renameSync: (from, to) => {
        calls.push(`rename:${from}->${to}`);
        existing.delete(from);
        existing.add(to);
      },
      openSync: (p, flags) => {
        calls.push(`open:${p}:${flags}`);
        return 99;
      },
      closeSync: (fd) => {
        calls.push(`close:${fd}`);
      },
    };
  }

  test('jobbunnyLogDir composes <home>/.jobbunny/logs', () => {
    assert.equal(jobbunnyLogDir('/Users/rajni'), '/Users/rajni/.jobbunny/logs');
  });

  test('daemonLogPath and runsLogPath compose under jobbunnyLogDir', () => {
    assert.equal(daemonLogPath('/Users/rajni'), '/Users/rajni/.jobbunny/logs/daemon.log');
    assert.equal(runsLogPath('/Users/rajni'), '/Users/rajni/.jobbunny/logs/runs.log');
  });

  test('rotateIfLarge is a no-op when the file is under the threshold', () => {
    const deps = fakeDeps({ '/fake/runs.log': LOG_ROTATE_BYTES - 1 });
    rotateIfLarge('/fake/runs.log', deps);
    assert.deepEqual(deps._calls, []);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `logs.ts` does not exist yet.**

  ```bash
  node --test src/ops/daemon/logs/logs.test.ts
  ```

  Expected failure: `Cannot find module '.../ops/daemon/logs/logs.ts'`.

- [ ] **Step 3: Implement `logs.ts`.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/logs/logs.ts`:

  ```ts
  /**
   * ops/daemon/logs/logs.ts — ~/.jobbunny/logs/ (D16), replacing the
   * macOS-only ~/Library/Logs/JobBunny/. Rotation is deliberately
   * asymmetric between the two log files this daemon writes — see the
   * module-level rule in the plan/spec this implements (D21, §6.9): the
   * caller (the daemon's own spawn path, out of scope for this task) checks
   * runs.log's size before every child spawn (D6's sequential-execution
   * guarantee makes that the one safe quiet point), while daemon.log is
   * checked only once, at daemon start, because its fd is fixed at the
   * detached spawn and renaming an open-handle file fails on Windows.
   */
  import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
  import { dirname, join } from 'node:path';

  export interface LogDeps {
    existsSync(path: string): boolean;
    mkdirSync(path: string): void;
    statSync(path: string): { size: number };
    renameSync(from: string, to: string): void;
    openSync(path: string, flags: string): number;
    closeSync(fd: number): void;
  }

  export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

  export function jobbunnyLogDir(home: string): string {
    return join(home, '.jobbunny', 'logs');
  }

  export function daemonLogPath(home: string): string {
    return join(jobbunnyLogDir(home), 'daemon.log');
  }

  export function runsLogPath(home: string): string {
    return join(jobbunnyLogDir(home), 'runs.log');
  }

  /** Renames `path` to `<path>.1` (replacing any existing `.1`) if it's over
   * LOG_ROTATE_BYTES. A no-op when the file is missing or under threshold —
   * never opens a fresh replacement itself, since the caller reopens via
   * openAppendFd immediately after, at its own safe quiet point. */
  export function rotateIfLarge(path: string, deps: LogDeps): void {
    if (!deps.existsSync(path)) return;
    const { size } = deps.statSync(path);
    if (size <= LOG_ROTATE_BYTES) return;
    deps.renameSync(path, `${path}.1`);
  }

  /** Creates the log directory if it doesn't exist yet, then opens `path`
   * for append (flag 'a'), returning the fd. */
  export function openAppendFd(path: string, deps: LogDeps): number {
    const dir = dirname(path);
    if (!deps.existsSync(dir)) {
      deps.mkdirSync(dir);
    }
    return deps.openSync(path, 'a');
  }

  /** Builds the real (non-test) LogDeps. mkdirSync uses {recursive: true}
   * so ~/.jobbunny/logs/ is created in one call even when ~/.jobbunny/
   * doesn't exist yet — the injected signature itself stays a plain
   * single-path function; recursion is this implementation's own detail. */
  export function defaultLogDeps(): LogDeps {
    return {
      existsSync: (p) => existsSync(p),
      mkdirSync: (p) => {
        mkdirSync(p, { recursive: true });
      },
      statSync: (p) => statSync(p),
      renameSync: (from, to) => renameSync(from, to),
      openSync: (p, flags) => openSync(p, flags),
      closeSync: (fd) => closeSync(fd),
    };
  }
  ```

- [ ] **Step 4: Run it and see all three tests pass.**

  ```bash
  node --test src/ops/daemon/logs/logs.test.ts
  ```

  Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Write the remaining tests.**

  Append to `logs.test.ts`:

  ```ts
  test('rotateIfLarge renames to <path>.1 when the file is over the threshold', () => {
    const deps = fakeDeps({ '/fake/runs.log': LOG_ROTATE_BYTES + 1 });
    rotateIfLarge('/fake/runs.log', deps);
    assert.deepEqual(deps._calls, ['rename:/fake/runs.log->/fake/runs.log.1']);
  });

  test('rotateIfLarge is a no-op when the file is missing', () => {
    const deps = fakeDeps();
    rotateIfLarge('/fake/runs.log', deps);
    assert.deepEqual(deps._calls, []);
  });

  test('openAppendFd creates the log directory when absent, then opens with flag "a"', () => {
    const deps = fakeDeps();
    const fd = openAppendFd('/fake/.jobbunny/logs/daemon.log', deps);
    assert.equal(fd, 99);
    assert.deepEqual(deps._calls, [
      'mkdir:/fake/.jobbunny/logs',
      'open:/fake/.jobbunny/logs/daemon.log:a',
    ]);
  });

  test('defaultLogDeps: builds a working real-fs deps object shape', () => {
    const deps = defaultLogDeps();
    assert.equal(typeof deps.existsSync, 'function');
    assert.equal(typeof deps.openSync, 'function');
    assert.equal(typeof deps.closeSync, 'function');
  });
  ```

- [ ] **Step 6: Run it and see all seven tests pass.**

  ```bash
  node --test src/ops/daemon/logs/logs.test.ts
  ```

  Expected: `# pass 7`, `# fail 0` — no implementation change needed.

- [ ] **Step 7: Create the module's public surface.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/logs/index.ts`:

  ```ts
  export * from './logs.ts';
  ```

- [ ] **Step 8: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 9: Commit.**

  ```bash
  git add src/ops/daemon/logs/logs.ts src/ops/daemon/logs/logs.test.ts src/ops/daemon/logs/index.ts
  git commit -m "$(cat <<'EOF'
  feat(daemon): add ~/.jobbunny/logs/ path composition and rotation

  jobbunnyLogDir/daemonLogPath/runsLogPath (D16) replace the
  macOS-only ~/Library/Logs/JobBunny/ with a plain cross-platform
  home-directory path. rotateIfLarge/openAppendFd give the daemon's
  eventual spawn path (D21) the primitives it needs: a >10MB rename-
  to-.1 rotation and an append-mode fd, both through injectable deps
  so no test touches a real file.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 7: the tick loop

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/daemon.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/daemon.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/ops/daemon/index.ts`

This task implements the DECISION half of the loop. The real child spawn is injected here (`SpawnRun`) and its real `node:child_process` implementation is wired by a later CLI task, out of scope for this plan — so this task is fully testable with a fake spawner.

**Interfaces:**

Consumes: `isRunOwed`, `formatLocalDate`, `hhMmToMinutes` and the `OwedRun`/`ProfileSchedule`/`RunRecord` types from `../../core/schedule/index.ts`; `scanProfileSchedules`/`scanRunHistory`/`ScanDeps` from `./scan/index.ts`; `readDaemonPidfile`/`updateDaemonPidfile`/`DaemonPidfileDeps` from `./pidfile.ts`.

Produces:
```ts
export const TICK_MS: number; // 30_000

export type SpawnRun = (owed: OwedRun) => Promise<number>; // resolves to the child's exit code

export interface DaemonDeps {
  root: string;
  profilesDir: string;
  scan: ScanDeps;
  pidfile: DaemonPidfileDeps;
  spawnRun: SpawnRun;
  log(event: string, data?: Record<string, unknown>): void;
  now(): Date;
}

export function createDaemon(deps: DaemonDeps): {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
};
```

MANDATORY ORDERING RULES — each stated once, each covered by a test:

1. The `lastTickAt` heartbeat write is the FIRST statement of the tick callback, BEFORE the reentrancy guard. It runs on EVERY timer firing, including firings the guard short-circuits while a child run is in flight. Consequence: without this ordering the heartbeat would freeze for the whole of a multi-hour child run, and a concurrent `serve start` (out of scope here) would judge a live, busy daemon stale and start a second one.
2. The heartbeat write is wrapped so a failure (ENOSPC, EACCES) is logged and swallowed, never thrown out of the timer callback — an uncaught throw there would kill the daemon, a domain-1 blast radius for a domain-2 problem. Accepted consequence: repeated write failures leave `lastTickAt` frozen, so the daemon is eventually judged stale and stolen from, which is correct for a daemon that cannot persist its own state.
3. Only after the heartbeat does the in-memory reentrancy guard run: `if (ticking) return; ticking = true; try { ... } finally { ticking = false; }`. `setInterval` does not skip a firing merely because the previous callback's promise is still pending.
4. History passed to `isRunOwed` is the MERGE of two sources: `RunRecord`s scanned from disk (Task 4) AND one synthetic `RunRecord{profile, date, startedAt: slot}` per today's entry in the pidfile `attempts` ledger. This is what prevents a respawn storm: run folders are created lazily (first checkpoint write, after stage 1), so a run that aborts in `wire()`, on a held run lock, or on a red doctor preflight leaves no folder at all — without the ledger such a slot would stay owed and respawn every 30 seconds for the full grace window.
5. Attempts are filtered to today's local date when folded, which is also what "cleared on date rollover" means — there is no separate clearing job. The ledger append itself enforces the same rule on write, not just on read: every write PRUNES the in-memory `attempts` array to only today's entries before appending the new one (spec A9 — the pidfile is rewritten with only-today entries whenever it is written), so the ledger never grows unbounded across days.
6. Per owed entry, in this exact order: REVALIDATE `now <= slot + graceMinutes` → append to the attempts ledger → spawn. A revalidation failure SKIPS the entry, logs the skip, and does NOT append to the ledger (it was never attempted, and `isRunOwed` will not return it again because its own grace has expired). Reason: a sequential child can run for hours, so a later batch entry's grace window may be long expired by the time its turn comes. The revalidation slot moment is built from the OWED ENTRY's OWN `date` + `slot` (not from `now`'s own calendar date) — a batch that runs past local midnight must still evaluate each entry against the date it was actually scheduled for, not the date the revalidation happens to occur on.
7. Entries are processed SEQUENTIALLY, awaiting each child before starting the next, in ascending `(slot, profileName)` order. Reason: exactly one Chrome/CDP session exists (one port, one user-data-dir), so two concurrent runs would fight over it. This ordering is the daemon's own explicit sort — it no longer inherits ordering from `collectScheduledJobs`'s sorted-profile-name convention in `cli/commands/schedule.ts`, which a later CLI task deletes.

- [ ] **Step 1: Write the first failing test.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/daemon.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { join } from 'node:path';
  import { test } from 'node:test';
  import type { ProfileSchedule } from '../../core/schedule/index.ts';
  import { createDaemon } from './daemon.ts';
  import type { DaemonDeps, SpawnRun } from './daemon.ts';
  import { acquireDaemonPidfile, readDaemonPidfile } from './pidfile.ts';
  import type { DaemonPidfileDeps } from './pidfile.ts';
  import type { ScanDeps } from './scan/index.ts';

  const ROOT = '/fake/root';
  const PROFILES_DIR = '/fake/profiles';

  function profilePath(name: string): string {
    return join(PROFILES_DIR, name, 'profile.json');
  }

  function runsDirPath(name: string, date: string): string {
    return join(PROFILES_DIR, name, 'data', 'runs', date);
  }

  function profileJson(schedule: Partial<ProfileSchedule> & { times: string[] }): string {
    return JSON.stringify({
      connector: 'notion',
      schedule: {
        times: schedule.times,
        enabled: schedule.enabled ?? true,
        weekdays: schedule.weekdays ?? [1, 2, 3, 4, 5],
        graceMinutes: schedule.graceMinutes ?? 90,
      },
    });
  }

  function fakeScanDeps(files: Record<string, string>, dirs: Record<string, string[]>): ScanDeps {
    return {
      existsSync: (p) => p in files || p in dirs,
      readdirSync: (p) => {
        const entries = dirs[p];
        if (!entries) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return entries;
      },
      readFileSync: (p) => {
        const content = files[p];
        if (content === undefined) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return content;
      },
    };
  }

  function fakePidfileDeps(): DaemonPidfileDeps {
    const files = new Map<string, string>();
    const notFound = (): never => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    return {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => files.get(p) ?? notFound(),
      writeFileSync: (p, data) => {
        files.set(p, data);
      },
      writeFileSyncExclusive: (p, data) => {
        if (files.has(p)) return false;
        files.set(p, data);
        return true;
      },
      renameSync: (from, to) => {
        const content = files.get(from) ?? notFound();
        files.delete(from);
        files.set(to, content);
      },
      unlinkSync: (p) => {
        files.delete(p);
      },
      pidIsAlive: () => true,
      now: () => new Date(),
    };
  }

  function readLastTickAt(deps: DaemonDeps): string | undefined {
    return readDaemonPidfile(deps.root, deps.pidfile)?.lastTickAt;
  }

  function baseDeps(overrides: Partial<DaemonDeps> = {}): {
    deps: DaemonDeps;
    events: Array<{ event: string; data?: Record<string, unknown> }>;
  } {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const pidfile = fakePidfileDeps();
    acquireDaemonPidfile(ROOT, 5000, pidfile);

    const deps: DaemonDeps = {
      root: ROOT,
      profilesDir: PROFILES_DIR,
      scan: fakeScanDeps({}, {}),
      pidfile,
      spawnRun: (async () => 0) as SpawnRun,
      log: (event, data) => {
        events.push({ event, data });
      },
      now: () => new Date(2026, 6, 27, 14, 4), // 2026-07-27 is a Monday.
      ...overrides,
    };
    return { deps, events };
  }

  test('a due slot spawns exactly once', async () => {
    const spawnCalls: string[] = [];
    const spawnRun: SpawnRun = async (owed) => {
      spawnCalls.push(owed.profile);
      return 0;
    };
    const scan = fakeScanDeps(
      { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
      { [PROFILES_DIR]: ['harish'] },
    );
    const { deps } = baseDeps({ scan, spawnRun });
    await createDaemon(deps).tick();
    assert.deepEqual(spawnCalls, ['harish']);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `daemon.ts` does not exist yet.**

  ```bash
  node --test src/ops/daemon/daemon.test.ts
  ```

  Expected failure: `Cannot find module '.../ops/daemon/daemon.ts'`.

- [ ] **Step 3: Implement `daemon.ts` in full.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/daemon.ts`:

  ```ts
  /**
   * ops/daemon/daemon.ts — the tick loop. Ticks every TICK_MS (D4: a fixed
   * constant, not user config — setTimeout/setInterval use a monotonic
   * clock that doesn't advance across suspend, so a fixed short interval
   * makes normal fires, downtime catch-up, and post-sleep recovery the same
   * code path), scans profile schedules and run history off disk, merges in
   * the pidfile's attempts ledger, asks the pure isRunOwed which slots are
   * owed, and spawns each owed slot's child sequentially — one Chrome/CDP
   * session exists, so two children can never run concurrently (D6).
   *
   * This module knows the clock, the run-folder ledger, and how to spawn
   * and await a child. It does NOT know about pipeline stages, adapters, or
   * the CLI — the real child spawn is injected as `SpawnRun`.
   */
  import { formatLocalDate, hhMmToMinutes, isRunOwed } from '../../core/schedule/index.ts';
  import type { OwedRun, ProfileSchedule, RunRecord } from '../../core/schedule/index.ts';
  import { readDaemonPidfile, updateDaemonPidfile } from './pidfile.ts';
  import type { DaemonPidfileDeps } from './pidfile.ts';
  import { scanProfileSchedules, scanRunHistory } from './scan/index.ts';
  import type { ScanDeps } from './scan/index.ts';

  export const TICK_MS = 30_000;

  /** Spawns `jobbunny run --profile <owed.profile> --headless` (the real
   * implementation, wired outside this module) and resolves to the child's
   * exit code once it exits. */
  export type SpawnRun = (owed: OwedRun) => Promise<number>;

  export interface DaemonDeps {
    root: string;
    profilesDir: string;
    scan: ScanDeps;
    pidfile: DaemonPidfileDeps;
    spawnRun: SpawnRun;
    log(event: string, data?: Record<string, unknown>): void;
    now(): Date;
  }

  /** Local wall-clock moment for `slot` ("HH:MM") ON `date` ("YYYY-MM-DD")
   * — built from the OWED ENTRY's OWN date, never from `now`'s own
   * calendar date (mirrors owed.ts's own `parseLocal`). A batch that runs
   * past local midnight must still evaluate each entry against the date it
   * was actually scheduled for. */
  function parseSlotMoment(date: string, slot: string): Date {
    const dateParts = date.split('-');
    const timeParts = slot.split(':');
    const year = Number(dateParts[0]);
    const month = Number(dateParts[1]);
    const day = Number(dateParts[2]);
    const hour = Number(timeParts[0]);
    const minute = Number(timeParts[1]);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  export function createDaemon(deps: DaemonDeps): {
    tick(): Promise<void>;
    start(): void;
    stop(): void;
  } {
    let ticking = false;
    let timer: NodeJS.Timeout | undefined;

    async function runOwedBatch(): Promise<void> {
      const now = deps.now();
      const date = formatLocalDate(now);

      const schedules: ProfileSchedule[] = scanProfileSchedules(deps.profilesDir, deps.scan);
      const profileNames = schedules.map((s) => s.profile);

      const diskHistory = scanRunHistory(deps.profilesDir, profileNames, date, deps.scan);
      const pidfile = readDaemonPidfile(deps.root, deps.pidfile);
      // D19: fold today's ledger entries in as synthetic RunRecords — this
      // is what stops a slot that crashed before its first checkpoint (no
      // run folder ever written) from respawning every tick for the rest
      // of its grace window.
      const ledgerHistory: RunRecord[] = (pidfile?.attempts ?? [])
        .filter((a) => a.date === date)
        .map((a) => ({ profile: a.profile, date: a.date, startedAt: a.slot }));

      const history = [...diskHistory, ...ledgerHistory];
      const owedRuns = isRunOwed(now, schedules, history);

      // A13: sort explicitly by (slot, profileName) — nothing upstream
      // supplies this ordering once cli/commands/schedule.ts is gone.
      const sorted = [...owedRuns].sort((a, b) => {
        const slotCmp = hhMmToMinutes(a.slot) - hhMmToMinutes(b.slot);
        return slotCmp !== 0 ? slotCmp : a.profile.localeCompare(b.profile);
      });

      for (const owed of sorted) {
        const schedule = schedules.find((s) => s.profile === owed.profile);
        const graceMinutes = schedule?.graceMinutes ?? 0;

        // Revalidate (A3): re-check the grace window immediately before
        // acting on this entry — a slow sequential predecessor earlier in
        // this same batch may have consumed this entry's own grace window
        // while it waited its turn.
        const revalidateAt = deps.now();
        const slotMoment = parseSlotMoment(owed.date, owed.slot);
        const graceEndMoment = new Date(slotMoment.getTime() + graceMinutes * 60_000);
        if (revalidateAt > graceEndMoment) {
          deps.log('slot-expired-skipped', { profile: owed.profile, slot: owed.slot });
          continue;
        }

        // Ledger BEFORE spawning — a crash between this write and the
        // spawn call still counts the slot as attempted (D19). A9: prune to
        // only today's entries on every write, not just on read (rule 5) —
        // the pidfile itself never accumulates yesterday's attempts.
        updateDaemonPidfile(
          deps.root,
          (current) => ({
            ...current,
            attempts: [
              ...current.attempts.filter((a) => a.date === owed.date),
              { profile: owed.profile, date: owed.date, slot: owed.slot },
            ],
          }),
          deps.pidfile,
        );

        deps.log('spawn', { profile: owed.profile, slot: owed.slot });
        const exitCode = await deps.spawnRun(owed);
        deps.log('child-exit', { profile: owed.profile, slot: owed.slot, exitCode });
      }
    }

    async function tick(): Promise<void> {
      // A15.1: heartbeat write is the FIRST statement, BEFORE the
      // reentrancy guard, so it runs on every 30s firing — including
      // firings the guard below short-circuits while a child is in flight.
      try {
        updateDaemonPidfile(
          deps.root,
          (current) => ({ ...current, lastTickAt: deps.now().toISOString() }),
          deps.pidfile,
        );
      } catch (err) {
        // A15.3: swallowed, never thrown out of the tick — an uncaught
        // throw here would kill the daemon (domain-1) for a domain-2-shaped
        // problem.
        deps.log('heartbeat-write-failed', { error: String(err) });
      }

      if (ticking) return;
      ticking = true;
      try {
        await runOwedBatch();
      } finally {
        ticking = false;
      }
    }

    return {
      tick,
      start(): void {
        // §5.2/A15.2: an immediate first tick, BEFORE arming the interval —
        // replay evaluates at daemon start, not TICK_MS after it, and a
        // live daemon must heartbeat within 35s of being observed (the
        // steal-recheck window `serve start` uses).
        void tick();
        timer = setInterval(() => {
          void tick();
        }, TICK_MS);
      },
      stop(): void {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    };
  }
  ```

- [ ] **Step 4: Run it and see the first test pass.**

  ```bash
  node --test src/ops/daemon/daemon.test.ts
  ```

  Expected: `# pass 1`, `# fail 0`.

- [ ] **Step 5: Write the remaining five tests.**

  Append to `daemon.test.ts`:

  ```ts
  test('a second tick during an in-flight run short-circuits on the guard but still advances lastTickAt', async () => {
    let nowMs = new Date(2026, 6, 27, 14, 4).getTime();
    const now = () => new Date(nowMs);

    let resolveSpawn: ((code: number) => void) | undefined;
    const spawnRun: SpawnRun = () =>
      new Promise((resolve) => {
        resolveSpawn = resolve;
      });
    const scan = fakeScanDeps(
      { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
      { [PROFILES_DIR]: ['harish'] },
    );
    const { deps, events } = baseDeps({ scan, spawnRun, now });
    const daemon = createDaemon(deps);

    const firstTick = daemon.tick();
    await Promise.resolve();
    await Promise.resolve(); // let the heartbeat write and ledger append settle.

    const beforeSecondTick = readLastTickAt(deps);
    nowMs += 1000;
    await daemon.tick(); // short-circuits on the reentrancy guard.
    const afterSecondTick = readLastTickAt(deps);

    assert.notEqual(afterSecondTick, beforeSecondTick); // heartbeat still advanced.
    assert.equal(events.filter((e) => e.event === 'spawn').length, 1); // no 2nd spawn attempt.

    resolveSpawn?.(0);
    await firstTick;
  });

  test('a heartbeat write that throws is swallowed and the tick continues', async () => {
    const scan = fakeScanDeps(
      { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
      { [PROFILES_DIR]: ['harish'] },
    );
    const spawnCalls: string[] = [];
    const spawnRun: SpawnRun = async (owed) => {
      spawnCalls.push(owed.profile);
      return 0;
    };
    const { deps, events } = baseDeps({ scan, spawnRun });

    let calls = 0;
    const originalWrite = deps.pidfile.writeFileSync;
    deps.pidfile.writeFileSync = (p, data) => {
      calls += 1;
      if (calls === 1) throw new Error('ENOSPC'); // the heartbeat write — first of the tick.
      originalWrite(p, data);
    };

    await assert.doesNotReject(() => createDaemon(deps).tick());
    assert.equal(spawnCalls.length, 1); // the batch still ran despite the heartbeat failure.
    assert.ok(events.some((e) => e.event === 'heartbeat-write-failed'));
  });

  test('a ledger entry suppresses a respawn for a slot with no run folder', async () => {
    const scan = fakeScanDeps(
      { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
      { [PROFILES_DIR]: ['harish'] }, // no runs/2026-07-27 dir — nothing ever checkpointed.
    );
    const spawnCalls: string[] = [];
    const spawnRun: SpawnRun = async (owed) => {
      spawnCalls.push(owed.profile);
      return 0;
    };
    const { deps } = baseDeps({ scan, spawnRun });

    await createDaemon(deps).tick(); // spawns and ledgers the attempt.
    assert.deepEqual(spawnCalls, ['harish']);

    await createDaemon(deps).tick(); // same slot, still no run folder.
    assert.deepEqual(spawnCalls, ['harish']); // NOT spawned again — the ledger entry served it.
  });

  test('an entry whose grace window expired during a predecessor run is skipped and NOT ledgered', async () => {
    let nowMs = new Date(2026, 6, 27, 9, 6).getTime();
    const now = () => new Date(nowMs);

    const scan = fakeScanDeps(
      {
        [profilePath('alpha')]: profileJson({ times: ['09:00'], graceMinutes: 90 }),
        [profilePath('beta')]: profileJson({ times: ['09:05'], graceMinutes: 5 }),
      },
      { [PROFILES_DIR]: ['alpha', 'beta'] },
    );

    const spawnCalls: string[] = [];
    const spawnRun: SpawnRun = async (owed) => {
      spawnCalls.push(owed.profile);
      if (owed.profile === 'alpha') {
        // alpha's run "takes long enough" that beta's own 5-minute grace
        // window (09:05-09:10) has since expired by the time its turn comes.
        nowMs = new Date(2026, 6, 27, 9, 30).getTime();
      }
      return 0;
    };

    const { deps, events } = baseDeps({ scan, spawnRun, now });
    await createDaemon(deps).tick();

    assert.deepEqual(spawnCalls, ['alpha']); // beta was never spawned.
    assert.ok(
      events.some((e) => e.event === 'slot-expired-skipped' && e.data?.profile === 'beta'),
    );

    const pidfile = readDaemonPidfile(deps.root, deps.pidfile);
    assert.deepEqual(
      pidfile?.attempts.map((a) => a.profile),
      ['alpha'], // beta was never ledgered — it was never attempted.
    );
  });

  test('two owed entries run sequentially in (slot, profileName) order', async () => {
    const scan = fakeScanDeps(
      {
        [profilePath('zeta')]: profileJson({ times: ['14:00'] }),
        [profilePath('alpha')]: profileJson({ times: ['14:00'] }),
      },
      { [PROFILES_DIR]: ['zeta', 'alpha'] },
    );

    const order: string[] = [];
    const spawnRun: SpawnRun = async (owed) => {
      order.push(`start:${owed.profile}`);
      await Promise.resolve();
      order.push(`end:${owed.profile}`);
      return 0;
    };

    const { deps } = baseDeps({ scan, spawnRun });
    await createDaemon(deps).tick();

    assert.deepEqual(order, ['start:alpha', 'end:alpha', 'start:zeta', 'end:zeta']);
  });
  ```

- [ ] **Step 6: Run it and see all six tests pass.**

  ```bash
  node --test src/ops/daemon/daemon.test.ts
  ```

  Expected: `# pass 6`, `# fail 0` — no implementation change needed; Step 3's implementation already covers every mandatory ordering rule.

- [ ] **Step 7: Update the `ops/daemon/` module's public surface.**

  Modify `/Users/harishamutha/Job-bunny/src/ops/daemon/index.ts` (created in Task 5) from:

  ```ts
  export * from './pidfile.ts';
  ```

  to:

  ```ts
  export * from './pidfile.ts';
  export * from './daemon.ts';
  ```

- [ ] **Step 8: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 9: Commit.**

  ```bash
  git add src/ops/daemon/daemon.ts src/ops/daemon/daemon.test.ts src/ops/daemon/index.ts
  git commit -m "$(cat <<'EOF'
  feat(daemon): add the 30s tick loop (heartbeat, ledger fold, sequential spawn)

  createDaemon(deps).tick() writes the pidfile heartbeat before the
  reentrancy guard (so a busy daemon's heartbeat never freezes for the
  duration of a long-running child, D22/A15.1), folds today's
  attempts-ledger entries into isRunOwed's history alongside real run
  folders (D19), and spawns each owed (profile, slot) sequentially in
  ascending (slot, profileName) order — revalidating each entry's own
  grace window immediately before spawning it, since a slow
  predecessor in the same batch can otherwise let a later entry's
  window quietly expire. The real child spawn is injected as
  SpawnRun; this module knows the clock and the ledger, nothing about
  pipeline stages or the CLI.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 8: stage timeout budgets + child supervision (the real `SpawnRun`)

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/pipeline/stages/budgets.ts`
- Create: `/Users/harishamutha/Job-bunny/src/pipeline/stages/budgets.test.ts`
- Create: `/Users/harishamutha/Job-bunny/test/invariants/stage_budgets.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/pipeline/stages/index.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/cli/commands/run.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/supervise/supervise.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/supervise/supervise.test.ts`
- Create: `/Users/harishamutha/Job-bunny/src/ops/daemon/supervise/index.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/ops/daemon/index.ts`

**Placement note:** `src/pipeline/stages/` already holds ten implementation files (`reconcile.ts` through `sync.ts`) plus their colocated tests and one `index.ts` — well past the two-implementation-file cap, but the folder's own established convention (flat, no subfolders, `index.ts` re-exporting every file) predates this task and isn't disturbed by it, so `budgets.ts` lands as an eleventh flat file rather than inventing a `budgets/` subfolder. Separately, `src/ops/daemon/` already sits at the two-implementation-file cap — `daemon.ts` (Task 7) and `pidfile.ts` (Task 5) — with filesystem scanning and log-file management already split into their own `scan/` and `logs/` subfolders (Tasks 4 and 6) for exactly this reason. A third top-level file would exceed the cap, so child supervision gets its own subfolder, `src/ops/daemon/supervise/`, holding one implementation file (`supervise.ts`) plus its colocated test and public surface — under the cap.

**Interfaces:**

Consumes: `updateDaemonPidfile`, `DaemonPidfileDeps` from `../pidfile.ts`; `rotateIfLarge`, `openAppendFd`, `runsLogPath`, `LogDeps` from `../logs/index.ts`; `SpawnRun` from `../daemon.ts`; `OwedRun` from `../../../core/schedule/index.ts`. Additionally, for the stage-budget drift guard ONLY (never for `budgets.ts` itself, which reads a plain table with no stage-factory imports): `StageDef`/`StagePayload` from `../../src/pipeline/runner/stage.ts`, `Connector` from `../../src/ports/connector.ts`, `LlmProvider` from `../../src/ports/llm.ts`, `RegistryPolicy` from `../../src/core/company/schema.ts`, `FilterConfigSchema` from `../../src/core/filter/config.ts`, `RankConfigSchema` from `../../src/core/rank/index.ts`, and the ten stage factories from `../../src/pipeline/stages/index.ts`.

Produces:
```ts
export interface StageBudget {
  name: string;
  timeoutMs: number;
  retries: number;
}

export const RUN_CAP_MARGIN: number;               // 1.25
export const STAGE_BUDGETS: readonly StageBudget[]; // the ten verified stage budgets, in pipeline order
export function computeRunCapMs(budgets?: readonly StageBudget[]): number; // defaults to STAGE_BUDGETS

export const BACKSTOP_MARGIN_MS: number;   // 300_000 — the same +300s the retired plist watchdog used
export const SIGKILL_GRACE_MS: number;     // 20_000

export interface SuperviseDeps {
  spawn(command: string, args: readonly string[], opts: { stdio: readonly unknown[] }): { pid?: number; on(event: string, cb: (arg: unknown) => void): void; kill(signal: string): boolean };
  pidfile: DaemonPidfileDeps;
  logs: LogDeps;
  root: string;
  home: string;
  nodeBin: string;
  cliEntry: string;
  runCapMs: number;
  log(event: string, data?: Record<string, unknown>): void;
  setTimeout(cb: () => void, ms: number): { unref?(): void };
  clearTimeout(handle: unknown): void;
}

export function createSpawnRun(deps: SuperviseDeps): SpawnRun;
```

`computeRunCapMs` behavior (tested in `budgets.test.ts`): sums `timeoutMs * (retries + 1)` across the given budgets (or `STAGE_BUDGETS` if omitted), then applies `Math.ceil(worstCaseMs * RUN_CAP_MARGIN)` — this is the SAME formula `cli/commands/run.ts` previously defined as a private local copy; it now has one home. **Why `test/invariants/stage_budgets.test.ts` exists:** `STAGE_BUDGETS` is a plain-data MIRROR of the real `timeoutMs`/`retries` baked into each `pipeline/stages/*.ts` factory — nothing in the type system enforces that the mirror stays accurate. An edit to a stage's `timeoutMs` that isn't mirrored here would silently shorten the daemon's run-cap backstop (`createSpawnRun`'s `runCapMs + BACKSTOP_MARGIN_MS`) below the real worst case a run could legitimately take, so the backstop would SIGKILL a legitimate in-flight run instead of letting the run's own `runCapMs` watchdog abort it gracefully. The guard test constructs the REAL stage factories — the same ones `cli/wire.ts` calls — with minimal placeholder ports that are NEVER invoked (`.run()` is never called on any resulting `StageDef`; only `.name`/`.timeoutMs`/`.retries` are read). That construction is fragile — it holds only as long as no stage factory does real work at construction time — which is exactly why it is deliberately confined to this ONE test rather than production code: an unmirrored change fails loudly here, in CI, rather than silently in a running daemon.

Behavior rules for `createSpawnRun`, each stated once and tested:

- Rotates `runs.log` via `rotateIfLarge` BEFORE spawning — the safe quiet point, because execution is sequential (D6) and no child is writing at that instant. Then opens the append fd and passes `stdio: ['ignore', fd, fd]` so the child's stdout and stderr are captured. This matters because the three early-abort paths in `cli/commands/run.ts` (a `wire()` config throw, a held run lock, a red doctor preflight) write only to `console.error` and create NO run folder, so without this capture they would leave no diagnostics at all.
- This process's OWN copy of the fd is closed (`deps.logs.closeSync(fd)`) immediately after `spawn()` hands it to the child as stdio — otherwise a daemon that lives for months (D20 autostart) leaks one fd per spawned run for the rest of its life.
- Spawns `<nodeBin> <cliEntry> run --profile <owed.profile> --headless`.
- Records the child's pid into the pidfile `inFlight` field AFTER `spawn()` returns (the pid does not exist before that call). Accepted gap: a daemon crash in that window orphans an unrecorded child.
- Attaches an `error` handler. An `error` event (ENOENT, EMFILE) is treated exactly as a nonzero child exit — it must NOT throw, because an uncaught throw here kills the daemon: a domain-1 blast radius for a domain-2 problem. The ledger-append-before-spawn from Task 7 already prevents a retry storm in this case.
- Arms a `setTimeout` backstop at `runCapMs + BACKSTOP_MARGIN_MS`. On expiry: `SIGTERM`, then after `SIGKILL_GRACE_MS`, `SIGKILL`. This is a faithful port of the embedded bash watchdog the retired plist carried inside `buildCommand` (sleep → `kill -0` → SIGTERM → sleep 20 → SIGKILL), using the SAME +300s margin, not a new policy. Windows caveat: Node emulates both signals as an unconditional terminate there, so the escalation collapses to a single hard kill, which is acceptable (D10).
- The backstop timer AND its own nested SIGKILL timer (armed inside the backstop's callback once SIGTERM fires) are BOTH cleared when the child exits — the nested timer is tracked in the enclosing scope, not local to the backstop callback, specifically so a child that exits between SIGTERM and SIGKILL_GRACE_MS doesn't leave it dangling.
- Clears `inFlight` from the pidfile on exit, whatever the exit code.
- `runCapMs` is passed IN, derived by the caller from `computeRunCapMs()` (Task 9). It must never be hardcoded here — stage timeouts change, and a hardcoded figure goes stale silently (A12).

- [ ] **Step 1: Write the failing tests for `budgets.ts`.**

  Create `/Users/harishamutha/Job-bunny/src/pipeline/stages/budgets.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { computeRunCapMs, RUN_CAP_MARGIN, STAGE_BUDGETS } from './budgets.ts';
  import type { StageBudget } from './budgets.ts';

  // Verified against every pipeline/stages/*.ts factory's real timeoutMs/
  // retries (reconcile 60_000/0, farm 5_400_000/0, source 300_000/0,
  // compress 30_000/0, structure 1_800_000/1, assemble 30_000/0, filter
  // 30_000/0, dedup 30_000/0, rank 30_000/0, sync 900_000/0):
  //   worst case = 60_000 + 5_400_000 + 300_000 + 30_000 + 1_800_000*2 +
  //                30_000 + 30_000 + 30_000 + 30_000 + 900_000
  //              = 10_410_000
  //   run cap    = ceil(10_410_000 * 1.25) = 13_012_500

  test('computeRunCapMs() with no argument sums STAGE_BUDGETS and applies RUN_CAP_MARGIN', () => {
    assert.equal(RUN_CAP_MARGIN, 1.25);
    assert.equal(computeRunCapMs(), 13_012_500);
  });

  test('the default STAGE_BUDGETS table sums to the verified worst-case figure', () => {
    const worstCaseMs = STAGE_BUDGETS.reduce(
      (sum, b) => sum + b.timeoutMs * (b.retries + 1),
      0,
    );
    assert.equal(worstCaseMs, 10_410_000);
  });

  test('computeRunCapMs() sums a custom budget array, not just the default table', () => {
    const budgets: StageBudget[] = [
      { name: 'a', timeoutMs: 10_000, retries: 0 },
      { name: 'b', timeoutMs: 20_000, retries: 0 },
    ];
    assert.equal(computeRunCapMs(budgets), 37_500); // (10_000 + 20_000) * 1.25
  });

  test('a stage with retries: 1 counts its timeoutMs twice toward the worst case', () => {
    const budgets: StageBudget[] = [{ name: 'x', timeoutMs: 10_000, retries: 1 }];
    assert.equal(computeRunCapMs(budgets), 25_000); // 10_000 * 2 * 1.25
  });
  ```

- [ ] **Step 2: Run it and see it fail because `budgets.ts` does not exist yet.**

  ```bash
  node --test src/pipeline/stages/budgets.test.ts
  ```

  Expected failure: `Cannot find module '.../pipeline/stages/budgets.ts'`.

- [ ] **Step 3: Implement `budgets.ts` in full.**

  Create `/Users/harishamutha/Job-bunny/src/pipeline/stages/budgets.ts`:

  ```ts
  /**
   * pipeline/stages/budgets.ts — a plain data mirror of every stage
   * factory's own `timeoutMs`/`retries` (see each `pipeline/stages/*.ts`
   * file for the source of truth), plus the arithmetic that turns that
   * table into a run-level cap.
   *
   * Why a static table rather than calling the real stage factories at
   * runtime: this module is consumed by `serve` (Task 9), which is
   * cross-profile (D6) and therefore cannot `wire()` a real profile to
   * obtain a live `stages` array the way `cli/commands/run.ts` does for
   * itself. Reading a static table from PRODUCTION code — rather than
   * constructing stage factories with never-invoked stub ports at
   * runtime — keeps this module honest: it holds no fragile assumption
   * about what a stage factory does at construction time.
   *
   * The cost of that simplicity is that this table can silently drift
   * from the real per-stage `timeoutMs`/`retries` if a stage factory
   * changes without a matching edit here. `test/invariants/
   * stage_budgets.test.ts` closes that gap — it is the one place the
   * fragile stub-port construction trick is still used, deliberately
   * confined to a test so an unmirrored change fails loudly in CI, not
   * silently in a running daemon (see that file's own header for the
   * full rationale).
   */
  export interface StageBudget {
    name: string;
    timeoutMs: number;
    retries: number;
  }

  /** Margin over the raw worst-case stage-timeout sum, to absorb
   * orchestration overhead (checkpoint writes between batches,
   * stall-watchdog polling, process scheduling jitter) that isn't itself
   * charged against any one stage's `timeoutMs`. Same figure and same
   * rationale `cli/commands/run.ts` previously defined as a private
   * local constant — this is now its one home. */
  export const RUN_CAP_MARGIN = 1.25;

  /** Verified against every `pipeline/stages/*.ts` factory's real
   * `name`/`timeoutMs`/`retries`, in pipeline order. Kept honest by
   * `test/invariants/stage_budgets.test.ts`. */
  export const STAGE_BUDGETS: readonly StageBudget[] = [
    { name: 'reconcile', timeoutMs: 60_000, retries: 0 },
    { name: 'farm', timeoutMs: 5_400_000, retries: 0 },
    { name: 'source', timeoutMs: 300_000, retries: 0 },
    { name: 'compress', timeoutMs: 30_000, retries: 0 },
    { name: 'structure', timeoutMs: 1_800_000, retries: 1 },
    { name: 'assemble', timeoutMs: 30_000, retries: 0 },
    { name: 'filter', timeoutMs: 30_000, retries: 0 },
    { name: 'dedup', timeoutMs: 30_000, retries: 0 },
    { name: 'rank', timeoutMs: 30_000, retries: 0 },
    { name: 'sync', timeoutMs: 900_000, retries: 0 },
  ];

  /**
   * The run-level cap (third watchdog layer, `runPipeline`'s `runCapMs`)
   * MUST exceed the worst case total every stage could legitimately
   * take, including whole-stage retries — each retry attempt gets its
   * OWN fresh `timeoutMs` budget (`guardStage`/`runOneAttempt`), so a
   * stage with `retries: 1` can legitimately consume `timeoutMs * 2`
   * before the run itself should even consider that a problem.
   */
  export function computeRunCapMs(
    budgets: readonly StageBudget[] = STAGE_BUDGETS,
  ): number {
    const worstCaseMs = budgets.reduce(
      (sum, b) => sum + b.timeoutMs * (b.retries + 1),
      0,
    );
    return Math.ceil(worstCaseMs * RUN_CAP_MARGIN);
  }
  ```

- [ ] **Step 4: Run it and see all four tests pass.**

  ```bash
  node --test src/pipeline/stages/budgets.test.ts
  ```

  Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Update `pipeline/stages/index.ts` to export the new module.**

  In `/Users/harishamutha/Job-bunny/src/pipeline/stages/index.ts`, replace:

  ```ts
  export * from './assemble.ts';
  export * from './compress.ts';
  export * from './dedup.ts';
  export * from './farm.ts';
  export * from './filter.ts';
  export * from './rank.ts';
  export * from './reconcile.ts';
  export * from './source.ts';
  export * from './structure.ts';
  export * from './sync.ts';
  ```

  with:

  ```ts
  export * from './assemble.ts';
  export * from './budgets.ts';
  export * from './compress.ts';
  export * from './dedup.ts';
  export * from './farm.ts';
  export * from './filter.ts';
  export * from './rank.ts';
  export * from './reconcile.ts';
  export * from './source.ts';
  export * from './structure.ts';
  export * from './sync.ts';
  ```

- [ ] **Step 6: Write the drift-guard test.**

  Create `/Users/harishamutha/Job-bunny/test/invariants/stage_budgets.test.ts`:

  ```ts
  /**
   * stage_budgets.test.ts — the drift guard for `pipeline/stages/
   * budgets.ts`'s `STAGE_BUDGETS` table (Task 8 of the scheduling-daemon
   * plan).
   *
   * `STAGE_BUDGETS` is a plain data mirror of every stage factory's own
   * `name`/`timeoutMs`/`retries`, read by `computeRunCapMs()` — consumed
   * by both `cli/commands/run.ts` (a real profile's own run) and, more
   * importantly, by `serve` (Task 9), which is cross-profile (D6) and
   * therefore cannot `wire()` a real profile to obtain a live `stages`
   * array the way `run.ts` does for itself. Nothing in the type system
   * enforces that the mirror stays accurate: if a stage's `timeoutMs`/
   * `retries` changes in its own `pipeline/stages/*.ts` factory without a
   * matching edit to `STAGE_BUDGETS`, the daemon's run-cap backstop
   * (`createSpawnRun`'s `runCapMs + BACKSTOP_MARGIN_MS`, Task 8) silently
   * shortens below the real worst case a run could legitimately take —
   * and then SIGKILLs a legitimate in-flight run instead of letting the
   * run's own `runCapMs` watchdog abort it gracefully.
   *
   * This test constructs the REAL stage factories (the same ones
   * `cli/wire.ts` calls) with minimal placeholder ports that are NEVER
   * invoked — `.run()` is never called on any resulting `StageDef`, only
   * `.name`/`.timeoutMs`/`.retries` are read. That construction is
   * fragile: it holds only as long as no stage factory does real work at
   * construction time, which is exactly why it is deliberately confined
   * to this test rather than production code (`budgets.ts` reads a plain
   * table, no stage-factory imports) — an unmirrored change fails loudly
   * here, in CI, rather than silently in a running daemon.
   *
   * Spiritually the successor to `test/invariants/run_cap_backstop.
   * test.ts` (deleted when the launchd scheduler was removed — it
   * imported `DEFAULT_RUN_CAP_MS` from the doomed
   * `adapters/scheduler/launchd/plist.ts`) — same intent
   * (catch a stage-budget drift before it reaches production), same
   * `test/invariants/` home, different mechanism (a static table plus
   * this construction-based guard, rather than a hand-copied launchd
   * literal).
   */
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import type { RegistryPolicy } from '../../src/core/company/schema.ts';
  import { FilterConfigSchema } from '../../src/core/filter/config.ts';
  import { RankConfigSchema } from '../../src/core/rank/index.ts';
  import { STAGE_BUDGETS } from '../../src/pipeline/stages/budgets.ts';
  import {
    assembleStage,
    compressStage,
    dedupStage,
    makeFarmStage,
    makeFilterStage,
    makeRankStage,
    makeReconcileStage,
    makeSourceStage,
    makeStructureStage,
    makeSyncStage,
  } from '../../src/pipeline/stages/index.ts';
  import type { Connector } from '../../src/ports/connector.ts';
  import type { LlmProvider } from '../../src/ports/llm.ts';

  function buildWiredStages() {
    const stubConnector: Connector = {
      name: 'stub',
      rebuildCache: async () => [],
      syncJobs: async () => [],
      archiveStale: async () => ({ archived: 0, dropped: [] }),
    };
    const stubLlm: LlmProvider = { name: 'stub', complete: async () => '' };
    const registryPolicy: RegistryPolicy = {
      reprobeNotFoundAfterDays: 30,
      maxProbeFailures: 3,
      staleAfterFetchFailures: 3,
    };
    return [
      makeReconcileStage(stubConnector),
      makeFarmStage([]),
      makeSourceStage([], registryPolicy, { maxProbesPerRun: 1 }),
      compressStage,
      makeStructureStage(stubLlm),
      assembleStage,
      makeFilterStage(FilterConfigSchema.parse({})),
      dedupStage,
      makeRankStage(RankConfigSchema.parse({})),
      makeSyncStage(stubConnector, {}),
    ];
  }

  test("STAGE_BUDGETS mirrors every wired stage's name/timeoutMs/retries exactly, in order", () => {
    const wired = buildWiredStages();
    assert.equal(
      wired.length,
      STAGE_BUDGETS.length,
      'a stage was added to or removed from the pipeline without a matching STAGE_BUDGETS edit',
    );
    wired.forEach((stage, i) => {
      const budget = STAGE_BUDGETS[i];
      assert.ok(budget, `no STAGE_BUDGETS entry at index ${i} for wired stage "${stage.name}"`);
      assert.equal(budget.name, stage.name);
      assert.equal(budget.timeoutMs, stage.timeoutMs);
      assert.equal(budget.retries, stage.retries);
    });
  });
  ```

- [ ] **Step 7: Run it and see it pass.**

  ```bash
  node --test test/invariants/stage_budgets.test.ts
  ```

  Expected: `# pass 1`, `# fail 0` — `STAGE_BUDGETS` was hand-verified against the real factories while writing Step 3, so this passes on the first run; its job is to catch the NEXT drift, not this one.

- [ ] **Step 8: Modify `cli/commands/run.ts` to derive `computeRunCapMs` from `budgets.ts` instead of a local duplicate.**

  **Chosen form and why:** an `import` of `computeRunCapMs` from `pipeline/stages/budgets.ts` PLUS an explicit `export { computeRunCapMs };` — not a bare `export { computeRunCapMs } from '...'` re-export. A bare re-export creates no local binding, so `computeRunCapMs` would not be callable at this file's own call site (`computeRunCapMs(stages)` a few dozen lines below); import-then-export keeps both that local call site AND every external importer of `computeRunCapMs` from `cli/commands/run.ts` (this file's own `run.test.ts`, and `test/invariants/run_cap_backstop.test.ts` until Task 12 deletes it) working with zero changes to either test file. `stages` (a live `Array<StageDef<StagePayload, StagePayload>>` from `wire()`) satisfies `budgets.ts`'s `readonly StageBudget[]` parameter structurally — `StageDef` is a superset of `StageBudget`'s three fields — so no adapter or cast is needed at the call site.

  In `/Users/harishamutha/Job-bunny/src/cli/commands/run.ts`, first add the import, replacing:

  ```ts
  import type { PipelineCtx } from '../../pipeline/runner/context.ts';
  import type { RunnerOptions } from '../../pipeline/runner/run.ts';
  import { runPipeline as defaultRunPipeline } from '../../pipeline/runner/run.ts';
  import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
  import type { Routine } from '../../routines/types.ts';
  import { wire as defaultWire, type WireResult } from '../wire.ts';
  ```

  with:

  ```ts
  import type { PipelineCtx } from '../../pipeline/runner/context.ts';
  import type { RunnerOptions } from '../../pipeline/runner/run.ts';
  import { runPipeline as defaultRunPipeline } from '../../pipeline/runner/run.ts';
  import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
  import { computeRunCapMs } from '../../pipeline/stages/budgets.ts';
  import type { Routine } from '../../routines/types.ts';
  import { wire as defaultWire, type WireResult } from '../wire.ts';
  ```

  Then replace the local margin constant and function it replaces:

  ```ts
  /** Margin over the raw worst-case stage-timeout sum, to absorb
   * orchestration overhead (checkpoint writes between batches, stall-watchdog
   * polling, process scheduling jitter) that isn't itself charged against
   * any one stage's `timeoutMs`. */
  const RUN_CAP_MARGIN = 1.25;

  /**
   * The run-level cap (third watchdog layer, `runPipeline`'s `runCapMs`) MUST
   * exceed the worst case total every stage could legitimately take,
   * including whole-stage retries — each retry attempt gets its OWN fresh
   * `timeoutMs` budget (`guardStage`/`runOneAttempt`), so a stage with
   * `retries: 1` can legitimately consume `timeoutMs * 2` before the run
   * itself should even consider that a problem. Deriving the cap from the
   * live `stages` array (rather than a hardcoded constant) means this never
   * silently drifts out of sync again as stage budgets change — see P9
   * closure register item 2, whose broken run was caused by exactly that
   * drift (cap 30 min < sum of stage timeouts ~68 min).
   */
  export function computeRunCapMs(
    stages: Array<StageDef<StagePayload, StagePayload>>,
  ): number {
    const worstCaseMs = stages.reduce(
      (sum, stage) => sum + stage.timeoutMs * (stage.retries + 1),
      0,
    );
    return Math.ceil(worstCaseMs * RUN_CAP_MARGIN);
  }
  ```

  with:

  ```ts
  /**
   * The run-level cap (third watchdog layer, `runPipeline`'s `runCapMs`) MUST
   * exceed the worst case total every stage could legitimately take,
   * including whole-stage retries — each retry attempt gets its OWN fresh
   * `timeoutMs` budget (`guardStage`/`runOneAttempt`), so a stage with
   * `retries: 1` can legitimately consume `timeoutMs * 2` before the run
   * itself should even consider that a problem. Deriving the cap from the
   * live `stages` array (rather than a hardcoded constant) means this never
   * silently drifts out of sync again as stage budgets change — see P9
   * closure register item 2, whose broken run was caused by exactly that
   * drift (cap 30 min < sum of stage timeouts ~68 min).
   *
   * The arithmetic itself now lives in `pipeline/stages/budgets.ts` (Task
   * 8), re-exported here so every existing call site — this file's own
   * `computeRunCapMs(stages)` below, plus every test that imports
   * `computeRunCapMs` from `cli/commands/run.ts` — keeps working
   * unchanged. The live `stages` array satisfies `budgets.ts`'s `readonly
   * StageBudget[]` parameter structurally, so no adapter or cast is
   * needed at the call site.
   */
  export { computeRunCapMs };
  ```

  The call site itself, `runCapMs: opts.runCapMs ?? computeRunCapMs(stages),`, is untouched — same function name, same argument, now resolving to the imported implementation.

- [ ] **Step 9: Run the existing `run.ts` tests and confirm nothing broke.**

  ```bash
  node --test src/cli/commands/run.test.ts test/invariants/run_cap_backstop.test.ts
  ```

  Expected: both files pass unchanged — `run.test.ts`'s `computeRunCapMs` tests and `run_cap_backstop.test.ts`'s `DEFAULT_RUN_CAP_MS` comparison both call `computeRunCapMs(stages)` exactly as before; only the implementation's location moved, not its behavior.

- [ ] **Step 10: Write the first two failing tests plus their shared fakes.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/supervise/supervise.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import type { OwedRun } from '../../../core/schedule/index.ts';
  import type { LogDeps } from '../logs/index.ts';
  import { acquireDaemonPidfile, readDaemonPidfile } from '../pidfile.ts';
  import type { DaemonPidfileDeps } from '../pidfile.ts';
  import { createSpawnRun } from './supervise.ts';
  import type { SuperviseDeps } from './supervise.ts';

  const ROOT = '/fake/root';
  const HOME = '/fake/home';
  const OWED: OwedRun = { profile: 'harish', date: '2026-07-27', slot: '14:00' };

  function fakePidfileDeps(): DaemonPidfileDeps {
    const files = new Map<string, string>();
    const notFound = (): never => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    return {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => files.get(p) ?? notFound(),
      writeFileSync: (p, data) => {
        files.set(p, data);
      },
      writeFileSyncExclusive: (p, data) => {
        if (files.has(p)) return false;
        files.set(p, data);
        return true;
      },
      renameSync: (from, to) => {
        const content = files.get(from) ?? notFound();
        files.delete(from);
        files.set(to, content);
      },
      unlinkSync: (p) => {
        files.delete(p);
      },
      pidIsAlive: () => true,
      now: () => new Date(),
    };
  }

  function fakeLogDeps(): LogDeps {
    return {
      existsSync: () => true,
      mkdirSync: () => {},
      statSync: () => ({ size: 0 }),
      renameSync: () => {},
      openSync: () => 42,
      closeSync: () => {},
    };
  }

  function fakeChild(pid: number | undefined): {
    spawnArg: SuperviseDeps['spawn'];
    emit(event: string, arg?: unknown): void;
    killCalls: string[];
  } {
    const listeners = new Map<string, Array<(arg: unknown) => void>>();
    const killCalls: string[] = [];
    const handle = {
      pid,
      on(event: string, cb: (arg: unknown) => void) {
        const arr = listeners.get(event) ?? [];
        arr.push(cb);
        listeners.set(event, arr);
      },
      kill(signal: string) {
        killCalls.push(signal);
        return true;
      },
    };
    const spawnArg: SuperviseDeps['spawn'] = () => handle;
    return {
      spawnArg,
      emit(event, arg) {
        for (const cb of listeners.get(event) ?? []) cb(arg);
      },
      killCalls,
    };
  }

  function baseDeps(overrides: Partial<SuperviseDeps> = {}): {
    deps: SuperviseDeps;
    pidfile: DaemonPidfileDeps;
    events: Array<{ event: string; data?: Record<string, unknown> }>;
  } {
    const pidfile = fakePidfileDeps();
    acquireDaemonPidfile(ROOT, 5000, pidfile);
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const deps: SuperviseDeps = {
      spawn: () => {
        throw new Error('override deps.spawn in the test');
      },
      pidfile,
      logs: fakeLogDeps(),
      root: ROOT,
      home: HOME,
      nodeBin: 'node',
      cliEntry: 'src/cli/main.ts',
      runCapMs: 1_000,
      log: (event, data) => {
        events.push({ event, data });
      },
      // Default: a backstop that never fires, so tests that don't care
      // about it aren't affected by an immediate synchronous expiry.
      setTimeout: () => ({}),
      clearTimeout: () => {},
      ...overrides,
    };
    return { deps, pidfile, events };
  }

  test('records the child pid into inFlight after spawn() returns, and clears it on exit', async () => {
    const child = fakeChild(9001);
    const { deps, pidfile } = baseDeps({ spawn: child.spawnArg });
    const promise = createSpawnRun(deps)(OWED);
    const inFlight = readDaemonPidfile(ROOT, pidfile)?.inFlight;
    assert.equal(inFlight?.pid, 9001);
    assert.equal(inFlight?.profile, OWED.profile);
    assert.equal(typeof inFlight?.startedAt, 'string');
    child.emit('exit', 0);
    const code = await promise;
    assert.equal(code, 0);
    assert.equal(readDaemonPidfile(ROOT, pidfile)?.inFlight, undefined);
  });

  test('rotates runs.log (size check) then spawns, then closes its own fd copy, in that order', async () => {
    const calls: string[] = [];
    const logs: LogDeps = {
      existsSync: () => true,
      mkdirSync: () => calls.push('mkdir'),
      statSync: (p) => {
        calls.push(`stat:${p}`);
        return { size: 0 };
      },
      renameSync: () => calls.push('rename'),
      openSync: (p, flags) => {
        calls.push(`open:${p}:${flags}`);
        return 42;
      },
      closeSync: (fd) => calls.push(`close:${fd}`),
    };
    const child = fakeChild(9001);
    const spawn: SuperviseDeps['spawn'] = (command, args, opts) => {
      calls.push('spawn');
      return child.spawnArg(command, args, opts);
    };
    const { deps } = baseDeps({ logs, spawn });
    const promise = createSpawnRun(deps)(OWED);
    child.emit('exit', 0);
    await promise;
    assert.deepEqual(calls, [
      'stat:/fake/home/.jobbunny/logs/runs.log',
      'open:/fake/home/.jobbunny/logs/runs.log:a',
      'spawn',
      'close:42',
    ]);
  });
  ```

- [ ] **Step 11: Run it and see it fail because `supervise.ts` does not exist yet.**

  ```bash
  node --test src/ops/daemon/supervise/supervise.test.ts
  ```

  Expected failure: `Cannot find module '.../ops/daemon/supervise/supervise.ts'`.

- [ ] **Step 12: Implement `supervise.ts` in full.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/supervise/supervise.ts`:

  ```ts
  /**
   * ops/daemon/supervise/supervise.ts — the real SpawnRun that daemon.ts's
   * createDaemon() consumes as an injected function (Task 7). Builds
   * `<nodeBin> <cliEntry> run --profile <owed.profile> --headless`, rotates
   * runs.log immediately before spawning (D21/§6.9 — the safe quiet point,
   * since D6's sequential-execution guarantee means no other child can be
   * writing to it at that instant), captures the child's stdout/stderr into
   * the append fd, records/clears the daemon pidfile's `inFlight` pid, and
   * arms a SIGTERM→SIGKILL backstop that is a faithful PORT of the embedded
   * bash watchdog the retired plist carried inside `buildCommand`
   * (`adapters/scheduler/launchd/plist.ts`, deleted when the launchd
   * scheduler was removed) — the same +300s margin, the same 20s SIGKILL
   * grace, not a new policy (§6.5).
   *
   * This module knows nothing about pipeline stages, the CLI, or the
   * daemon's own tick loop — it only knows how to spawn and supervise ONE
   * child given an `OwedRun` and resolve to its exit code, exactly the
   * `SpawnRun` shape `daemon.ts` expects.
   */
  import type { OwedRun } from '../../../core/schedule/index.ts';
  import type { SpawnRun } from '../daemon.ts';
  import { openAppendFd, rotateIfLarge, runsLogPath } from '../logs/index.ts';
  import type { LogDeps } from '../logs/index.ts';
  import { updateDaemonPidfile } from '../pidfile.ts';
  import type { DaemonPidfileDeps } from '../pidfile.ts';

  /** Same `+300s` margin the retired plist watchdog used
   * (`adapters/scheduler/launchd/plist.ts`'s
   * `backstopSeconds = ceil(runCapMs / 1000) + 300`) — a like-for-like
   * port, not a new number (§6.5). */
  export const BACKSTOP_MARGIN_MS = 300_000;

  /** Same `SIGKILL_GRACE_SECONDS = 20` constant the retired bash watchdog
   * used between its own SIGTERM and SIGKILL. */
  export const SIGKILL_GRACE_MS = 20_000;

  export interface SuperviseDeps {
    spawn(
      command: string,
      args: readonly string[],
      opts: { stdio: readonly unknown[] },
    ): {
      pid?: number;
      on(event: string, cb: (arg: unknown) => void): void;
      kill(signal: string): boolean;
    };
    pidfile: DaemonPidfileDeps;
    logs: LogDeps;
    root: string;
    home: string;
    nodeBin: string;
    cliEntry: string;
    runCapMs: number;
    log(event: string, data?: Record<string, unknown>): void;
    setTimeout(cb: () => void, ms: number): { unref?(): void };
    clearTimeout(handle: unknown): void;
  }

  /** Builds the real SpawnRun: one child, `run --profile <p> --headless`,
   * captured to `runs.log`, backstopped, pidfile-tracked. */
  export function createSpawnRun(deps: SuperviseDeps): SpawnRun {
    return (owed: OwedRun) =>
      new Promise<number>((resolve) => {
        // D21/§6.9: rotate BEFORE spawning — the safe quiet point, since
        // D6's sequential-execution guarantee means no other child can be
        // writing to runs.log at this instant.
        const logPath = runsLogPath(deps.home);
        rotateIfLarge(logPath, deps.logs);
        const fd = openAppendFd(logPath, deps.logs);

        const child = deps.spawn(
          deps.nodeBin,
          [deps.cliEntry, 'run', '--profile', owed.profile, '--headless'],
          { stdio: ['ignore', fd, fd] },
        );

        // The child now holds its own reference to the fd via the stdio
        // hand-off above — this process's own copy must be closed here, or
        // a daemon that lives for months (D20 autostart) leaks one fd per
        // spawned run for the rest of its life.
        deps.logs.closeSync(fd);

        // S1: the pid does not exist until spawn() returns, so recording
        // it is necessarily AFTER, not before, the call above. C1: inFlight
        // is the full DaemonInFlight object — pid, profile, and startedAt —
        // not a bare pid, so `serve status` can report which profile is
        // running and for how long, not just a number.
        if (typeof child.pid === 'number') {
          const childPid = child.pid;
          updateDaemonPidfile(
            deps.root,
            (current) => ({
              ...current,
              inFlight: {
                pid: childPid,
                profile: owed.profile,
                startedAt: deps.pidfile.now().toISOString(),
              },
            }),
            deps.pidfile,
          );
        }

        let settled = false;
        let backstop: ReturnType<SuperviseDeps['setTimeout']> | undefined;
        // Tracked in this ENCLOSING scope, not local to the backstop's own
        // callback below — otherwise a child that exits between SIGTERM and
        // SIGKILL_GRACE_MS leaves this nested timer dangling: `finish()`
        // would clear `backstop` (already fired, a no-op) but have no
        // reference to the still-pending SIGKILL timer to clear.
        let killTimer: ReturnType<SuperviseDeps['setTimeout']> | undefined;

        const clearInFlight = (): void => {
          updateDaemonPidfile(
            deps.root,
            (current) => ({ ...current, inFlight: undefined }),
            deps.pidfile,
          );
        };

        const finish = (code: number): void => {
          if (settled) return;
          settled = true;
          if (backstop) deps.clearTimeout(backstop);
          if (killTimer) deps.clearTimeout(killTimer);
          clearInFlight();
          resolve(code);
        };

        // §6.5: a faithful port of the retired plist's embedded bash
        // watchdog — SIGTERM, then SIGKILL after SIGKILL_GRACE_MS if the
        // child is still alive. On Windows, Node emulates both signals as
        // an unconditional terminate, so this escalation collapses to a
        // single hard kill — accepted (D10), no separate code path needed.
        backstop = deps.setTimeout(() => {
          deps.log('backstop-expired', { profile: owed.profile, slot: owed.slot });
          child.kill('SIGTERM');
          killTimer = deps.setTimeout(() => {
            child.kill('SIGKILL');
          }, SIGKILL_GRACE_MS);
          killTimer.unref?.();
        }, deps.runCapMs + BACKSTOP_MARGIN_MS);
        backstop.unref?.();

        child.on('exit', (code: unknown) => {
          finish(typeof code === 'number' ? code : 1);
        });

        // A5/A7: an `error` event (ENOENT, EMFILE) is treated exactly as a
        // nonzero exit — never thrown out of this executor, so it can
        // never kill the daemon. Task 7's ledger append (BEFORE calling
        // this function) already prevents a retry storm here (D19).
        child.on('error', (err: unknown) => {
          deps.log('spawn-error', {
            profile: owed.profile,
            slot: owed.slot,
            error: String(err),
          });
          finish(1);
        });
      });
  }
  ```

- [ ] **Step 13: Run it and see both tests pass.**

  ```bash
  node --test src/ops/daemon/supervise/supervise.test.ts
  ```

  Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 14: Write the remaining four tests.**

  Append to `supervise.test.ts`:

  ```ts
  test('a spawn error event resolves to a nonzero code without throwing (A5/A7)', async () => {
    const child = fakeChild(undefined); // spawn() never produced a pid (ENOENT-shaped).
    const { deps, events } = baseDeps({ spawn: child.spawnArg });
    const promise = createSpawnRun(deps)(OWED);
    await assert.doesNotReject(async () => {
      child.emit('error', new Error('ENOENT'));
      assert.equal(await promise, 1);
    });
    assert.ok(events.some((e) => e.event === 'spawn-error'));
  });

  interface FakeTimerEntry {
    ms: number;
    cb: () => void;
  }

  function fakeTimers(): {
    setTimeout: SuperviseDeps['setTimeout'];
    clearTimeout: SuperviseDeps['clearTimeout'];
    pending: FakeTimerEntry[];
    fireEarliest(): void;
  } {
    const pending: FakeTimerEntry[] = [];
    return {
      pending,
      setTimeout: (cb, ms) => {
        const entry: FakeTimerEntry = { ms, cb };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        const idx = pending.indexOf(handle as FakeTimerEntry);
        if (idx !== -1) pending.splice(idx, 1);
      },
      fireEarliest(): void {
        const entry = pending.shift();
        entry?.cb();
      },
    };
  }

  test('the backstop fires SIGTERM, then SIGKILL after SIGKILL_GRACE_MS, on expiry', async () => {
    const child = fakeChild(9001);
    const timers = fakeTimers();
    const { deps, events } = baseDeps({
      spawn: child.spawnArg,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      runCapMs: 1_000,
    });
    const promise = createSpawnRun(deps)(OWED);
    assert.equal(timers.pending[0]?.ms, 1_000 + BACKSTOP_MARGIN_MS);

    timers.fireEarliest(); // backstop expires.
    assert.deepEqual(child.killCalls, ['SIGTERM']);
    assert.equal(timers.pending[0]?.ms, SIGKILL_GRACE_MS);
    assert.ok(events.some((e) => e.event === 'backstop-expired'));

    timers.fireEarliest(); // SIGKILL_GRACE_MS elapses.
    assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);

    child.emit('exit', 137);
    await promise;
  });

  test('the backstop timer is cleared when the child exits normally', async () => {
    const child = fakeChild(9001);
    const timers = fakeTimers();
    const { deps } = baseDeps({
      spawn: child.spawnArg,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const promise = createSpawnRun(deps)(OWED);
    assert.equal(timers.pending.length, 1);
    child.emit('exit', 0);
    await promise;
    assert.equal(timers.pending.length, 0); // cleared, not merely never fired.
  });

  test('the nested SIGKILL timer is also cleared when the child exits between SIGTERM and SIGKILL_GRACE_MS', async () => {
    const child = fakeChild(9001);
    const timers = fakeTimers();
    const { deps } = baseDeps({
      spawn: child.spawnArg,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      runCapMs: 1_000,
    });
    const promise = createSpawnRun(deps)(OWED);
    assert.equal(timers.pending.length, 1); // just the backstop, so far.

    timers.fireEarliest(); // backstop expires: SIGTERM sent, the nested SIGKILL timer arms.
    assert.deepEqual(child.killCalls, ['SIGTERM']);
    assert.equal(timers.pending.length, 1); // the nested SIGKILL timer, now pending.

    child.emit('exit', 0); // the child dies from SIGTERM before SIGKILL_GRACE_MS elapses.
    await promise;
    assert.equal(timers.pending.length, 0); // the nested timer was cleared too, not left dangling.
  });
  ```

- [ ] **Step 15: Run it and see all six tests pass.**

  ```bash
  node --test src/ops/daemon/supervise/supervise.test.ts
  ```

  Expected: `# pass 6`, `# fail 0` — no implementation change needed.

- [ ] **Step 16: Create the `supervise/` module's public surface.**

  Create `/Users/harishamutha/Job-bunny/src/ops/daemon/supervise/index.ts`:

  ```ts
  export * from './supervise.ts';
  ```

- [ ] **Step 17: Update the `ops/daemon/` module's public surface.**

  Modify `/Users/harishamutha/Job-bunny/src/ops/daemon/index.ts` from:

  ```ts
  export * from './pidfile.ts';
  export * from './daemon.ts';
  ```

  to:

  ```ts
  export * from './pidfile.ts';
  export * from './daemon.ts';
  export * from './supervise/index.ts';
  ```

- [ ] **Step 18: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 19: Commit.**

  ```bash
  git add src/pipeline/stages/budgets.ts src/pipeline/stages/budgets.test.ts src/pipeline/stages/index.ts test/invariants/stage_budgets.test.ts src/cli/commands/run.ts src/ops/daemon/supervise/supervise.ts src/ops/daemon/supervise/supervise.test.ts src/ops/daemon/supervise/index.ts src/ops/daemon/index.ts
  git commit -m "$(cat <<'EOF'
  feat(daemon): add stage timeout budgets + child supervision (real SpawnRun)

  pipeline/stages/budgets.ts collects every stage's timeoutMs/retries
  into one STAGE_BUDGETS table and computeRunCapMs(), replacing
  cli/commands/run.ts's private local copy of the same formula (that
  file now imports and re-exports it, so every existing call site and
  test keeps working unchanged). test/invariants/stage_budgets.test.ts
  is the drift guard: it constructs the real stage factories with
  never-invoked stub ports — fragile, deliberately confined to a test —
  and asserts they match STAGE_BUDGETS exactly, so an unmirrored
  stage-timeout change fails in CI rather than silently shortening the
  daemon's run-cap backstop.

  createSpawnRun builds `<nodeBin> <cliEntry> run --profile <p>
  --headless`, rotating runs.log immediately before each spawn (D21,
  the one safe quiet point under D6's sequential-execution guarantee)
  so the three early-abort paths in cli/commands/run.ts that write only
  to console.error stay diagnosable. Records/clears the pidfile's
  inFlight pid around the child's lifetime, treats a spawn `error`
  event exactly as a nonzero exit rather than an uncaught throw (A7),
  and arms a SIGTERM-then-SIGKILL backstop timer that faithfully ports
  the retired launchd plist's embedded bash watchdog — same +300s
  margin, same 20s grace, not a new policy (§6.5). runCapMs is always
  supplied by the caller, derived from computeRunCapMs(), never
  hardcoded here (A12).

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 9: `serve start` / `stop` / `status`

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/cli/commands/serve.ts`
- Create: `/Users/harishamutha/Job-bunny/src/cli/commands/serve.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/cli/main.ts`

**Interfaces:**

Consumes: `acquireDaemonPidfile`, `readDaemonPidfile`, `updateDaemonPidfile`, `releaseDaemonPidfile`, `isDaemonPidfileStale`, `HEARTBEAT_STALE_MS`, `DaemonPidfileDeps`, `defaultDaemonPidfileDeps`, `createDaemon`, `DaemonDeps`, `createSpawnRun`, `SuperviseDeps`, `SIGKILL_GRACE_MS` from `../../ops/daemon/index.ts`; `scanProfileSchedules`, `scanRunHistory`, `ScanDeps`, `defaultScanDeps` from `../../ops/daemon/scan/index.ts`; `daemonLogPath`, `rotateIfLarge`, `openAppendFd`, `LogDeps`, `defaultLogDeps` from `../../ops/daemon/logs/index.ts`; `isRunOwed`, `nextFireAt`, `formatLocalDate` from `../../core/schedule/index.ts`; `computeRunCapMs` from `../../pipeline/stages/budgets.ts` (Task 8).

**Design note (runCapMs derivation) — a judgment call this task must make, not left implicit:** `SuperviseDeps.runCapMs` (Task 8) must come from `computeRunCapMs()` (A12), but the daemon is cross-profile (D6) and, per D3, `ops/daemon/**` may not import `cli/wire.ts` (only `cli/wire.ts` may import `src/adapters/**`, and nothing may import `cli` at all) — so it cannot `wire()` a real profile to get a live `stages` array the way `cli/commands/run.ts` does for itself. `serve` is cross-profile and therefore cannot call `wire(profile)`, which is why the run cap comes from the static budget table (`STAGE_BUDGETS`, `pipeline/stages/budgets.ts`, Task 8) rather than from wired stages — this file calls `computeRunCapMs()` with no arguments, defaulting to that table. The figure is derived, never hardcoded: `STAGE_BUDGETS` is drift-guarded by `test/invariants/stage_budgets.test.ts` from Task 8, which fails CI the moment a stage factory's real `timeoutMs`/`retries` moves without a matching edit to `STAGE_BUDGETS`, so the daemon's backstop can never silently fall below the real worst case.

Produces:
```ts
export interface SpawnHandle {
  pid?: number;
  on(event: string, cb: (arg: unknown) => void): void;
  kill(signal: string): boolean;
  unref?(): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { stdio: readonly unknown[]; detached?: boolean },
) => SpawnHandle;

export interface ServeDeps {
  root: string;
  home: string;
  platform: NodeJS.Platform;
  uid: number | undefined;
  pid: number;
  profilesDir: string;
  pidfile: DaemonPidfileDeps;
  logs: LogDeps;
  scan: ScanDeps;
  listLaunchAgentFiles(): string[];
  spawn: SpawnFn;
  nodeBin: string;
  cliEntry: string;
  pidIsAlive(pid: number): boolean;
  killPid(pid: number, signal: string): void;
  now(): Date;
  sleep(ms: number): Promise<void>;
  readDaemonLogTail(): string;
  write(line: string): void;
  writeErr(line: string): void;
}

export type ServeAction = 'start' | 'stop' | 'status';

export interface ServeCommandOptions {
  action: ServeAction;
  daemonChild?: boolean;
}

export function serveCommand(
  opts: ServeCommandOptions,
  overrides?: Partial<ServeDeps>,
): Promise<number>;
```

Behavior, matching §6.1/§6.2/§6.7/§8/D10/D15/D22/A15.4 exactly:

1. **`serve start` (no `--daemon-child`, the parent).** On darwin, scans `~/Library/LaunchAgents/` for `^com\.jobbunny\.\d{4}\.plist$` (four digits — deliberately excludes `com.jobbunny.autostart.plist`, Task 10's file). Any match ⇒ refuse (exit 1), printing a ready-to-paste `launchctl bootout gui/<uid>/<label>` + `rm <path>` block, one pair per plist, sorted by filename. No `launchd` code is retained for this — a directory read plus printed strings. Then acquires the daemon pidfile with `acquireDaemonPidfile(root, pid, pidfileDeps)`, writing the PARENT's own pid as the placeholder. On acquisition failure: read the existing pidfile; if it is NOT stale, print the holder's pid/`startedAt` and exit 1 without touching it. If it IS stale (`isDaemonPidfileStale`) and the recorded pid is alive, wait `STEAL_RECHECK_WAIT_MS` (35s — one 30s tick plus a 5s margin) and re-read: if `lastTickAt` advanced, it was just woken from sleep, not dead — refuse, exit 1. Only when the pid is confirmed dead (immediately, no wait) or the re-check still shows no advance does it release and re-acquire. Then rotates `daemon.log` (start-only rotation, per Task 6/D21), opens its append fd, spawns `spawn(nodeBin, [cliEntry, 'serve', 'start', '--daemon-child'], { stdio: ['ignore', fd, fd], detached: true })`, closes its own fd copy, records the child's pid into the pidfile (overwriting the placeholder — necessarily after `spawn()` returns), attaches an `error` handler (same already-dead path below), waits 2s, and confirms liveness via `pidIsAlive`. Alive ⇒ print success, exit 0. Dead (or errored) ⇒ remove the pidfile it created, print the tail of `daemon.log`, exit 1. B3: the staleness probe consulted by `isDaemonPidfileStale` is the PIDFILE deps' OWN `pidIsAlive` (`deps.pidfile.pidIsAlive`), a distinct injection point from `ServeDeps.pidIsAlive` (used only for the separate post-steal-decision liveness check, and for the 2s alive-confirm below) — `defaultServeDeps` wires both to the SAME real `process.kill` probe so they never disagree in production, but a test that overrides one without the other will exercise a code path that doesn't match its intent; tests must keep the two views consistent.
2. **`serve start --daemon-child`.** Does NOT touch the pidfile's create step — the parent already owns and populated it. Derives `runCapMs` via `computeRunCapMs()` (see the design note above), builds `SuperviseDeps` and `DaemonDeps`, calls `createDaemon(daemonDeps).start()`, and resolves its own returned promise only once a `SIGINT`/`SIGTERM` handler fires `daemon.stop()` — this is what makes the process a genuine foreground daemon rather than a one-shot command. B1: the shutdown handler does NOT also release the pidfile — pidfile removal belongs exclusively to `serve stop` (item 3 below), after it has confirmed BOTH the daemon and any `inFlight` child are dead. A child that releases its own pidfile on SIGTERM would delete it out from under `serve stop`'s re-read, so the in-flight child it's supposed to also kill would never be found; a daemon that dies any other way just leaves a dead-pid pidfile that D22's staleness rule self-heals.
3. **`serve stop`.** Reads the pidfile for the daemon pid. `SIGTERM`, poll (not a fixed sleep) until dead or `SIGKILL_GRACE_MS` (20s, reused from Task 8 — same constant, not a second one), then `SIGKILL`, poll again. If still alive: exit 1, leave the pidfile, print the pid. Only then RE-READS the pidfile for `inFlight` (safe: a dead daemon cannot write again) and applies the identical escalation to it if a pid is recorded and alive. Only once both are confirmed dead: remove the pidfile, exit 0. `ESRCH` anywhere is already-dead, not an error (`pidIsAlive`/`killPid` absorb it).
4. **`serve status`.** Read-only — never mutates the pidfile. Reports running/not-running, pid + uptime, `lastTickAt` + a "wedged" flag when older than `HEARTBEAT_STALE_MS`, the `inFlight` child (if any — C1: pid, profile, AND elapsed time, not a bare pid), the next scheduled slot(s) via `nextFireAt`, and any currently-owed runs via `isRunOwed` fed the SAME disk-history-plus-ledger merge `daemon.ts`'s own tick uses (D19) — not disk history alone, which would over-report a slot that a synthetic ledger entry already served.

`serve` takes NO `--profile` — cross-profile by design (D6), the same posture `schedule install` has today. `--daemon-child` is internal-only, deliberately omitted from `USAGE`.

- [ ] **Step 1: Write the first three failing tests plus the shared fakes.**

  Create `/Users/harishamutha/Job-bunny/src/cli/commands/serve.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { acquireDaemonPidfile, readDaemonPidfile } from '../../ops/daemon/index.ts';
  import type { DaemonPidfileDeps } from '../../ops/daemon/index.ts';
  import type { LogDeps } from '../../ops/daemon/logs/index.ts';
  import type { ScanDeps } from '../../ops/daemon/scan/index.ts';
  import { serveCommand } from './serve.ts';
  import type { ServeDeps, SpawnFn, SpawnHandle } from './serve.ts';

  const ROOT = '/fake/root';
  const HOME = '/fake/home';

  function fakePidfileDeps(): DaemonPidfileDeps {
    const files = new Map<string, string>();
    const notFound = (): never => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    return {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => files.get(p) ?? notFound(),
      writeFileSync: (p, data) => {
        files.set(p, data);
      },
      writeFileSyncExclusive: (p, data) => {
        if (files.has(p)) return false;
        files.set(p, data);
        return true;
      },
      renameSync: (from, to) => {
        const content = files.get(from) ?? notFound();
        files.delete(from);
        files.set(to, content);
      },
      unlinkSync: (p) => {
        files.delete(p);
      },
      pidIsAlive: () => true,
      now: () => new Date(),
    };
  }

  function fakeLogDeps(): LogDeps {
    return {
      existsSync: () => true,
      mkdirSync: () => {},
      statSync: () => ({ size: 0 }),
      renameSync: () => {},
      openSync: () => 42,
      closeSync: () => {},
    };
  }

  function fakeScanDeps(): ScanDeps {
    return {
      existsSync: () => false,
      readdirSync: () => [],
      readFileSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    };
  }

  function fakeChildHandle(pid: number | undefined): {
    handle: SpawnHandle;
    emit(event: string, arg?: unknown): void;
    killCalls: string[];
  } {
    const listeners = new Map<string, Array<(arg: unknown) => void>>();
    const killCalls: string[] = [];
    const handle: SpawnHandle = {
      pid,
      on(event, cb) {
        const arr = listeners.get(event) ?? [];
        arr.push(cb);
        listeners.set(event, arr);
      },
      kill(signal) {
        killCalls.push(signal);
        return true;
      },
      unref() {},
    };
    return {
      handle,
      emit(event, arg) {
        for (const cb of listeners.get(event) ?? []) cb(arg);
      },
      killCalls,
    };
  }

  function baseServeDeps(overrides: Partial<ServeDeps> = {}): {
    deps: ServeDeps;
    writes: string[];
    errs: string[];
    sleeps: number[];
  } {
    const writes: string[] = [];
    const errs: string[] = [];
    const sleeps: number[] = [];
    const child = fakeChildHandle(9001);
    const spawn: SpawnFn = () => child.handle;
    const deps: ServeDeps = {
      root: ROOT,
      home: HOME,
      platform: 'darwin',
      uid: 501,
      pid: 100,
      profilesDir: '/fake/profiles',
      pidfile: fakePidfileDeps(),
      logs: fakeLogDeps(),
      scan: fakeScanDeps(),
      listLaunchAgentFiles: () => [],
      spawn,
      nodeBin: 'node',
      cliEntry: 'src/cli/main.ts',
      pidIsAlive: () => true,
      killPid: () => {},
      now: () => new Date(2026, 6, 27, 14, 4),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      readDaemonLogTail: () => '(log tail)',
      write: (line) => writes.push(line),
      writeErr: (line) => errs.push(line),
      ...overrides,
    };
    return { deps, writes, errs, sleeps };
  }

  test('start: refuses when a legacy launchd plist is found, and prints a cleanup block', async () => {
    const { deps, errs } = baseServeDeps({
      listLaunchAgentFiles: () => ['com.jobbunny.0900.plist', 'com.jobbunny.autostart.plist'],
    });
    const code = await serveCommand({ action: 'start' }, deps);
    assert.equal(code, 1);
    const printed = errs.join('\n');
    assert.match(printed, /com\.jobbunny\.0900/);
    assert.doesNotMatch(printed, /com\.jobbunny\.autostart/);
    assert.match(printed, /launchctl bootout gui\/501\/com\.jobbunny\.0900/);
  });

  test('start: an autostart-only LaunchAgents dir does not trigger the migration refusal', async () => {
    const { deps } = baseServeDeps({
      listLaunchAgentFiles: () => ['com.jobbunny.autostart.plist'],
    });
    const code = await serveCommand({ action: 'start' }, deps);
    assert.equal(code, 0);
  });

  test('start: acquisition failure against a live, fresh daemon exits nonzero without stealing', async () => {
    const pidfile = fakePidfileDeps();
    acquireDaemonPidfile(ROOT, 999, pidfile); // a fresh, live "other" daemon.
    const { deps, sleeps } = baseServeDeps({ pidfile, pidIsAlive: () => true });
    const code = await serveCommand({ action: 'start' }, deps);
    assert.equal(code, 1);
    assert.equal(readDaemonPidfile(ROOT, pidfile)?.pid, 999); // untouched.
    assert.deepEqual(sleeps, []); // no steal attempt, no re-check wait.
  });
  ```

- [ ] **Step 2: Run it and see it fail because `serve.ts` does not exist yet.**

  ```bash
  node --test src/cli/commands/serve.test.ts
  ```

  Expected failure: `Cannot find module '.../cli/commands/serve.ts'`.

- [ ] **Step 3: Implement `serve.ts` in full.**

  Create `/Users/harishamutha/Job-bunny/src/cli/commands/serve.ts`:

  ```ts
  /**
   * cli/commands/serve.ts (D2, D6) — `serve start|stop|status`, replacing
   * `schedule install`/`schedule remove` (Task 12 deletes the latter; both
   * commands coexist until then, per this plan's task ordering). NO
   * `--profile` — cross-profile by design, the same posture `schedule
   * install` had. `start` splits into a PARENT (acquires the pidfile,
   * spawns a detached child, confirms it's alive, exits) and a CHILD
   * (`--daemon-child`, runs the tick loop in the foreground) — §6.1/S3.
   *
   * No `src/adapters/**` import here — the daemon spawns `jobbunny run` as
   * a plain child process (D3); this file never touches an adapter, and
   * derives its one adapter-adjacent number (`runCapMs`) from the pipeline's
   * own static `STAGE_BUDGETS` table (`pipeline/stages/budgets.ts`, Task 8,
   * not an adapter) rather than `cli/wire.ts` — see the plan's Task 9
   * design note, and Task 8's `test/invariants/stage_budgets.test.ts` for
   * the drift guard that keeps that table honest.
   */
  import { spawn as nodeSpawn } from 'node:child_process';
  import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from 'node:fs';
  import { homedir } from 'node:os';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { formatLocalDate, isRunOwed, nextFireAt } from '../../core/schedule/index.ts';
  import {
    acquireDaemonPidfile,
    createDaemon,
    createSpawnRun,
    type DaemonDeps,
    type DaemonPidfileDeps,
    defaultDaemonPidfileDeps,
    HEARTBEAT_STALE_MS,
    isDaemonPidfileStale,
    readDaemonPidfile,
    releaseDaemonPidfile,
    SIGKILL_GRACE_MS,
    type SuperviseDeps,
    updateDaemonPidfile,
  } from '../../ops/daemon/index.ts';
  import {
    daemonLogPath,
    defaultLogDeps,
    type LogDeps,
    openAppendFd,
    rotateIfLarge,
  } from '../../ops/daemon/logs/index.ts';
  import {
    defaultScanDeps,
    type ScanDeps,
    scanProfileSchedules,
    scanRunHistory,
  } from '../../ops/daemon/scan/index.ts';
  import { computeRunCapMs } from '../../pipeline/stages/budgets.ts';

  const LEGACY_PLIST_REGEX = /^com\.jobbunny\.\d{4}\.plist$/;
  /** One 30s tick plus a 5s margin (D22/A15.4) — see `isDaemonPidfileStale`'s
   * own doc comment for why an alive-but-stale-heartbeat pid isn't stolen
   * on first observation. */
  const STEAL_RECHECK_WAIT_MS = 35_000;
  const CHILD_ALIVE_CHECK_MS = 2_000;
  const POLL_INTERVAL_MS = 250;

  function hasCode(err: unknown, code: string): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === code
    );
  }

  export interface SpawnHandle {
    pid?: number;
    on(event: string, cb: (arg: unknown) => void): void;
    kill(signal: string): boolean;
    unref?(): void;
  }

  export type SpawnFn = (
    command: string,
    args: readonly string[],
    opts: { stdio: readonly unknown[]; detached?: boolean },
  ) => SpawnHandle;

  export interface ServeDeps {
    root: string;
    home: string;
    platform: NodeJS.Platform;
    uid: number | undefined;
    pid: number;
    profilesDir: string;
    pidfile: DaemonPidfileDeps;
    logs: LogDeps;
    scan: ScanDeps;
    listLaunchAgentFiles(): string[];
    spawn: SpawnFn;
    nodeBin: string;
    cliEntry: string;
    pidIsAlive(pid: number): boolean;
    killPid(pid: number, signal: string): void;
    now(): Date;
    sleep(ms: number): Promise<void>;
    readDaemonLogTail(): string;
    write(line: string): void;
    writeErr(line: string): void;
  }

  export type ServeAction = 'start' | 'stop' | 'status';

  export interface ServeCommandOptions {
    action: ServeAction;
    daemonChild?: boolean;
  }

  function defaultServeDeps(): ServeDeps {
    const root = process.cwd();
    const home = homedir();
    // B3: built once, then reused for BOTH `pidfile.pidIsAlive` (the
    // staleness probe `isDaemonPidfileStale` actually consults) and the
    // top-level `pidIsAlive` below (the separate post-steal-decision and
    // 2s-alive-confirm checks) — the SAME `process.kill`-based probe wired
    // to both injection points, never two independently-written copies
    // that could silently drift apart.
    const pidfileDeps = defaultDaemonPidfileDeps();
    return {
      root,
      home,
      platform: process.platform,
      uid: process.getuid?.(),
      pid: process.pid,
      profilesDir: path.join(root, 'profiles'),
      pidfile: pidfileDeps,
      logs: defaultLogDeps(),
      scan: defaultScanDeps(),
      listLaunchAgentFiles: () => {
        try {
          return fsReaddirSync(path.join(home, 'Library', 'LaunchAgents'));
        } catch {
          return [];
        }
      },
      spawn: (command, args, opts) =>
        nodeSpawn(command, args, {
          stdio: opts.stdio as ['ignore', number, number],
          detached: opts.detached,
        }) as unknown as SpawnHandle,
      nodeBin: process.execPath,
      cliEntry: fileURLToPath(new URL('../main.ts', import.meta.url)),
      pidIsAlive: pidfileDeps.pidIsAlive,
      killPid: (pid, signal) => {
        try {
          process.kill(pid, signal as NodeJS.Signals);
        } catch (err) {
          if (!hasCode(err, 'ESRCH')) throw err;
        }
      },
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      readDaemonLogTail: () => {
        try {
          const raw = fsReadFileSync(daemonLogPath(home), 'utf8');
          return raw.split('\n').slice(-20).join('\n');
        } catch {
          return '(no daemon.log yet)';
        }
      },
      write: (line) => console.log(line),
      writeErr: (line) => console.error(line),
    };
  }

  /** D15/§8 — a directory read plus printed strings; no `launchd` code. */
  function migrationCleanupBlock(files: string[], uid: number | undefined): string {
    const lines = [
      `serve start: found ${files.length} leftover launchd job(s) from the old scheduler. Run this first:`,
      '',
    ];
    for (const file of [...files].sort()) {
      const label = file.replace(/\.plist$/, '');
      lines.push(`launchctl bootout gui/${uid ?? '<uid>'}/${label}`);
      lines.push(`rm ~/Library/LaunchAgents/${file}`);
    }
    lines.push('', 'Then re-run: jobbunny serve start');
    return lines.join('\n');
  }

  function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h}h${m}m${s}s`;
  }

  async function runServeStartParent(deps: ServeDeps): Promise<number> {
    if (deps.platform === 'darwin') {
      const legacy = deps
        .listLaunchAgentFiles()
        .filter((f) => LEGACY_PLIST_REGEX.test(f));
      if (legacy.length > 0) {
        deps.writeErr(migrationCleanupBlock(legacy, deps.uid));
        return 1;
      }
    }

    let acquired = acquireDaemonPidfile(deps.root, deps.pid, deps.pidfile);
    if (!acquired) {
      const existing = readDaemonPidfile(deps.root, deps.pidfile);
      if (!isDaemonPidfileStale(existing, deps.pidfile)) {
        deps.writeErr(
          `serve start: a daemon is already running (pid ${existing?.pid}, started ${existing?.startedAt})`,
        );
        return 1;
      }
      // D22/A15.4: an alive-but-stale-heartbeat pid gets one re-check,
      // 35s later, before stealing — a machine that just woke from sleep
      // legitimately shows a stale heartbeat for up to one tick. A dead
      // pid steals immediately, no wait.
      const observedHeartbeat = existing?.lastTickAt;
      if (existing && deps.pidIsAlive(existing.pid)) {
        await deps.sleep(STEAL_RECHECK_WAIT_MS);
        const recheck = readDaemonPidfile(deps.root, deps.pidfile);
        if (recheck && recheck.lastTickAt !== observedHeartbeat) {
          deps.writeErr(
            `serve start: a daemon is already running (pid ${recheck.pid}, started ${recheck.startedAt})`,
          );
          return 1;
        }
      }
      // S3: `releaseDaemonPidfile` below is an unconditional unlink, so two
      // `serve start`s that both reach this point (both passed the 35s
      // re-check, or both observed the same dead pid) could otherwise
      // release/acquire over each other — the second unlinking the
      // first's freshly-created pidfile. One more re-read, immediately
      // before the release, narrows that window to a residual
      // microsecond-scale race (accepted, the same posture as
      // `run_lock`'s own bounded steal) rather than the multi-tens-of-
      // seconds window the 35s wait alone would leave open.
      const finalCheck = readDaemonPidfile(deps.root, deps.pidfile);
      if (finalCheck && finalCheck.lastTickAt !== observedHeartbeat) {
        deps.writeErr(
          `serve start: a daemon is already running (pid ${finalCheck.pid}, started ${finalCheck.startedAt})`,
        );
        return 1;
      }
      releaseDaemonPidfile(deps.root, deps.pidfile);
      acquired = acquireDaemonPidfile(deps.root, deps.pid, deps.pidfile);
      if (!acquired) {
        deps.writeErr('serve start: could not acquire the daemon pidfile');
        return 1;
      }
    }

    const logPath = daemonLogPath(deps.home);
    rotateIfLarge(logPath, deps.logs); // start-only rotation (Task 6/D21).
    const fd = openAppendFd(logPath, deps.logs);

    const child = deps.spawn(
      deps.nodeBin,
      [deps.cliEntry, 'serve', 'start', '--daemon-child'],
      { stdio: ['ignore', fd, fd], detached: true },
    );
    deps.logs.closeSync(fd);

    let spawnErrored = false;
    child.on('error', () => {
      spawnErrored = true;
    });

    if (typeof child.pid === 'number') {
      const childPid = child.pid;
      updateDaemonPidfile(
        deps.root,
        (current) => ({ ...current, pid: childPid }),
        deps.pidfile,
      );
    }
    child.unref?.();

    await deps.sleep(CHILD_ALIVE_CHECK_MS);
    const alive =
      typeof child.pid === 'number' && !spawnErrored && deps.pidIsAlive(child.pid);
    if (!alive) {
      releaseDaemonPidfile(deps.root, deps.pidfile);
      deps.writeErr(
        `serve start: daemon child died immediately — tail of daemon.log:\n${deps.readDaemonLogTail()}`,
      );
      return 1;
    }
    deps.write(`serve start: daemon running (pid ${child.pid})`);
    return 0;
  }

  async function runServeStartChild(deps: ServeDeps): Promise<number> {
    const runCapMs = computeRunCapMs();
    const log = (event: string, data?: Record<string, unknown>): void => {
      // Lands in daemon.log via the parent's stdio redirection (§6.1) —
      // this process's own stdout was already pointed at the fd before
      // spawn(), so a plain console.log is all that's needed here.
      console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
    };

    const superviseDeps: SuperviseDeps = {
      spawn: deps.spawn,
      pidfile: deps.pidfile,
      logs: deps.logs,
      root: deps.root,
      home: deps.home,
      nodeBin: deps.nodeBin,
      cliEntry: deps.cliEntry,
      runCapMs,
      log,
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };

    const daemonDeps: DaemonDeps = {
      root: deps.root,
      profilesDir: deps.profilesDir,
      scan: deps.scan,
      pidfile: deps.pidfile,
      spawnRun: createSpawnRun(superviseDeps),
      log,
      now: () => new Date(),
    };

    const daemon = createDaemon(daemonDeps);
    daemon.start();

    // §6.1: the child's only job is the tick loop — it never touches the
    // pidfile's create step (the parent already did) and resolves only on
    // a shutdown signal. B1: the shutdown handler does NOT release the
    // pidfile — removal belongs exclusively to `serve stop`, and only
    // after BOTH the daemon and any in-flight child are confirmed dead
    // (`runServeStop` below). Releasing it here would delete the pidfile
    // the instant SIGTERM lands, so `serve stop`'s own re-read (which
    // finds the `inFlight` child to kill) would find nothing and a
    // still-running child would survive a successful stop. A daemon that
    // dies any other way (crash, kill -9) simply leaves a dead-pid pidfile
    // behind — D22's staleness rule (`isDaemonPidfileStale`) self-heals
    // that on the next `serve start`.
    return new Promise<number>((resolve) => {
      const shutdown = (): void => {
        daemon.stop();
        resolve(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  }

  async function waitUntilDead(
    pid: number,
    graceMs: number,
    deps: ServeDeps,
  ): Promise<boolean> {
    const maxAttempts = Math.ceil(graceMs / POLL_INTERVAL_MS);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!deps.pidIsAlive(pid)) return true;
      await deps.sleep(POLL_INTERVAL_MS);
    }
    return !deps.pidIsAlive(pid);
  }

  /** SIGTERM → poll until dead or SIGKILL_GRACE_MS → SIGKILL → poll again.
   * `ESRCH` at any step is already-dead, not an error (absorbed by
   * `pidIsAlive`/`killPid`). Reused for both the daemon and its `inFlight`
   * child (D10) — same constant, not a second one. */
  async function killAndConfirmDead(pid: number, deps: ServeDeps): Promise<boolean> {
    if (!deps.pidIsAlive(pid)) return true;
    deps.killPid(pid, 'SIGTERM');
    if (await waitUntilDead(pid, SIGKILL_GRACE_MS, deps)) return true;
    deps.killPid(pid, 'SIGKILL');
    return waitUntilDead(pid, SIGKILL_GRACE_MS, deps);
  }

  async function runServeStop(deps: ServeDeps): Promise<number> {
    const file = readDaemonPidfile(deps.root, deps.pidfile);
    if (!file) {
      deps.write('serve stop: no daemon pidfile found — nothing to stop');
      return 0;
    }

    // D10: daemon FIRST. Killing the child first would let the daemon's
    // own `await` on it resolve and spawn the NEXT owed run before the
    // daemon's own SIGTERM lands, orphaning that next child.
    const daemonDead = await killAndConfirmDead(file.pid, deps);
    if (!daemonDead) {
      deps.writeErr(`serve stop: daemon (pid ${file.pid}) survived SIGKILL`);
      return 1;
    }

    // Safe to re-read now: a dead daemon cannot spawn or write to the
    // pidfile again, so its last write is authoritative. B1: this re-read
    // is exactly why the daemon child's own shutdown handler must NOT
    // release the pidfile on SIGTERM — if it did, this read would find
    // nothing and the in-flight child below would never be found or killed.
    const after = readDaemonPidfile(deps.root, deps.pidfile);
    if (after?.inFlight !== undefined) {
      const childDead = await killAndConfirmDead(after.inFlight.pid, deps);
      if (!childDead) {
        deps.writeErr(
          `serve stop: in-flight child (pid ${after.inFlight.pid}) survived SIGKILL`,
        );
        return 1;
      }
    }

    releaseDaemonPidfile(deps.root, deps.pidfile);
    deps.write('serve stop: daemon stopped');
    return 0;
  }

  async function runServeStatus(deps: ServeDeps): Promise<number> {
    const file = readDaemonPidfile(deps.root, deps.pidfile);
    if (!file || !deps.pidIsAlive(file.pid)) {
      deps.write('serve status: not running');
      return 1;
    }

    const now = deps.now();
    deps.write(
      `serve status: running (pid ${file.pid}, uptime ${formatDuration(now.getTime() - Date.parse(file.startedAt))})`,
    );

    const heartbeatAgeMs = now.getTime() - Date.parse(file.lastTickAt);
    const wedged = heartbeatAgeMs > HEARTBEAT_STALE_MS;
    deps.write(
      `  last tick: ${file.lastTickAt} (${formatDuration(heartbeatAgeMs)} ago)` +
        (wedged ? ' — appears wedged' : ''),
    );
    // §6.1: reports the profile and elapsed time, not just the pid — the
    // bare `pid ${n}` form told an operator nothing about WHICH profile
    // was running or for how long.
    deps.write(
      file.inFlight !== undefined
        ? `  in flight: pid ${file.inFlight.pid} (profile ${file.inFlight.profile}, running ` +
            `${formatDuration(now.getTime() - Date.parse(file.inFlight.startedAt))})`
        : '  in flight: none',
    );

    const schedules = scanProfileSchedules(deps.profilesDir, deps.scan);
    const next = nextFireAt(now, schedules);
    deps.write(
      next
        ? `  next fire: ${next.at.toISOString()} (${next.runs.map((r) => r.profile).join(', ')})`
        : '  next fire: none scheduled',
    );

    // D19: the same disk-history-plus-ledger merge daemon.ts's own tick
    // uses — disk history alone would over-report a slot a synthetic
    // ledger entry already served.
    const date = formatLocalDate(now);
    const diskHistory = scanRunHistory(
      deps.profilesDir,
      schedules.map((s) => s.profile),
      date,
      deps.scan,
    );
    const ledgerHistory = file.attempts
      .filter((a) => a.date === date)
      .map((a) => ({ profile: a.profile, date: a.date, startedAt: a.slot }));
    const owed = isRunOwed(now, schedules, [...diskHistory, ...ledgerHistory]);
    if (owed.length > 0) {
      deps.write(`  currently owed: ${owed.map((o) => `${o.profile}@${o.slot}`).join(', ')}`);
    }

    return 0;
  }

  export async function serveCommand(
    opts: ServeCommandOptions,
    overrides: Partial<ServeDeps> = {},
  ): Promise<number> {
    const deps: ServeDeps = { ...defaultServeDeps(), ...overrides };
    switch (opts.action) {
      case 'start':
        return opts.daemonChild ? runServeStartChild(deps) : runServeStartParent(deps);
      case 'stop':
        return runServeStop(deps);
      case 'status':
        return runServeStatus(deps);
    }
  }
  ```

- [ ] **Step 4: Run it and see all three tests pass.**

  ```bash
  node --test src/cli/commands/serve.test.ts
  ```

  Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Write the remaining five tests.**

  Append to `serve.test.ts`:

  ```ts
  test('start: a dead pid steals immediately — no 35s re-check wait', async () => {
    const pidfile = fakePidfileDeps();
    acquireDaemonPidfile(ROOT, 999, pidfile); // the "other" daemon's placeholder.
    // B3: staleness is decided by isDaemonPidfileStale(existing,
    // deps.pidfile) inside runServeStartParent — the PIDFILE deps' OWN
    // pidIsAlive, not ServeDeps.pidIsAlive (a separate, later check). Both
    // must agree pid 999 is dead, or the code takes the "still running,
    // refuse" branch before ever reaching the steal path.
    pidfile.pidIsAlive = (pid) => pid !== 999;
    const { deps, sleeps } = baseServeDeps({
      pidfile,
      pidIsAlive: (pid) => pid !== 999, // 999 is dead; the spawned child (9001) is alive.
    });
    const code = await serveCommand({ action: 'start' }, deps);
    assert.equal(code, 0);
    assert.equal(readDaemonPidfile(ROOT, pidfile)?.pid, 9001); // stolen and re-recorded.
    assert.ok(!sleeps.includes(35_000)); // no re-check wait for a dead pid.
  });

  test('stop: kills the daemon before the in-flight child, re-reading the pidfile between them', async () => {
    const pidfile = fakePidfileDeps();
    acquireDaemonPidfile(ROOT, 1000, pidfile);
    updateDaemonPidfile(
      ROOT,
      (c) => ({
        ...c,
        inFlight: { pid: 2000, profile: 'harish', startedAt: pidfile.now().toISOString() },
      }),
      pidfile,
    );
    const killOrder: string[] = [];
    const alive = new Set([1000, 2000]);
    const { deps } = baseServeDeps({
      pidfile,
      pidIsAlive: (pid) => alive.has(pid),
      killPid: (pid, signal) => {
        killOrder.push(`${pid}:${signal}`);
        if (signal === 'SIGTERM') alive.delete(pid); // dies promptly on SIGTERM.
      },
    });
    const code = await serveCommand({ action: 'stop' }, deps);
    assert.equal(code, 0);
    assert.deepEqual(killOrder, ['1000:SIGTERM', '2000:SIGTERM']); // daemon, then child.
    assert.equal(readDaemonPidfile(ROOT, pidfile), undefined); // pidfile removed.
  });

  test('stop: exits nonzero and leaves the pidfile when the daemon survives SIGKILL', async () => {
    const pidfile = fakePidfileDeps();
    acquireDaemonPidfile(ROOT, 1000, pidfile);
    const { deps, errs } = baseServeDeps({
      pidfile,
      pidIsAlive: () => true, // never dies, however hard we try.
    });
    const code = await serveCommand({ action: 'stop' }, deps);
    assert.equal(code, 1);
    assert.ok(errs.some((e) => e.includes('survived SIGKILL')));
    assert.notEqual(readDaemonPidfile(ROOT, pidfile), undefined); // left in place.
  });

  test('stop: the pidfile still contains inFlight after the daemon process has already exited, and stop kills that pid (B1)', async () => {
    const pidfile = fakePidfileDeps();
    acquireDaemonPidfile(ROOT, 1000, pidfile);
    updateDaemonPidfile(
      ROOT,
      (c) => ({
        ...c,
        inFlight: { pid: 4000, profile: 'harish', startedAt: pidfile.now().toISOString() },
      }),
      pidfile,
    );
    // Simulates the daemon having already exited (crashed, or its own
    // SIGTERM shutdown handler already ran) WITHOUT releasing the
    // pidfile — per B1, release belongs exclusively to `serve stop`. Only
    // the in-flight child (4000) is alive; the daemon (1000) is already
    // dead, so `stop` must still find and kill the surviving child from
    // the persisted file rather than short-circuit on "no pidfile found".
    const alive = new Set([4000]);
    const killOrder: string[] = [];
    const { deps } = baseServeDeps({
      pidfile,
      pidIsAlive: (pid) => alive.has(pid),
      killPid: (pid, signal) => {
        killOrder.push(`${pid}:${signal}`);
        if (signal === 'SIGTERM') alive.delete(pid);
      },
    });
    assert.equal(readDaemonPidfile(ROOT, pidfile)?.inFlight?.pid, 4000); // still present pre-stop.
    const code = await serveCommand({ action: 'stop' }, deps);
    assert.equal(code, 0);
    assert.ok(killOrder.includes('4000:SIGTERM')); // the in-flight child was found and killed.
    assert.equal(readDaemonPidfile(ROOT, pidfile), undefined);
  });

  test('status: renders pid/uptime, last-tick, in-flight (profile + elapsed), and next-fire lines', async () => {
    const pidfile = fakePidfileDeps();
    acquireDaemonPidfile(ROOT, 1000, pidfile);
    updateDaemonPidfile(
      ROOT,
      (c) => ({
        ...c,
        inFlight: {
          pid: 3000,
          profile: 'harish',
          startedAt: new Date(2026, 6, 27, 14, 0).toISOString(),
        },
        lastTickAt: new Date(2026, 6, 27, 14, 3).toISOString(),
      }),
      pidfile,
    );
    const scan: ScanDeps = {
      existsSync: (p) => p === '/fake/profiles',
      readdirSync: (p) => (p === '/fake/profiles' ? ['harish'] : []),
      readFileSync: (p) =>
        p === '/fake/profiles/harish/profile.json'
          ? JSON.stringify({
              connector: 'notion',
              schedule: {
                times: ['16:30'],
                enabled: true,
                weekdays: [1, 2, 3, 4, 5],
                graceMinutes: 90,
              },
            })
          : (() => {
              const err = new Error('ENOENT') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              throw err;
            })(),
    };
    const { deps, writes } = baseServeDeps({ pidfile, scan, profilesDir: '/fake/profiles' });
    const code = await serveCommand({ action: 'status' }, deps);
    assert.equal(code, 0);
    const printed = writes.join('\n');
    assert.match(printed, /running \(pid 1000, uptime/);
    assert.match(printed, /last tick:/);
    assert.match(printed, /in flight: pid 3000 \(profile harish, running/); // C1: profile + elapsed, not just a pid.
    assert.match(printed, /next fire:.*harish/);
  });
  ```

- [ ] **Step 6: Run it and see all eight tests pass.**

  ```bash
  node --test src/cli/commands/serve.test.ts
  ```

  Expected: `# pass 8`, `# fail 0` — no implementation change needed.

- [ ] **Step 7: Wire `serve` into `main.ts` — USAGE, `CommandName`, `COMMAND_NAMES`, `buildOptions`, `defaultCommands`, dispatch, and the `--daemon-child` flag.**

  In `/Users/harishamutha/Job-bunny/src/cli/main.ts`, first add the import, replacing:

  ```ts
  import { runCommand } from './commands/run.ts';
  import { scheduleCommand } from './commands/schedule.ts';
  ```

  with:

  ```ts
  import { runCommand } from './commands/run.ts';
  import { scheduleCommand } from './commands/schedule.ts';
  import { serveCommand } from './commands/serve.ts';
  ```

  Update the module doc comment's cross-profile note, replacing:

  ```ts
   * options translation lives in `buildOptions`, which hands each command ONLY
   * the keys it reads (never an irrelevant key set to `undefined`) and returns
   * a usage error when a required piece is missing. `schedule install` is the
   * one command that takes no `--profile`: it is cross-profile by design.
  ```

  with:

  ```ts
   * options translation lives in `buildOptions`, which hands each command ONLY
   * the keys it reads (never an irrelevant key set to `undefined`) and returns
   * a usage error when a required piece is missing. `schedule install`,
   * `serve` (all three sub-actions), and `release` are cross-profile by
   * design and take no `--profile`.
  ```

  Add `daemonChild?: boolean;` to `CommandOptions`, replacing:

  ```ts
    version?: string;
    noMerge?: boolean;
    yes?: boolean;
  }
  ```

  with:

  ```ts
    version?: string;
    noMerge?: boolean;
    yes?: boolean;
    daemonChild?: boolean;
  }
  ```

  Add `'serve'` to `CommandName`, replacing:

  ```ts
  export type CommandName =
    | 'run'
    | 'doctor'
    | 'reconcile'
    | 'stage'
    | 'routine'
    | 'schedule'
    | 'lane'
    | 'profile'
    | 'setup'
    | 'release';
  ```

  with:

  ```ts
  export type CommandName =
    | 'run'
    | 'doctor'
    | 'reconcile'
    | 'stage'
    | 'routine'
    | 'schedule'
    | 'serve'
    | 'lane'
    | 'profile'
    | 'setup'
    | 'release';
  ```

  Add the `serve` line to `USAGE`, replacing:

  ```ts
    '  schedule install                     (cross-profile — no --profile)',
    '  schedule remove --profile <name>',
    '  lane add-url <url> [label] --profile <name>',
  ```

  with:

  ```ts
    '  schedule install                     (cross-profile — no --profile)',
    '  schedule remove --profile <name>',
    '  serve start|stop|status              (cross-profile — no --profile)',
    '  lane add-url <url> [label] --profile <name>',
  ```

  Add the registry entry to `defaultCommands`, replacing:

  ```ts
      schedule: scheduleCommand as unknown as CommandFn,
      lane: laneAddUrlCommand as unknown as CommandFn,
  ```

  with:

  ```ts
      schedule: scheduleCommand as unknown as CommandFn,
      serve: (async (opts: CommandOptions) =>
        serveCommand({
          action: (opts.action ?? 'status') as 'start' | 'stop' | 'status',
          daemonChild: opts.daemonChild ?? false,
        })) as CommandFn,
      lane: laneAddUrlCommand as unknown as CommandFn,
  ```

  Add `'serve'` to `COMMAND_NAMES`, replacing:

  ```ts
  const COMMAND_NAMES = new Set<string>([
    'run',
    'doctor',
    'reconcile',
    'stage',
    'routine',
    'schedule',
    'lane',
    'profile',
    'setup',
    'release',
  ]);
  ```

  with:

  ```ts
  const COMMAND_NAMES = new Set<string>([
    'run',
    'doctor',
    'reconcile',
    'stage',
    'routine',
    'schedule',
    'serve',
    'lane',
    'profile',
    'setup',
    'release',
  ]);
  ```

  Add the `'daemon-child'` flag to `buildOptions`'s `values` parameter type, replacing:

  ```ts
      'run-cap-ms'?: string;
      'no-merge'?: boolean;
      yes?: boolean;
    },
  ```

  with:

  ```ts
      'run-cap-ms'?: string;
      'no-merge'?: boolean;
      yes?: boolean;
      'daemon-child'?: boolean;
    },
  ```

  Add the `serve` case to `buildOptions`'s `switch`, replacing:

  ```ts
      case 'lane': {
  ```

  with:

  ```ts
      case 'serve': {
        const action = rest[0];
        if (action !== 'start' && action !== 'stop' && action !== 'status') {
          return { error: 'serve takes "start", "stop", or "status"' };
        }
        return { action, ...(values['daemon-child'] ? { daemonChild: true } : {}) };
      }
      case 'lane': {
  ```

  Add the `'daemon-child'` option to `parseArgs`'s `options`, replacing:

  ```ts
      'no-merge': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  });
  ```

  with:

  ```ts
      'no-merge': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'daemon-child': { type: 'boolean', default: false },
    },
  });
  ```

  `--daemon-child` is deliberately absent from `USAGE` — internal-only, per the spec.

- [ ] **Step 8: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 9: Manually verify dispatch — `serve` takes no `--profile`, so this is a direct bare-command check, not a `profiles/rajni/` run.**

  ```bash
  node src/cli/main.ts serve status
  ```

  Expected: exit 1, `serve status: not running` printed — confirms the command is wired end-to-end (`buildOptions`, dispatch, `defaultServeDeps`) without needing a real spawned daemon in this dev environment.

- [ ] **Step 10: Commit.**

  ```bash
  git add src/cli/commands/serve.ts src/cli/commands/serve.test.ts src/cli/main.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): add `serve start|stop|status`, replacing launchd triggering

  `serve start` splits into a parent (migration-scan, pidfile acquire
  with a live-vs-stale-with-recheck steal rule, D22/A15.4, detached
  spawn, 2s alive-confirm) and `--daemon-child` (the foreground tick
  loop, D2). `serve stop` kills the daemon before any in-flight child
  (D10 — daemon-first, or the daemon's own await could spawn the next
  owed run before its SIGTERM lands) with a poll-not-sleep SIGTERM/
  SIGKILL escalation reused verbatim from Task 8. `serve status` is
  read-only and folds the pidfile's attempts ledger into isRunOwed's
  history the same way daemon.ts's own tick does (D19), so it never
  over-reports an already-served slot as owed. `serve` coexists with
  `schedule install/remove` for now — Task 12 retires the latter once
  this is proven wired.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 10: `autostart enable` / `disable` (darwin only)

**Files:**
- Create: `/Users/harishamutha/Job-bunny/src/cli/commands/autostart.ts`
- Create: `/Users/harishamutha/Job-bunny/src/cli/commands/autostart.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/cli/commands/serve.ts` (export the two migration-scan helpers so this task reuses them verbatim instead of duplicating the regex or the cleanup-block formatting)
- Modify: `/Users/harishamutha/Job-bunny/src/cli/main.ts`

**Interfaces:**

Consumes: `LEGACY_PLIST_REGEX`, `migrationCleanupBlock` from `./serve.ts` (module-private in Task 9; this task exports them — see the Files note above).

Produces:
```ts
export type AutostartAction = 'enable' | 'disable';

export interface AutostartCommandOptions {
  action: AutostartAction;
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number | undefined;
  root: string;
  nodeBin: string;
  cliEntry: string;
  listLaunchAgentFiles(): string[];
  writeFile(path: string, data: string): Promise<void>;
  unlink(path: string): Promise<void>;
  runLaunchctl(args: string[]): Promise<{ exitCode: number; stdout: string }>;
  write(line: string): void;
  writeErr(line: string): void;
}

export function renderAutostartPlist(nodeBin: string, cliEntry: string, root: string): string;

export function autostartCommand(
  opts: AutostartCommandOptions,
  overrides?: Partial<AutostartDeps>,
): Promise<number>;
```

Behavior:

- Writes exactly one LaunchAgent, `~/Library/LaunchAgents/com.jobbunny.autostart.plist`, with `RunAtLoad: true` and NO `StartCalendarInterval`, program `<nodeBin> <cliEntry> serve start`. It carries ZERO schedule knowledge — the daemon's tick loop remains the only interpreter of `times`/`weekdays`/`graceMinutes` (§6.7).
- B2: the plist ALSO sets `WorkingDirectory` to the repo root (`AutostartDeps.root`, defaulting to `process.cwd()` at enable time). Without it, launchd runs `serve start` with cwd `/`: the pidfile becomes `/.jobbunny-daemon.pid`, `profilesDir` becomes `/profiles`, and `main.ts`'s `dotenv/config` load finds no `.env` — autostart would be broken on every login. The retired plist embedded `cd '${root}'` in its own `buildCommand` for exactly this reason; `WorkingDirectory` is the LaunchAgent-native equivalent.
- `enable` performs the SAME legacy-plist migration scan `serve start` does (the `^com\.jobbunny\.\d{4}\.plist$` regex, reused from `./serve.ts`) and refuses with the identical ready-to-paste cleanup block on any match — BEFORE writing anything. Without this, a user who runs `autostart enable` before ever running `serve start` would only discover the conflict at the NEXT login, when the LaunchAgent's own `serve start` invocation refuses and the refusal lands only in `daemon.log`.
- `enable` writes the plist, then runs `launchctl bootstrap gui/<uid> <plist>`; `disable` runs `launchctl bootout gui/<uid>/com.jobbunny.autostart` and removes the plist. Both tolerate a not-loaded/already-loaded state — a nonzero `launchctl` exit is logged, not fatal, since the plist file itself (written/removed successfully) is the source of truth for whether autostart is configured.
- On non-darwin, both subcommands exit nonzero with a message naming the documented manual alternative (Task Scheduler on Windows, a systemd `--user` unit on Linux, both pointing at `jobbunny serve start` with no arguments) — a platform asymmetry, stated explicitly, not implied parity (D20).
- Plist XML is rendered by a small local helper (`renderAutostartPlist`) with XML escaping (`escapeXml`) for every interpolated value — the same five-entity escape `adapters/scheduler/launchd/plist.ts`'s `escapeXml` used, reproduced here rather than imported (Task 12 deletes that file, and `adapters-no-cross-family`/`only-wire-imports-adapters` forbid this file from importing it anyway).

- [ ] **Step 1: Export the two migration-scan helpers from `serve.ts`.**

  In `/Users/harishamutha/Job-bunny/src/cli/commands/serve.ts`, replace:

  ```ts
  const LEGACY_PLIST_REGEX = /^com\.jobbunny\.\d{4}\.plist$/;
  ```

  with:

  ```ts
  export const LEGACY_PLIST_REGEX = /^com\.jobbunny\.\d{4}\.plist$/;
  ```

  and replace:

  ```ts
  /** D15/§8 — a directory read plus printed strings; no `launchd` code. */
  function migrationCleanupBlock(files: string[], uid: number | undefined): string {
  ```

  with:

  ```ts
  /** D15/§8 — a directory read plus printed strings; no `launchd` code.
   * Exported so `autostart.ts`'s `enable` can reuse it verbatim (§6.7). */
  export function migrationCleanupBlock(files: string[], uid: number | undefined): string {
  ```

- [ ] **Step 2: Write the first two failing tests — the pure plist renderer.**

  Create `/Users/harishamutha/Job-bunny/src/cli/commands/autostart.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { autostartCommand, renderAutostartPlist } from './autostart.ts';
  import type { AutostartDeps } from './autostart.ts';

  test('renderAutostartPlist: RunAtLoad true, no StartCalendarInterval, sets WorkingDirectory', () => {
    const xml = renderAutostartPlist('/usr/local/bin/node', '/repo/src/cli/main.ts', '/repo');
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.doesNotMatch(xml, /StartCalendarInterval/);
    assert.match(xml, /<string>com\.jobbunny\.autostart<\/string>/);
    assert.match(xml, /<string>serve<\/string>/);
    assert.match(xml, /<string>start<\/string>/);
    // B2: WorkingDirectory must be set, or launchd runs `serve start` with
    // cwd `/` — wrong pidfile, wrong profilesDir, no .env loaded.
    assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/repo<\/string>/);
  });

  test('renderAutostartPlist: XML-escapes an interpolated path containing "&"', () => {
    const xml = renderAutostartPlist('/Users/a & b/node', '/repo/src/cli/main.ts', '/repo');
    assert.match(xml, /a &amp; b/);
    assert.doesNotMatch(xml, /a & b/);
  });

  function fakeDeps(overrides: Partial<AutostartDeps> = {}): {
    deps: AutostartDeps;
    written: Map<string, string>;
    unlinked: string[];
    launchctlCalls: string[][];
    writes: string[];
    errs: string[];
  } {
    const written = new Map<string, string>();
    const unlinked: string[] = [];
    const launchctlCalls: string[][] = [];
    const writes: string[] = [];
    const errs: string[] = [];
    const deps: AutostartDeps = {
      platform: 'darwin',
      home: '/fake/home',
      uid: 501,
      root: '/fake/root',
      nodeBin: 'node',
      cliEntry: '/repo/src/cli/main.ts',
      listLaunchAgentFiles: () => [],
      writeFile: async (p, data) => {
        written.set(p, data);
      },
      unlink: async (p) => {
        unlinked.push(p);
      },
      runLaunchctl: async (args) => {
        launchctlCalls.push(args);
        return { exitCode: 0, stdout: '' };
      },
      write: (line) => writes.push(line),
      writeErr: (line) => errs.push(line),
      ...overrides,
    };
    return { deps, written, unlinked, launchctlCalls, writes, errs };
  }

  test('enable: writes the plist (with WorkingDirectory) and bootstraps it', async () => {
    const { deps, written, launchctlCalls } = fakeDeps();
    const code = await autostartCommand({ action: 'enable' }, deps);
    assert.equal(code, 0);
    const plist = written.get('/fake/home/Library/LaunchAgents/com.jobbunny.autostart.plist');
    assert.ok(plist);
    assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/fake\/root<\/string>/);
    assert.deepEqual(launchctlCalls[0], [
      'bootstrap',
      'gui/501',
      '/fake/home/Library/LaunchAgents/com.jobbunny.autostart.plist',
    ]);
  });
  ```

- [ ] **Step 3: Run it and see it fail because `autostart.ts` does not exist yet.**

  ```bash
  node --test src/cli/commands/autostart.test.ts
  ```

  Expected failure: `Cannot find module '.../cli/commands/autostart.ts'`.

- [ ] **Step 4: Implement `autostart.ts` in full.**

  Create `/Users/harishamutha/Job-bunny/src/cli/commands/autostart.ts`:

  ```ts
  /**
   * cli/commands/autostart.ts (D20) — `autostart enable|disable`, darwin
   * only. Writes exactly ONE LaunchAgent, `com.jobbunny.autostart.plist`,
   * with `RunAtLoad: true` and NO `StartCalendarInterval` — a dumb "run
   * this at login" trigger. It carries ZERO schedule knowledge: the
   * daemon's own tick loop remains the only interpreter of `times`/
   * `weekdays`/`graceMinutes` (§6.7). No `launchd` adapter code is retained
   * or reused — this writes plain XML text and shells out to `launchctl`
   * directly, the same posture `serve.ts`'s D15 migration scan already
   * takes.
   */
  import { execFile } from 'node:child_process';
  import { readdirSync as fsReaddirSync, unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs';
  import { homedir } from 'node:os';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { promisify } from 'node:util';
  import { LEGACY_PLIST_REGEX, migrationCleanupBlock } from './serve.ts';

  const execFileAsync = promisify(execFile);
  const fsWriteFileAsync = promisify(fsWriteFile);
  const fsUnlinkAsync = promisify(fsUnlink);

  const AUTOSTART_LABEL = 'com.jobbunny.autostart';

  export type AutostartAction = 'enable' | 'disable';

  export interface AutostartCommandOptions {
    action: AutostartAction;
  }

  export interface AutostartDeps {
    platform: NodeJS.Platform;
    home: string;
    uid: number | undefined;
    root: string;
    nodeBin: string;
    cliEntry: string;
    listLaunchAgentFiles(): string[];
    writeFile(path: string, data: string): Promise<void>;
    unlink(path: string): Promise<void>;
    runLaunchctl(args: string[]): Promise<{ exitCode: number; stdout: string }>;
    write(line: string): void;
    writeErr(line: string): void;
  }

  function plistPath(home: string): string {
    return path.join(home, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
  }

  function escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** `RunAtLoad: true`, deliberately NO `StartCalendarInterval` (§6.7): this
   * LaunchAgent's only job is starting `jobbunny serve start` at login —
   * the daemon's own tick loop, not launchd, decides WHEN a run fires.
   * B2: also sets `WorkingDirectory` to `root` — without it, launchd runs
   * the program with cwd `/`, so the pidfile lands at `/.jobbunny-daemon.
   * pid`, `profilesDir` resolves to `/profiles`, and `main.ts`'s
   * `dotenv/config` load finds no `.env`. The retired plist embedded `cd
   * '${root}'` in its own `buildCommand` for exactly this reason —
   * `WorkingDirectory` is the LaunchAgent-native equivalent. */
  export function renderAutostartPlist(nodeBin: string, cliEntry: string, root: string): string {
    const argsXml = [nodeBin, cliEntry, 'serve', 'start']
      .map((a) => `      <string>${escapeXml(a)}</string>`)
      .join('\n');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '  <dict>',
      '    <key>Label</key>',
      `    <string>${escapeXml(AUTOSTART_LABEL)}</string>`,
      '    <key>ProgramArguments</key>',
      '    <array>',
      argsXml,
      '    </array>',
      '    <key>RunAtLoad</key>',
      '    <true/>',
      '    <key>WorkingDirectory</key>',
      `    <string>${escapeXml(root)}</string>`,
      '  </dict>',
      '</plist>',
    ].join('\n');
  }

  function hasCode(err: unknown, code: string): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === code
    );
  }

  function defaultAutostartDeps(): AutostartDeps {
    const home = homedir();
    return {
      platform: process.platform,
      home,
      uid: process.getuid?.(),
      root: process.cwd(), // B2: WorkingDirectory, captured at enable time.
      nodeBin: process.execPath,
      cliEntry: fileURLToPath(new URL('../main.ts', import.meta.url)),
      listLaunchAgentFiles: () => {
        try {
          return fsReaddirSync(path.join(home, 'Library', 'LaunchAgents'));
        } catch {
          return [];
        }
      },
      writeFile: (p, data) => fsWriteFileAsync(p, data, 'utf8'),
      unlink: (p) => fsUnlinkAsync(p),
      runLaunchctl: async (args) => {
        try {
          const { stdout } = await execFileAsync('launchctl', args);
          return { exitCode: 0, stdout };
        } catch (err) {
          const failure = err as { stdout?: string; code?: number };
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout: failure.stdout ?? '',
          };
        }
      },
      write: (line) => console.log(line),
      writeErr: (line) => console.error(line),
    };
  }

  const NON_DARWIN_ALTERNATIVE =
    'run `jobbunny serve start` once after each login/boot, or register the OS-native ' +
    '"run at login" mechanism by hand (Task Scheduler on Windows, a systemd --user unit ' +
    'on Linux) pointing at `jobbunny serve start` with no arguments';

  async function runEnable(deps: AutostartDeps): Promise<number> {
    if (deps.platform !== 'darwin') {
      deps.writeErr(`autostart enable: not supported on this platform — ${NON_DARWIN_ALTERNATIVE}.`);
      return 1;
    }

    const legacy = deps.listLaunchAgentFiles().filter((f) => LEGACY_PLIST_REGEX.test(f));
    if (legacy.length > 0) {
      deps.writeErr(migrationCleanupBlock(legacy, deps.uid));
      return 1;
    }

    const target = plistPath(deps.home);
    await deps.writeFile(target, renderAutostartPlist(deps.nodeBin, deps.cliEntry, deps.root));

    const result = await deps.runLaunchctl(['bootstrap', `gui/${deps.uid ?? ''}`, target]);
    if (result.exitCode !== 0) {
      // Tolerated, not fatal: launchctl's own idempotency error text varies
      // by macOS version, and the plist file (written above) is the real
      // source of truth for whether autostart is configured.
      deps.write(`autostart enable: launchctl bootstrap reported: ${result.stdout.trim()}`);
    }
    deps.write(`autostart enable: wrote ${target} and loaded it`);
    return 0;
  }

  async function runDisable(deps: AutostartDeps): Promise<number> {
    if (deps.platform !== 'darwin') {
      deps.writeErr(
        `autostart disable: not supported on this platform — there is nothing to ` +
          `unregister; if you set up a manual OS-native trigger, remove it by hand.`,
      );
      return 1;
    }

    await deps.runLaunchctl(['bootout', `gui/${deps.uid ?? ''}/${AUTOSTART_LABEL}`]);
    try {
      await deps.unlink(plistPath(deps.home));
    } catch (err) {
      if (!hasCode(err, 'ENOENT')) throw err;
    }
    deps.write('autostart disable: unloaded and removed the autostart LaunchAgent');
    return 0;
  }

  export async function autostartCommand(
    opts: AutostartCommandOptions,
    overrides: Partial<AutostartDeps> = {},
  ): Promise<number> {
    const deps: AutostartDeps = { ...defaultAutostartDeps(), ...overrides };
    return opts.action === 'enable' ? runEnable(deps) : runDisable(deps);
  }
  ```

- [ ] **Step 5: Run it and see all three tests pass.**

  ```bash
  node --test src/cli/commands/autostart.test.ts
  ```

  Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 6: Write the remaining two tests.**

  Append to `autostart.test.ts`:

  ```ts
  test('enable: refuses when a legacy launchd plist is found, without writing the plist', async () => {
    const { deps, written } = fakeDeps({
      listLaunchAgentFiles: () => ['com.jobbunny.1400.plist'],
    });
    const code = await autostartCommand({ action: 'enable' }, deps);
    assert.equal(code, 1);
    assert.equal(written.size, 0);
  });

  test('enable/disable: non-darwin exits nonzero naming the manual alternative', async () => {
    const enableDeps = fakeDeps({ platform: 'win32' });
    const enableCode = await autostartCommand({ action: 'enable' }, enableDeps.deps);
    assert.equal(enableCode, 1);
    assert.ok(enableDeps.errs.some((e) => e.includes('serve start')));

    const disableDeps = fakeDeps({ platform: 'linux' });
    const disableCode = await autostartCommand({ action: 'disable' }, disableDeps.deps);
    assert.equal(disableCode, 1);
    assert.ok(disableDeps.errs.some((e) => e.includes('serve start')));
  });
  ```

- [ ] **Step 7: Run it and see all five tests pass.**

  ```bash
  node --test src/cli/commands/autostart.test.ts
  ```

  Expected: `# pass 5`, `# fail 0` — no implementation change needed.

- [ ] **Step 8: Wire `autostart` into `main.ts` — USAGE, `CommandName`, `COMMAND_NAMES`, `buildOptions`, `defaultCommands`, dispatch.**

  In `/Users/harishamutha/Job-bunny/src/cli/main.ts`, add the import, replacing:

  ```ts
  import { doctorCommand } from './commands/doctor.ts';
  import { laneAddUrlCommand } from './commands/lane_add_url.ts';
  ```

  with:

  ```ts
  import { autostartCommand } from './commands/autostart.ts';
  import { doctorCommand } from './commands/doctor.ts';
  import { laneAddUrlCommand } from './commands/lane_add_url.ts';
  ```

  Add `'autostart'` to `CommandName`, replacing:

  ```ts
    | 'schedule'
    | 'serve'
    | 'lane'
  ```

  with:

  ```ts
    | 'schedule'
    | 'serve'
    | 'autostart'
    | 'lane'
  ```

  Add the `autostart` line to `USAGE`, replacing:

  ```ts
    '  serve start|stop|status              (cross-profile — no --profile)',
    '  lane add-url <url> [label] --profile <name>',
  ```

  with:

  ```ts
    '  serve start|stop|status              (cross-profile — no --profile)',
    '  autostart enable|disable             (cross-profile — darwin only)',
    '  lane add-url <url> [label] --profile <name>',
  ```

  Add the registry entry to `defaultCommands`, replacing:

  ```ts
      serve: (async (opts: CommandOptions) =>
        serveCommand({
          action: (opts.action ?? 'status') as 'start' | 'stop' | 'status',
          daemonChild: opts.daemonChild ?? false,
        })) as CommandFn,
      lane: laneAddUrlCommand as unknown as CommandFn,
  ```

  with:

  ```ts
      serve: (async (opts: CommandOptions) =>
        serveCommand({
          action: (opts.action ?? 'status') as 'start' | 'stop' | 'status',
          daemonChild: opts.daemonChild ?? false,
        })) as CommandFn,
      autostart: (async (opts: CommandOptions) =>
        autostartCommand({ action: (opts.action ?? 'enable') as 'enable' | 'disable' })) as CommandFn,
      lane: laneAddUrlCommand as unknown as CommandFn,
  ```

  Add `'autostart'` to `COMMAND_NAMES`, replacing:

  ```ts
    'schedule',
    'serve',
    'lane',
  ```

  with:

  ```ts
    'schedule',
    'serve',
    'autostart',
    'lane',
  ```

  Add the `autostart` case to `buildOptions`'s `switch`, replacing:

  ```ts
      case 'lane': {
        if (rest[0] !== 'add-url') return { error: 'lane takes "add-url"' };
  ```

  with:

  ```ts
      case 'autostart': {
        const action = rest[0];
        if (action !== 'enable' && action !== 'disable') {
          return { error: 'autostart takes "enable" or "disable"' };
        }
        return { action };
      }
      case 'lane': {
        if (rest[0] !== 'add-url') return { error: 'lane takes "add-url"' };
  ```

- [ ] **Step 9: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green. Note deliberately NOT run as a manual step here: `node src/cli/main.ts autostart enable` for real — this dev machine is darwin, and a real invocation would install a real LaunchAgent into this developer's own `~/Library/LaunchAgents/`, a live-system side effect this plan must not script casually. The five unit tests above (Step 2 + Step 6) already exercise the plist-render, migration-refusal, and non-darwin paths against injected deps; genuine end-to-end `launchctl` behavior is what the CI matrix's `serve start/stop/status` exercise (§10.4 of the spec) is for, not a manual step in this task.

- [ ] **Step 10: Commit.**

  ```bash
  git add src/cli/commands/autostart.ts src/cli/commands/autostart.test.ts src/cli/commands/serve.ts src/cli/main.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): add `autostart enable|disable` (darwin, D20)

  Writes exactly one LaunchAgent, com.jobbunny.autostart.plist, with
  RunAtLoad true and deliberately no StartCalendarInterval — a dumb
  "run jobbunny serve start at login" trigger carrying zero schedule
  knowledge; the daemon's own tick loop remains the only interpreter
  of times/weekdays/graceMinutes. `enable` reuses serve.ts's D15
  migration scan verbatim (now exported) so a leftover legacy plist is
  caught interactively at enable-time rather than silently at the next
  login. Non-darwin exits nonzero naming the documented manual
  alternative — a stated platform asymmetry, not implied parity.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 11: doctor checks and the daemon-down warning

**Files:**
- Modify: `/Users/harishamutha/Job-bunny/src/ops/doctor/aggregate.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/ops/doctor/aggregate.test.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/cli/main.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/cli/main.test.ts`

**Placement decision (required by this task): modify `aggregate.ts` directly, not a new adapter-contributed check module — stated, not assumed.** `src/adapters/browser/cdp-chrome/check.ts`'s `cdpReachableCheck` lives inside its OWNING adapter because it exercises that adapter's own live probe function (`CdpReachableFn` — behavior only `cdp-chrome` can supply) and is wired into the doctor surface via `cli/wire.ts`'s adapter registry. Neither new check here has an adapter-owned behavior to exercise: the `claude`-on-PATH check is a bare PATH probe (no different in kind from `envTokensCheck`'s `env.NOTION_TOKEN` presence check, already a "core" check), and the daemon-liveness check reads the daemon's own `ops`-internal pidfile (not adapter state — `ops/daemon` and `ops/doctor` are sibling `ops/` modules, and `npm run boundaries` places no restriction on one `ops/` module importing another). `aggregate.ts`'s own header comment already frames itself as "profile/config/env core checks... no adapter access" — both new checks satisfy that same contract, so they extend `aggregate.ts`'s existing `CoreCheckOpts`-injected-deps shape rather than spinning up a third sibling module for two small functions that don't need one.

**Interfaces:**

Consumes: `readDaemonPidfile`, `DaemonPidfileDeps`, `defaultDaemonPidfileDeps`, `HEARTBEAT_STALE_MS` from `../daemon/index.ts`.

Produces (extends the existing `CoreCheckOpts`, adds two checks, extends `coreChecks()`'s returned array):
```ts
export interface CoreCheckOpts {
  profileName: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
  /** Probes whether a command resolves on PATH. Defaults to a real
   * `execFile('claude', ['--version'])` probe. Injected so tests never
   * shell out for real (D17's hermetic-test requirement). */
  commandExists?: (command: string) => Promise<boolean>;
  /** Daemon pidfile deps for the liveness check below. Defaults to
   * `defaultDaemonPidfileDeps()`. */
  daemonPidfile?: DaemonPidfileDeps;
}

export function claudeOnPathCheck(opts: CoreCheckOpts): DoctorCheck;
export function daemonLivenessCheck(opts: CoreCheckOpts): DoctorCheck;
```

Behavior:

1. **`claude`-CLI-on-PATH check (D13).** Green (`ok`) when `commandExists('claude')` resolves `true`; `red` with an install pointer when it doesn't. Claude Code is itself cross-platform, so this is a documented prerequisite to CHECK, not an OS blocker to work around. Added to `coreChecks()`'s returned array — this means it also gates `run.ts`'s preflight (a `red` finding aborts a run before any stage), which is intended: the structure stage already hard-depends on `claude` today, this just makes that dependency fail fast instead of failing mid-run at the `structure` stage.
2. **Daemon-liveness check.** No live daemon (pidfile absent, or present but the recorded pid is dead) ⇒ `warn`. Pid alive but `lastTickAt` older than `HEARTBEAT_STALE_MS` ⇒ `warn`, wording says "appears wedged". The note that a machine which just woke from sleep can transiently trigger the wedged case for up to one tick is included directly in the finding's `detail` text — and this check is advisory only: it deliberately does NOT re-check before reporting, unlike `serve start`'s steal path (§6.2/A15.4), which mutates state and therefore must re-check before acting. Also added to `coreChecks()` — harmless there since only `red` aborts a run preflight, and `warn` never does.
3. **`main.ts`'s per-command stderr warning (§6.8, separate from the doctor check above).** EVERY command prints a warning to stderr when the pidfile EXISTS and shows no live daemon (dead pid, or alive-but-wedged heartbeat) — but per §6.2's reader rule, `readDaemonPidfile` already collapses "absent" and "unparseable" to the identical `undefined` return, and per the spec's own literal §6.8 text ("if the pidfile exists but its recorded pid is not alive") a pidfile that was NEVER created (nobody has ever run `serve start`) stays SILENT here — the `undefined` case is a no-op, not a warning. This is a deliberate divergence from the doctor check above, which DOES warn on a missing pidfile (an opt-in, explicitly-requested diagnostic surface where "you've never set up the daemon" is useful information); the blanket per-command nag would be actively unwelcome noise for a user who hasn't adopted the daemon at all. Injected as `MainDeps.checkDaemonLiveness: () => string | undefined` so no test in `main.test.ts` touches a real pidfile on disk.

- [ ] **Step 1: Write the first two failing tests — the daemon-liveness check.**

  Append to `/Users/harishamutha/Job-bunny/src/ops/doctor/aggregate.test.ts`:

  ```ts
  import type { DaemonPidfileDeps } from '../daemon/index.ts';
  import { acquireDaemonPidfile, updateDaemonPidfile } from '../daemon/index.ts';
  import { claudeOnPathCheck, daemonLivenessCheck } from './aggregate.ts';

  function fakeDaemonPidfileDeps(nowMs: number): DaemonPidfileDeps {
    const files = new Map<string, string>();
    const notFound = (): never => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    return {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => files.get(p) ?? notFound(),
      writeFileSync: (p, data) => {
        files.set(p, data);
      },
      writeFileSyncExclusive: (p, data) => {
        if (files.has(p)) return false;
        files.set(p, data);
        return true;
      },
      renameSync: (from, to) => {
        const content = files.get(from) ?? notFound();
        files.delete(from);
        files.set(to, content);
      },
      unlinkSync: (p) => {
        files.delete(p);
      },
      pidIsAlive: () => true,
      now: () => new Date(nowMs),
    };
  }

  test('daemonLivenessCheck: a fresh heartbeat on a live pid is ok', async () => {
    const now = Date.parse('2026-07-27T14:04:00.000Z');
    const daemonPidfile = fakeDaemonPidfileDeps(now);
    acquireDaemonPidfile('/fake/root', 1000, daemonPidfile);
    const finding = await daemonLivenessCheck({
      profileName: 'harish',
      root: '/fake/root',
      daemonPidfile,
    }).run();
    assert.equal(finding.status, 'ok');
  });

  test('daemonLivenessCheck: a six-minute-old heartbeat on a live pid warns "wedged"', async () => {
    const started = Date.parse('2026-07-27T14:04:00.000Z');
    const daemonPidfile = fakeDaemonPidfileDeps(started);
    acquireDaemonPidfile('/fake/root', 1000, daemonPidfile);
    daemonPidfile.now = () => new Date(started + 6 * 60_000);
    const finding = await daemonLivenessCheck({
      profileName: 'harish',
      root: '/fake/root',
      daemonPidfile,
    }).run();
    assert.equal(finding.status, 'warn');
    assert.match(finding.detail, /wedged/);
  });
  ```

- [ ] **Step 2: Run it and see it fail because `claudeOnPathCheck`/`daemonLivenessCheck` don't exist yet.**

  ```bash
  node --test src/ops/doctor/aggregate.test.ts
  ```

  Expected failure: `SyntaxError`/`does not provide an export named 'daemonLivenessCheck'`.

- [ ] **Step 3: Implement both checks in `aggregate.ts`.**

  In `/Users/harishamutha/Job-bunny/src/ops/doctor/aggregate.ts`, add the imports, replacing:

  ```ts
  import { readFile as fsReadFile } from 'node:fs/promises';
  import path from 'node:path';
  import { PipelineConfigSchema } from '../../core/config/schema.ts';
  import { FilterConfigSchema } from '../../core/filter/config.ts';
  import type {
    DoctorCheck,
    DoctorFinding,
    DoctorReport,
    DoctorStatus,
  } from '../../ports/doctor.ts';
  ```

  with:

  ```ts
  import { execFile } from 'node:child_process';
  import { readFile as fsReadFile } from 'node:fs/promises';
  import path from 'node:path';
  import { promisify } from 'node:util';
  import { PipelineConfigSchema } from '../../core/config/schema.ts';
  import { FilterConfigSchema } from '../../core/filter/config.ts';
  import type {
    DoctorCheck,
    DoctorFinding,
    DoctorReport,
    DoctorStatus,
  } from '../../ports/doctor.ts';
  import type { DaemonPidfileDeps } from '../daemon/index.ts';
  import { defaultDaemonPidfileDeps, HEARTBEAT_STALE_MS, readDaemonPidfile } from '../daemon/index.ts';

  const execFileAsync = promisify(execFile);
  ```

  Extend `CoreCheckOpts`, replacing:

  ```ts
  export interface CoreCheckOpts {
    profileName: string;
    root?: string;
    env?: NodeJS.ProcessEnv;
    readFile?: (path: string) => Promise<string>;
  }
  ```

  with:

  ```ts
  export interface CoreCheckOpts {
    profileName: string;
    root?: string;
    env?: NodeJS.ProcessEnv;
    readFile?: (path: string) => Promise<string>;
    /** Probes whether a command resolves on PATH. Defaults to a real
     * `execFile('claude', ['--version'])` probe. Injected so tests never
     * shell out for real (D17's hermetic-test requirement). */
    commandExists?: (command: string) => Promise<boolean>;
    /** Daemon pidfile deps for `daemonLivenessCheck`. Defaults to
     * `defaultDaemonPidfileDeps()`. */
    daemonPidfile?: DaemonPidfileDeps;
  }
  ```

  Add the two new checks and their resolvers, replacing:

  ```ts
  /** coreChecks — the three profile/config/env checks above, in a fixed
   * order. Callers append adapter-contributed checks (e.g. Notion/Telegram
   * reachability) themselves before calling `runChecks`. */
  export function coreChecks(opts: CoreCheckOpts): DoctorCheck[] {
    return [
      profileParsesCheck(opts),
      filterParsesCheck(opts),
      emptyLanesCheck(opts),
      envTokensCheck(opts),
    ];
  }
  ```

  with:

  ```ts
  function resolveCommandExists(opts: CoreCheckOpts): (command: string) => Promise<boolean> {
    return opts.commandExists ?? defaultCommandExists;
  }

  async function defaultCommandExists(command: string): Promise<boolean> {
    try {
      await execFileAsync(command, ['--version']);
      return true;
    } catch (err) {
      // ENOENT ⇒ not on PATH. Any other failure (e.g. a nonzero exit)
      // still means the binary itself was found and ran — present.
      return !isNotFound(err);
    }
  }

  /** claudeOnPathCheck (D13) — Claude Code's own `claude` CLI is the ONLY
   * structure-stage LLM provider; this is a documented prerequisite to
   * CHECK, not an OS blocker to work around (Claude Code itself is
   * cross-platform). `red`, not `warn`: the structure stage cannot proceed
   * at all without it, so failing fast at doctor/preflight time beats
   * failing partway through a run. */
  export function claudeOnPathCheck(opts: CoreCheckOpts): DoctorCheck {
    const name = 'claude-cli-on-path';
    const commandExists = resolveCommandExists(opts);
    return {
      name,
      async run(): Promise<DoctorFinding> {
        const found = await commandExists('claude');
        if (found) {
          return { check: name, status: 'ok', detail: 'claude CLI found on PATH' };
        }
        return {
          check: name,
          status: 'red',
          detail:
            'claude CLI not found on PATH — the structure stage shells out to it directly; ' +
            'install Claude Code (https://claude.com/claude-code) and ensure `claude` ' +
            'resolves on PATH',
        };
      },
    };
  }

  /** daemonLivenessCheck (§6.8, D22) — an opt-in diagnostic surface (only
   * seen when the user explicitly runs `jobbunny doctor`), distinct from
   * main.ts's blanket per-command stderr warning: this check DOES warn on
   * a missing pidfile (useful information here), where the per-command
   * warning deliberately stays silent for a user who has never run `serve
   * start` at all (see main.ts's `defaultCheckDaemonLiveness`). Always
   * `warn`, never `red` — a down/wedged daemon means scheduled runs won't
   * fire, not that a manually-invoked `run`/`doctor` itself is broken. */
  export function daemonLivenessCheck(opts: CoreCheckOpts): DoctorCheck {
    const name = 'daemon-liveness';
    const root = resolveRoot(opts);
    const deps = opts.daemonPidfile ?? defaultDaemonPidfileDeps();
    return {
      name,
      async run(): Promise<DoctorFinding> {
        const file = readDaemonPidfile(root, deps);
        if (!file) {
          return {
            check: name,
            status: 'warn',
            detail:
              "no daemon pidfile found — scheduled runs will not fire until 'jobbunny serve start'",
          };
        }
        if (!deps.pidIsAlive(file.pid)) {
          return {
            check: name,
            status: 'warn',
            detail: `daemon pidfile found but pid ${file.pid} is not alive — run 'jobbunny serve start'`,
          };
        }
        const heartbeatAgeMs = deps.now().getTime() - Date.parse(file.lastTickAt);
        if (heartbeatAgeMs > HEARTBEAT_STALE_MS) {
          return {
            check: name,
            status: 'warn',
            detail:
              `daemon (pid ${file.pid}) appears wedged — no tick in over ` +
              `${Math.round(HEARTBEAT_STALE_MS / 60_000)} minutes. A machine that just woke ` +
              'from sleep can trigger this transiently for up to one tick interval; this ' +
              'check is advisory and deliberately does not re-check before reporting.',
          };
        }
        return {
          check: name,
          status: 'ok',
          detail: `daemon running (pid ${file.pid}), ticking normally`,
        };
      },
    };
  }

  /** coreChecks — the five profile/config/env/daemon/claude checks above,
   * in a fixed order. Callers append adapter-contributed checks (e.g.
   * Notion/Telegram reachability) themselves before calling `runChecks`. */
  export function coreChecks(opts: CoreCheckOpts): DoctorCheck[] {
    return [
      profileParsesCheck(opts),
      filterParsesCheck(opts),
      emptyLanesCheck(opts),
      envTokensCheck(opts),
      claudeOnPathCheck(opts),
      daemonLivenessCheck(opts),
    ];
  }
  ```

- [ ] **Step 4: Run it and see both tests pass.**

  ```bash
  node --test src/ops/doctor/aggregate.test.ts
  ```

  Expected: existing tests still pass, plus the two new ones — no regressions (the two new checks are additive to `coreChecks()`'s array; any existing test asserting the EXACT length/contents of `coreChecks(...)`'s output needs updating in this step — see the note below).

  **Note:** if an existing `aggregate.test.ts` test asserts `coreChecks(opts).length === 4` or enumerates the four check names by position, update that assertion to 6 and append `'claude-cli-on-path'`/`'daemon-liveness'` in place, rather than leaving a now-failing count assertion — this is expected fallout from an additive change to a fixed-order array, not a new bug.

- [ ] **Step 5: Write the remaining two tests.**

  Append to `aggregate.test.ts`:

  ```ts
  test('daemonLivenessCheck: a missing pidfile warns', async () => {
    const daemonPidfile = fakeDaemonPidfileDeps(Date.now());
    const finding = await daemonLivenessCheck({
      profileName: 'harish',
      root: '/fake/root',
      daemonPidfile,
    }).run();
    assert.equal(finding.status, 'warn');
    assert.match(finding.detail, /no daemon pidfile found/);
  });

  test('claudeOnPathCheck: present ⇒ ok, absent ⇒ red', async () => {
    const present = await claudeOnPathCheck({
      profileName: 'harish',
      commandExists: async () => true,
    }).run();
    assert.equal(present.status, 'ok');

    const absent = await claudeOnPathCheck({
      profileName: 'harish',
      commandExists: async () => false,
    }).run();
    assert.equal(absent.status, 'red');
    assert.match(absent.detail, /not found on PATH/);
  });
  ```

- [ ] **Step 6: Run it and see all four new tests pass.**

  ```bash
  node --test src/ops/doctor/aggregate.test.ts
  ```

  Expected: `# fail 0`.

- [ ] **Step 7: Add `main.ts`'s per-command daemon-liveness stderr warning.**

  In `/Users/harishamutha/Job-bunny/src/cli/main.ts`, add the import, replacing:

  ```ts
  import { autostartCommand } from './commands/autostart.ts';
  import { doctorCommand } from './commands/doctor.ts';
  ```

  with:

  ```ts
  import { autostartCommand } from './commands/autostart.ts';
  import { doctorCommand } from './commands/doctor.ts';
  import { defaultDaemonPidfileDeps, HEARTBEAT_STALE_MS, readDaemonPidfile } from '../ops/daemon/index.ts';
  ```

  Extend `MainDeps`, replacing:

  ```ts
  export interface MainDeps {
    /** Partial on purpose: a test overrides only the command it exercises
     * and inherits the real implementations for the rest (which are never
     * called, since dispatch reaches exactly one). */
    commands?: Partial<CommandRegistry>;
    stderr?: (line: string) => void;
    /** Environment for the npm swallowed-flag guard. Default: `process.env`. */
    env?: Record<string, string | undefined>;
  }
  ```

  with:

  ```ts
  export interface MainDeps {
    /** Partial on purpose: a test overrides only the command it exercises
     * and inherits the real implementations for the rest (which are never
     * called, since dispatch reaches exactly one). */
    commands?: Partial<CommandRegistry>;
    stderr?: (line: string) => void;
    /** Environment for the npm swallowed-flag guard. Default: `process.env`. */
    env?: Record<string, string | undefined>;
    /** §6.8 — the per-command daemon-liveness warning. Returns the warning
     * line to print, or `undefined` for silence. Injected so no test here
     * touches a real pidfile on disk. Default: `defaultCheckDaemonLiveness`
     * below, which is silent when the pidfile is absent OR unparseable
     * (`readDaemonPidfile` already collapses both to `undefined` — §6.2's
     * reader rule) and warns only when it EXISTS and shows a dead pid or a
     * stale heartbeat — deliberately narrower than `daemonLivenessCheck`
     * (`ops/doctor/aggregate.ts`), which also warns on a missing pidfile as
     * useful information on that opt-in surface; a blanket per-command nag
     * for "you've never run `serve start`" would be unwelcome noise here. */
    checkDaemonLiveness?: () => string | undefined;
  }
  ```

  Add the default implementation just above `const USAGE`, replacing:

  ```ts
  const USAGE = [
  ```

  with:

  ```ts
  function defaultCheckDaemonLiveness(): string | undefined {
    const pidfileDeps = defaultDaemonPidfileDeps();
    const file = readDaemonPidfile(process.cwd(), pidfileDeps);
    if (!file) return undefined; // absent or unparseable — both silent.
    if (!pidfileDeps.pidIsAlive(file.pid)) {
      return (
        "warning: jobbunny daemon is not running (stale pidfile) — scheduled runs will not " +
        "fire until 'jobbunny serve start'"
      );
    }
    const heartbeatAgeMs = pidfileDeps.now().getTime() - Date.parse(file.lastTickAt);
    if (heartbeatAgeMs > HEARTBEAT_STALE_MS) {
      return 'warning: jobbunny daemon appears wedged (no tick in over 5 minutes) — scheduled runs may not fire';
    }
    return undefined;
  }

  const USAGE = [
  ```

  Call it at the top of `main`, replacing:

  ```ts
  export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
    const commands = { ...defaultCommands(), ...deps.commands };
    const stderr = deps.stderr ?? ((line: string) => console.error(line));
  ```

  with:

  ```ts
  export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
    const commands = { ...defaultCommands(), ...deps.commands };
    const stderr = deps.stderr ?? ((line: string) => console.error(line));

    // §6.8: every command warns, first thing, when the daemon pidfile
    // exists but shows no live daemon — before anything else runs.
    const checkDaemonLiveness = deps.checkDaemonLiveness ?? defaultCheckDaemonLiveness;
    const livenessWarning = checkDaemonLiveness();
    if (livenessWarning) stderr(livenessWarning);
  ```

- [ ] **Step 8: Add two tests to `main.test.ts`.**

  Append to `/Users/harishamutha/Job-bunny/src/cli/main.test.ts`:

  ```ts
  test('main: prints the daemon-liveness warning, first, when one is returned', async () => {
    const stderr = captureStderr();
    const code = await main(['doctor', '--profile', 'rajni'], {
      commands: { doctor: async () => 0 },
      stderr: stderr.write,
      checkDaemonLiveness: () => 'warning: jobbunny daemon appears wedged (no tick in over 5 minutes)',
    });
    assert.equal(code, 0);
    assert.ok(stderr.lines[0]?.includes('appears wedged'));
  });

  test('main: prints nothing when checkDaemonLiveness returns undefined', async () => {
    const stderr = captureStderr();
    const code = await main(['doctor', '--profile', 'rajni'], {
      commands: { doctor: async () => 0 },
      stderr: stderr.write,
      checkDaemonLiveness: () => undefined,
    });
    assert.equal(code, 0);
    assert.deepEqual(stderr.lines, []);
  });
  ```

- [ ] **Step 9: Run both test files and see everything pass.**

  ```bash
  node --test src/ops/doctor/aggregate.test.ts src/cli/main.test.ts
  ```

  Expected: `# fail 0` across both files.

- [ ] **Step 10: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 11: Commit.**

  ```bash
  git add src/ops/doctor/aggregate.ts src/ops/doctor/aggregate.test.ts src/cli/main.ts src/cli/main.test.ts
  git commit -m "$(cat <<'EOF'
  feat(doctor): add claude-on-PATH and daemon-liveness checks; warn per-command

  claudeOnPathCheck (D13) makes the structure stage's hard `claude` CLI
  dependency a red doctor/preflight finding instead of a mid-run
  failure. daemonLivenessCheck (§6.8) surfaces a down or wedged daemon
  as warn — including on a missing pidfile, useful information on this
  opt-in surface. Both join coreChecks()'s fixed-order array. main.ts
  separately warns to stderr on EVERY command when the pidfile EXISTS
  but shows no live daemon (dead pid or stale heartbeat) — deliberately
  silent when no pidfile exists at all (§6.2's reader rule collapses
  absent/unparseable to the same case), unlike the doctor check, so a
  user who has never run `serve start` isn't nagged on every command.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 12: delete the launchd scheduler

**Files:**
- Delete: `/Users/harishamutha/Job-bunny/src/ports/scheduler.ts`
- Delete: `/Users/harishamutha/Job-bunny/src/adapters/scheduler/launchd/index.ts`
- Delete: `/Users/harishamutha/Job-bunny/src/adapters/scheduler/launchd/launchd.ts`
- Delete: `/Users/harishamutha/Job-bunny/src/adapters/scheduler/launchd/launchd.test.ts`
- Delete: `/Users/harishamutha/Job-bunny/src/adapters/scheduler/launchd/plist.ts`
- Delete: `/Users/harishamutha/Job-bunny/src/adapters/scheduler/launchd/plist.test.ts`
- Delete: `/Users/harishamutha/Job-bunny/src/cli/commands/schedule.ts`
- Delete: `/Users/harishamutha/Job-bunny/src/cli/commands/schedule.test.ts`
- Delete: `/Users/harishamutha/Job-bunny/test/invariants/run_cap_backstop.test.ts` (see the gap note directly below — a real gap found while writing this task, not part of the original decomposition, fixed here because leaving it would break `npm run check` the moment Step 1 runs)
- Modify: `/Users/harishamutha/Job-bunny/src/cli/wire.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/cli/main.ts`
- Modify: `/Users/harishamutha/Job-bunny/src/cli/main.test.ts` (B4 — see the second gap note below: four `schedule`-touching tests survive `main.ts`'s own edits above and must be deleted here, or Step 7's `npm run check` cannot pass)

This task comes LAST among the code tasks because `serve` (Task 9) must exist before `schedule` is removed — there is no gap where neither triggering surface is wired.

**Gap found while writing this task, fixed here (not a redesign):** `test/invariants/run_cap_backstop.test.ts` (outside `src/`, one of the two documented boundary exceptions) statically imports `DEFAULT_RUN_CAP_MS` from `src/adapters/scheduler/launchd/plist.ts` specifically to assert it exceeds `computeRunCapMs()`'s live-derived value — guarding against exactly the class of bug D3's revision log describes (a hand-copied literal that silently drifts from the real stage table). Deleting `plist.ts` without also deleting this test would leave a dangling import that fails `node --test "test/**/*.test.ts"` the moment Step 1 runs, breaking `npm run check` for the rest of this task's own steps. The invariant this test guards is not carried forward to a new location — it is structurally eliminated by Task 8's design: `createSpawnRun`'s backstop is armed at `deps.runCapMs + BACKSTOP_MARGIN_MS`, where `runCapMs` is `computeRunCapMs()`'s OWN live-derived value (never a separate hardcoded constant), so the backstop margin can no longer drift below the derived cap by construction — there is nothing left for a regression test to catch. Deleted, not migrated, per this task's own "deletes tests rather than adding them" framing.

**Rationale for deleting the PORT and not replacing it, stated once:** the `Scheduler` interface's `install`/`remove`/`list` semantics describe registering jobs with an external OS registry, which a live daemon is not. No successor port exists; `src/ops/daemon/` is orchestration (D2/D14), not a `Scheduler` implementation — it never registers anything with an external scheduler, it spawns child processes directly.

**B4 — second gap found while writing this task, fixed here (not a redesign):** `src/cli/main.test.ts` has four tests exercising the now-deleted `schedule` action (`'main: "schedule install" needs NO --profile — it is cross-profile'`, `'"schedule remove" does require --profile'`, `'"schedule remove" without --profile returns 2'`, `'an unknown schedule action returns 2'`, around lines 239–271 of the file as it stands after Tasks 9–11). Step 5 above removes `schedule`'s own `buildOptions` case, `CommandName` member, and `defaultCommands`/`COMMAND_NAMES` entries — all four of these tests would then fail (dispatching an action `buildOptions` no longer recognizes), so `npm run check` cannot pass until they too are deleted. Fixed here, in the same task that deletes their subject, per the same principle as the `run_cap_backstop.test.ts` gap above: a test for deleted behavior does not survive the deletion. Coverage does not merely shrink, though — Step 6 below adds the `serve`/`autostart` usage-error equivalents the `schedule`-era tests never had counterparts for.

**Interfaces:** none produced or consumed — this task only deletes and mechanically re-derives the diff against the composed state Tasks 9–11 already put `main.ts`/`wire.ts` in.

- [ ] **Step 1: Delete the scheduler port and the entire `launchd` adapter family.**

  ```bash
  git rm src/ports/scheduler.ts
  git rm -r src/adapters/scheduler
  ```

  `git rm -r src/adapters/scheduler` removes all 5 files (`index.ts`, `launchd.ts`, `launchd.test.ts`, `plist.ts`, `plist.test.ts`, ~1012 lines total per the spec's §4.1 count) and the now-empty `launchd/` and `scheduler/` directories.

- [ ] **Step 2: Delete the `schedule` CLI command and its test.**

  ```bash
  git rm src/cli/commands/schedule.ts src/cli/commands/schedule.test.ts
  ```

- [ ] **Step 3: Delete the now-structurally-obsolete `run_cap_backstop` invariant test (see the gap note above).**

  ```bash
  git rm test/invariants/run_cap_backstop.test.ts
  ```

  If this leaves `test/invariants/` empty, it is simply not tracked further by git (no empty-directory placeholder to clean up).

- [ ] **Step 4: Remove `wireScheduler`/`runLaunchctl` and their imports from `wire.ts`; update the header doc comment.**

  In `/Users/harishamutha/Job-bunny/src/cli/wire.ts`, update the header comment, replacing:

  ```ts
   * `wire()` ties the checks assembly to the REAL registry (built inline
   * below, alongside the live adapter construction — the only two places
   * adapters are constructed) and returns `{ ctx, stages, routines, checks }`.
   *
   * `wireScheduler()` is a second, independent composition point: the
   * `schedule` CLI command (`cli/commands/schedule.ts`) is the only caller
   * that needs a `Scheduler` (`ports/scheduler.ts`), and it's deliberately
   * NOT part of `PipelineCtx`/`wire()`'s normal per-profile run path (P8
   * Task 3 descoped it — a scheduler has no role in an actual pipeline
   * run). It returns the real `LaunchdScheduler` wired to a real `launchctl`
   * command runner; the command injects a fake in tests.
   */
  ```

  with:

  ```ts
   * `wire()` ties the checks assembly to the REAL registry (built inline
   * below, alongside the live adapter construction — the only two places
   * adapters are constructed) and returns `{ ctx, stages, routines, checks }`.
   *
   * There is deliberately no `wireScheduler()`/`Scheduler` port here anymore
   * (D14): `src/ports/scheduler.ts` and `src/adapters/scheduler/launchd/`
   * were deleted wholesale once the in-process daemon (`jobbunny serve
   * start|stop|status`, `src/ops/daemon/`, `src/cli/commands/serve.ts`)
   * replaced launchd triggering. The `Scheduler` interface's `install`/
   * `remove`/`list` semantics described registering jobs with an external OS
   * registry — a concept a live daemon doesn't have. No successor port
   * replaces it; the daemon is not a `Scheduler` implementation.
   */
  ```

  Remove the two now-unused stdlib imports, replacing:

  ```ts
  import { execFile } from 'node:child_process';
  import { readFile as fsReadFile } from 'node:fs/promises';
  import path from 'node:path';
  import { promisify } from 'node:util';
  import { z } from 'zod';
  ```

  with:

  ```ts
  import { readFile as fsReadFile } from 'node:fs/promises';
  import path from 'node:path';
  import { z } from 'zod';
  ```

  Remove the `LaunchdScheduler` import, replacing:

  ```ts
  import { LaunchdScheduler } from '../adapters/scheduler/launchd/index.ts';
  import type { RegistryPolicy } from '../core/company/schema.ts';
  ```

  with:

  ```ts
  import type { RegistryPolicy } from '../core/company/schema.ts';
  ```

  Remove the `Scheduler` type import, replacing:

  ```ts
  import type { ApiLane, FarmingLane, Lane } from '../ports/lane.ts';
  import type { Scheduler } from '../ports/scheduler.ts';
  import type { Storage } from '../ports/storage.ts';
  ```

  with:

  ```ts
  import type { ApiLane, FarmingLane, Lane } from '../ports/lane.ts';
  import type { Storage } from '../ports/storage.ts';
  ```

  Delete the entire `wireScheduler()` section — everything from the section
  header through the end of the file — replacing:

  ```ts
    return { ctx, stages, routines, checks };
  }

  // --- wireScheduler() ---

  /** Runs `launchctl`, adapting `child_process.execFile`'s reject-on-nonzero
   * behavior into `CommandRunner`'s resolve-with-exit-code contract
   * (`adapters/scheduler/launchd/launchd.ts`) — `LaunchdScheduler` itself
   * tolerates either shape for the one call it expects to fail harmlessly
   * (`bootout` on a not-yet-loaded job), but giving it a real exit code
   * keeps `bootstrap` failures reported with the process's own stdout
   * rather than a generic `Error` message. */
  const execFileAsync = promisify(execFile);

  async function runLaunchctl(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; exitCode: number }> {
    try {
      const { stdout } = await execFileAsync(command, args);
      return { stdout, exitCode: 0 };
    } catch (err) {
      const failure = err as { stdout?: string; code?: number };
      return {
        stdout: failure.stdout ?? '',
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
      };
    }
  }

  /** Builds the real `Scheduler` — a `LaunchdScheduler` over real `launchctl`
   * calls. The only caller is `cli/commands/schedule.ts`'s `defaultDeps`;
   * every test injects a fake `Scheduler` instead. */
  export function wireScheduler(): Scheduler {
    return new LaunchdScheduler({ run: runLaunchctl });
  }
  ```

  with:

  ```ts
    return { ctx, stages, routines, checks };
  }
  ```

- [ ] **Step 5: Remove `schedule` from `main.ts`, against the state left by Tasks 9–11.**

  In `/Users/harishamutha/Job-bunny/src/cli/main.ts`, remove the `scheduleCommand` import, replacing:

  ```ts
  import { runCommand } from './commands/run.ts';
  import { scheduleCommand } from './commands/schedule.ts';
  import { serveCommand } from './commands/serve.ts';
  ```

  with:

  ```ts
  import { runCommand } from './commands/run.ts';
  import { serveCommand } from './commands/serve.ts';
  ```

  Update the module doc comment's cross-profile note, replacing:

  ```ts
   * options translation lives in `buildOptions`, which hands each command ONLY
   * the keys it reads (never an irrelevant key set to `undefined`) and returns
   * a usage error when a required piece is missing. `schedule install`,
   * `serve` (all three sub-actions), and `release` are cross-profile by
   * design and take no `--profile`.
  ```

  with:

  ```ts
   * options translation lives in `buildOptions`, which hands each command ONLY
   * the keys it reads (never an irrelevant key set to `undefined`) and returns
   * a usage error when a required piece is missing. `serve` (all three
   * sub-actions), `autostart` (darwin only), and `release` are cross-profile
   * by design and take no `--profile`.
  ```

  Fix the now-stale `launchd` reference in the `dotenv/config` rationale comment, replacing:

  ```ts
   * `dotenv/config` is imported FIRST, for its side effect only: `NOTION_TOKEN`
   * and `TELEGRAM_BOT_TOKEN` live in the gitignored `.env`, and launchd hands a
   * scheduled run a minimal environment that does not include them. Without this
  ```

  with:

  ```ts
   * `dotenv/config` is imported FIRST, for its side effect only: `NOTION_TOKEN`
   * and `TELEGRAM_BOT_TOKEN` live in the gitignored `.env`, and a daemon-spawned
   * scheduled run (`ops/daemon/supervise`) inherits a minimal environment that
   * does not include them. Without this
  ```

  Remove `'schedule'` from `CommandName`, replacing:

  ```ts
  export type CommandName =
    | 'run'
    | 'doctor'
    | 'reconcile'
    | 'stage'
    | 'routine'
    | 'schedule'
    | 'serve'
    | 'autostart'
    | 'lane'
    | 'profile'
    | 'setup'
    | 'release';
  ```

  with:

  ```ts
  export type CommandName =
    | 'run'
    | 'doctor'
    | 'reconcile'
    | 'stage'
    | 'routine'
    | 'serve'
    | 'autostart'
    | 'lane'
    | 'profile'
    | 'setup'
    | 'release';
  ```

  Remove the `schedule` lines from `USAGE`, replacing:

  ```ts
    '  schedule install                     (cross-profile — no --profile)',
    '  schedule remove --profile <name>',
    '  serve start|stop|status              (cross-profile — no --profile)',
    '  autostart enable|disable             (cross-profile — darwin only)',
    '  lane add-url <url> [label] --profile <name>',
  ```

  with:

  ```ts
    '  serve start|stop|status              (cross-profile — no --profile)',
    '  autostart enable|disable             (cross-profile — darwin only)',
    '  lane add-url <url> [label] --profile <name>',
  ```

  Remove the `schedule` entry from `defaultCommands`, replacing:

  ```ts
      schedule: scheduleCommand as unknown as CommandFn,
      serve: (async (opts: CommandOptions) =>
        serveCommand({
          action: (opts.action ?? 'status') as 'start' | 'stop' | 'status',
          daemonChild: opts.daemonChild ?? false,
        })) as CommandFn,
      autostart: (async (opts: CommandOptions) =>
        autostartCommand({ action: (opts.action ?? 'enable') as 'enable' | 'disable' })) as CommandFn,
      lane: laneAddUrlCommand as unknown as CommandFn,
  ```

  with:

  ```ts
      serve: (async (opts: CommandOptions) =>
        serveCommand({
          action: (opts.action ?? 'status') as 'start' | 'stop' | 'status',
          daemonChild: opts.daemonChild ?? false,
        })) as CommandFn,
      autostart: (async (opts: CommandOptions) =>
        autostartCommand({ action: (opts.action ?? 'enable') as 'enable' | 'disable' })) as CommandFn,
      lane: laneAddUrlCommand as unknown as CommandFn,
  ```

  Remove `'schedule'` from `COMMAND_NAMES`, replacing:

  ```ts
  const COMMAND_NAMES = new Set<string>([
    'run',
    'doctor',
    'reconcile',
    'stage',
    'routine',
    'schedule',
    'serve',
    'autostart',
    'lane',
    'profile',
    'setup',
    'release',
  ]);
  ```

  with:

  ```ts
  const COMMAND_NAMES = new Set<string>([
    'run',
    'doctor',
    'reconcile',
    'stage',
    'routine',
    'serve',
    'autostart',
    'lane',
    'profile',
    'setup',
    'release',
  ]);
  ```

  Remove the `'schedule'` case from `buildOptions`'s `switch`, replacing:

  ```ts
      case 'schedule': {
        const action = rest[0];
        if (action !== 'install' && action !== 'remove') {
          return { error: 'schedule takes "install" or "remove"' };
        }
        // `install` is deliberately cross-profile: it reads every profile's
        // schedule and installs one launchd job per distinct time.
        if (action === 'install') return { action };
        return needsProfile() ?? { action, profile };
      }
      case 'serve': {
  ```

  with:

  ```ts
      case 'serve': {
  ```

- [ ] **Step 6: Update `main.test.ts` (B4) — delete the four now-dead `schedule` tests, add `serve`/`autostart` unknown-action equivalents so coverage does not shrink.**

  In `/Users/harishamutha/Job-bunny/src/cli/main.test.ts`, replace:

  ```ts
  test('main: "schedule install" needs NO --profile — it is cross-profile', async () => {
    const s = spy();
    const code = await main(['schedule', 'install'], {
      commands: { schedule: s.make('schedule') },
    });
    assert.equal(code, 0);
    assert.deepEqual(s.calls, [['schedule', { action: 'install' }]]);
  });

  test('main: "schedule remove" does require --profile', async () => {
    const s = spy();
    const code = await main(['schedule', 'remove', '--profile', 'rajni'], {
      commands: { schedule: s.make('schedule') },
    });
    assert.equal(code, 0);
    assert.deepEqual(s.calls, [['schedule', { action: 'remove', profile: 'rajni' }]]);
  });

  test('main: "schedule remove" without --profile returns 2', async () => {
    const code = await main(['schedule', 'remove'], {
      commands: { schedule: async () => 0 },
      stderr: () => {},
    });
    assert.equal(code, 2);
  });

  test('main: an unknown schedule action returns 2', async () => {
    const code = await main(['schedule', 'bogus'], {
      commands: { schedule: async () => 0 },
      stderr: () => {},
    });
    assert.equal(code, 2);
  });
  ```

  with:

  ```ts
  test('main: an unknown serve action returns 2, naming "start", "stop", or "status"', async () => {
    const stderr = captureStderr();
    const code = await main(['serve', 'bogus'], {
      commands: { serve: async () => 0 },
      stderr: stderr.write,
    });
    assert.equal(code, 2);
    assert.match(stderr.lines.join('\n'), /"start", "stop", or "status"/);
  });

  test('main: an unknown autostart action returns 2, naming "enable" or "disable"', async () => {
    const stderr = captureStderr();
    const code = await main(['autostart', 'bogus'], {
      commands: { autostart: async () => 0 },
      stderr: stderr.write,
    });
    assert.equal(code, 2);
    assert.match(stderr.lines.join('\n'), /"enable" or "disable"/);
  });
  ```

  Net effect: four tests for deleted behavior removed, two new usage-error tests added for the surfaces that actually ship now — coverage for a malformed action string moves from `schedule` to `serve`/`autostart`, it does not shrink. Run `node --test src/cli/main.test.ts` and confirm `# fail 0` before moving on.

- [ ] **Step 7: Run `npm run boundaries` explicitly — deleting a port and an adapter family is exactly the kind of change dependency-cruiser catches.**

  ```bash
  npm run boundaries
  ```

  Expected: green — no dangling edge into the deleted `src/ports/scheduler.ts` or `src/adapters/scheduler/**` remains anywhere in `src/`. If this fails, it names the exact file that still imports one of the deleted paths; fix that import (it was almost certainly meant to be removed by Step 4 or 5 and was missed) before proceeding.

- [ ] **Step 8: Run the full gate.**

  ```bash
  npm run check
  ```

  Expected: green — no unused-import lint errors (both `execFile`/`promisify` in `wire.ts` were removed alongside their only callers in Step 4), no dangling type errors from the deleted `Scheduler`/`LaunchdScheduler` symbols, no dangling-import failure from the deleted `run_cap_backstop.test.ts` (Step 3), and no failure from `main.test.ts`'s four now-dead `schedule` tests (Step 6 — without that edit, this step cannot pass).

- [ ] **Step 9: Verify the deletion is complete.**

  ```bash
  grep -rn "launchctl\|LaunchAgents\|StartCalendarInterval" src/
  ```

  Expected: only matches inside `src/cli/commands/autostart.ts` (Task 10) — the migration-scan regex and cleanup-block text in `serve.ts` (also Task 9/10-owned, still legitimately present) plus `autostart.ts`'s own `launchctl bootstrap`/`bootout` calls. No match anywhere under `src/ports/`, `src/adapters/scheduler/`, or `src/cli/commands/schedule.ts` (both gone). This task deletes tests rather than adding them — Steps 7–8 (plus this grep) ARE the verification.

- [ ] **Step 10: Commit.**

  ```bash
  git add src/cli/wire.ts src/cli/main.ts src/cli/main.test.ts
  git commit -m "$(cat <<'EOF'
  refactor(scheduler): delete the launchd Scheduler port and adapter family

  src/ports/scheduler.ts, the entire src/adapters/scheduler/launchd/
  family (~1012 lines), and cli/commands/schedule.ts are deleted now
  that `jobbunny serve start|stop|status` (Task 9) and `jobbunny
  autostart enable|disable` (Task 10) fully replace launchd
  triggering. No successor port replaces `Scheduler` — its install/
  remove/list semantics described registering jobs with an external OS
  registry, a concept a live daemon doesn't have; `src/ops/daemon/` is
  orchestration, not a Scheduler implementation. wire.ts's
  `wireScheduler`/`runLaunchctl` and their now-unused execFile/
  promisify imports go with it. Also deletes
  test/invariants/run_cap_backstop.test.ts, whose DEFAULT_RUN_CAP_MS-
  vs-computeRunCapMs() guard is structurally obsolete: Task 8's
  backstop is armed at runCapMs + BACKSTOP_MARGIN_MS using the SAME
  live-derived runCapMs, so the hand-copied-literal drift this test
  guarded against can no longer occur. main.test.ts's four schedule-
  action tests go with it, replaced by unknown-action equivalents for
  serve/autostart so coverage does not shrink (B4).

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 13: same-change documentation updates (D23)

**Files:**
- Modify: `/Users/harishamutha/Job-bunny/CLAUDE.md`
- Modify: `/Users/harishamutha/Job-bunny/.claude/agents/explainer.md`
- Modify: `/Users/harishamutha/Job-bunny/.claude/agents/executor.md` (checked first — Step 1 confirms it references the scheduler port/adapter family; it does, so it is edited)
- Modify: `/Users/harishamutha/Job-bunny/README.md`

**Rationale, stated once:** CLAUDE.md's own hard rule — "Markdown is code here" — requires architecture docs to be updated in the SAME change that alters behavior, not as a follow-up; this port deletes an entire adapter family (Task 12) and changes documented platform scope (Tasks 9/10), so D23 makes the obligation explicit rather than assumed. Every edit below is shown as a concrete before/after block against the file's REAL current text (verified by reading each file), not described in prose.

**Scope discipline, stated once:** this plan (the scheduling daemon) does NOT touch Chrome discovery — that is the companion `2026-07-27-cross-platform-foundation.md` plan's job (see this plan's own Global Constraints). Every edit below is careful to say "scheduling is now cross-platform" without overclaiming "Chrome discovery is now cross-platform" — the pipeline remains macOS-only in practice until the companion plan ships, and the wording says so explicitly rather than implying more than Tasks 1–12 actually deliver.

**S4 — cross-plan doc sequencing:** every "Chrome discovery is still hardcoded to macOS paths" pending-clause below assumes `2026-07-27-cross-platform-foundation.md` has NOT yet merged. If it HAS already merged by the time this task executes, drop those pending-clauses from Steps 2, 3, and 5 below and state cross-platform support outright instead — check that plan's own status (e.g. whether `src/adapters/browser/cdp-chrome/discovery/` already exists cross-platform on this branch) before copying any of this task's before/after blocks verbatim.

- [ ] **Step 1: Check whether `executor.md` references the scheduler port or adapter family, before editing anything.**

  ```bash
  grep -n "scheduler" .claude/agents/executor.md
  ```

  Expected (confirmed by reading the file while writing this plan): two hits, both in the placement decision tree — the ports list names `scheduler`, and the adapters-family list/example names `scheduler`/`scheduler/`. Since it references the deleted port and adapter family, it IS edited (Step 4 below); if a future re-run of this check found zero hits, Step 4 would be skipped and this file dropped from the commit's file list.

- [ ] **Step 2: Update `CLAUDE.md`.**

  Replace the "What this is" line:

  ```markdown
  Job Bunny is a personal job-search pipeline: it scrapes LinkedIn job searches with Playwright over Chrome CDP, pulls postings from keyless ATS APIs (Greenhouse, Keka), structures/filters/ranks them against a resume profile, and syncs the results to a per-profile Notion database, with optional Telegram digests. macOS only (launchd scheduling, hardcoded Chrome path). `src/` (TypeScript) is the only pipeline; v0 lives on the `main` branch for history — never reference `scripts/` as a live path. Architecture rationale lives in the explainer agent's KB (`.claude/agents/explainer.md`) — consult it before any architecture work; the original `main-v2.md` decision log is in git history.
  ```

  with:

  ```markdown
  Job Bunny is a personal job-search pipeline: it scrapes LinkedIn job searches with Playwright over Chrome CDP, pulls postings from keyless ATS APIs (Greenhouse, Keka), structures/filters/ranks them against a resume profile, and syncs the results to a per-profile Notion database, with optional Telegram digests. Scheduling is a cross-platform in-process daemon (`jobbunny serve start|stop|status`; darwin-only autostart via `jobbunny autostart enable|disable`), not launchd — but Chrome discovery is still hardcoded to macOS paths pending a companion cross-platform port, so the pipeline remains macOS-only in practice today. `src/` (TypeScript) is the only pipeline; v0 lives on the `main` branch for history — never reference `scripts/` as a live path. Architecture rationale lives in the explainer agent's KB (`.claude/agents/explainer.md`) — consult it before any architecture work; the original `main-v2.md` decision log is in git history.
  ```

  Add two lines to the `## Commands` code block, replacing:

  ```markdown
  node src/cli/main.ts stage <stage-name> --profile <name>
  node src/cli/main.ts routine <routine-name> --profile <name>
  ```
  ```

  with:

  ```markdown
  node src/cli/main.ts stage <stage-name> --profile <name>
  node src/cli/main.ts routine <routine-name> --profile <name>
  node src/cli/main.ts serve start|stop|status
  node src/cli/main.ts autostart enable|disable     # darwin only
  ```
  ```

  Replace the Profiles section's cross-profile exception sentence:

  ```markdown
  `--profile <name>` is required on every command except `schedule install` (cross-profile by design). `src/cli/wire.ts` is the only adapter-instantiation point: it validates `profile.json` and `filter.json` and wires the enabled names to constructors; a missing/invalid `profile.json` throws at wire time (`doctor` reports the same failure without throwing).
  ```

  with:

  ```markdown
  `--profile <name>` is required on every command except `serve` (all three sub-actions), `autostart` (darwin only), and `release` — all cross-profile by design. `src/cli/wire.ts` is the only adapter-instantiation point: it validates `profile.json` and `filter.json` and wires the enabled names to constructors; a missing/invalid `profile.json` throws at wire time (`doctor` reports the same failure without throwing).
  ```

  **Checked, not assumed — no edit needed:** the "Pipeline architecture" section's boundary table names layers generically (`adapters/`) and never names `scheduler`/`launchd` specifically anywhere in `CLAUDE.md` outside the two lines already replaced above (confirmed by `grep -n "scheduler\|launchd" CLAUDE.md` while writing this plan, which returns only the "What this is" line). The "Known limitations" section's sole entry (`farm`'s `jobsIn: 0`) is unrelated to scheduling — also checked, not affected.

- [ ] **Step 3: Update `.claude/agents/explainer.md`.**

  Replace the "What it is" line (§1):

  ```markdown
  **What it is.** Job Bunny is a personal, single-machine job-search pipeline. Several times a day it (a) scrapes saved LinkedIn job searches with Playwright over Chrome CDP, (b) pulls postings from keyless ATS APIs (Greenhouse, Keka), (c) structures/filters/ranks them against a resume profile, and (d) syncs survivors to a per-profile Notion database, with an optional Telegram digest. macOS-only (launchd scheduling, hardcoded Chrome path). Private, not on npm (`package.json` `"private": true`). `README.md:11-15`, `CLAUDE.md:7`.
  ```

  with:

  ```markdown
  **What it is.** Job Bunny is a personal, single-machine job-search pipeline. Several times a day it (a) scrapes saved LinkedIn job searches with Playwright over Chrome CDP, (b) pulls postings from keyless ATS APIs (Greenhouse, Keka), (c) structures/filters/ranks them against a resume profile, and (d) syncs survivors to a per-profile Notion database, with an optional Telegram digest. Scheduling is a cross-platform in-process daemon (`jobbunny serve start|stop|status`, `src/ops/daemon/`; darwin-only autostart via `jobbunny autostart enable|disable`) — `launchd` triggering was retired 2026-07-27. Chrome discovery is still hardcoded to macOS paths pending a companion cross-platform port, so the pipeline remains macOS-only in practice today. Private, not on npm (`package.json` `"private": true`). `README.md:11-15`, `CLAUDE.md:7`.
  ```

  Replace the locked-decisions table's row 5:

  ```markdown
  | 5 | macOS now, Linux-*ready* | platform code confined to `adapters/scheduler/launchd`, `adapters/browser/cdp-chrome`; no speculative Linux code, just clean seams |
  ```

  with:

  ```markdown
  | 5 | macOS now, Linux-*ready* | platform code confined to `adapters/browser/cdp-chrome` and (2026-07-27) `src/ops/daemon/` — the scheduling daemon is Node-stdlib-only and already cross-platform; no speculative Linux code, just clean seams. (`adapters/scheduler/launchd` — the original confinement point for scheduling — was deleted 2026-07-27; see §2.1/§6 below.) |
  ```

  Replace §2.3's "Four independent things" list:

  ```markdown
  `src/cli/wire.ts` is the **single composition point** — the only file permitted to import `src/adapters/**`. Four independent things:

  1. **Config loading** — `loadPipelineConfig` zod-validates `profiles/<name>/profile.json` (`PipelineConfigSchema`); `loadFilterConfig` same for `filter.json` (missing ⇒ `undefined`, invalid ⇒ throw). Fail-loud, deliberately redundant with doctor's `profileParsesCheck` (reports `red` without throwing).
  2. **Adapter-check assembly** — `assembleAdapterChecks(config, registry, deps)` is **pure**: maps `lanes`/`connector`/`notifiers` names onto a `CheckFactory` registry. Unknown name ⇒ loud throw.
  3. **Live composition** — builds `Lane[]`, `Connector`, `Notifier[]`, `Routine[]`, `LlmProvider`, `BrowserProvider`; returns `{ ctx, stages, routines, checks }`.
  4. **`wireScheduler()`** — separate composition point returning `LaunchdScheduler`; not on `PipelineCtx` (a scheduler has no role in a run).
  ```

  with:

  ```markdown
  `src/cli/wire.ts` is the **single composition point** — the only file permitted to import `src/adapters/**`. Three independent things (2026-07-27: `wireScheduler()`, a fourth, was deleted alongside the `Scheduler` port — see §2.1/§6):

  1. **Config loading** — `loadPipelineConfig` zod-validates `profiles/<name>/profile.json` (`PipelineConfigSchema`); `loadFilterConfig` same for `filter.json` (missing ⇒ `undefined`, invalid ⇒ throw). Fail-loud, deliberately redundant with doctor's `profileParsesCheck` (reports `red` without throwing).
  2. **Adapter-check assembly** — `assembleAdapterChecks(config, registry, deps)` is **pure**: maps `lanes`/`connector`/`notifiers` names onto a `CheckFactory` registry. Unknown name ⇒ loud throw.
  3. **Live composition** — builds `Lane[]`, `Connector`, `Notifier[]`, `Routine[]`, `LlmProvider`, `BrowserProvider`; returns `{ ctx, stages, routines, checks }`.
  ```

  Replace the `src/ports/` section header and body (§3):

  ```markdown
  ### `src/ports/` — 9 interfaces, no implementations

  `browser.ts` (`BrowserProvider`/`BrowserHandle`/`PageHandle` — every method takes `timeoutMs`), `connector.ts` (`rebuildCache`/`syncJobs`/`archiveStale`, `ArchivePolicy`), `context.ts` (`Logger`, `RunContext { profile, signal, logger, beat() }`), `doctor.ts` (`DoctorCheck/Finding/Report`, `ok|warn|red`), `lane.ts` (`FarmingLane.source → {jobs, dropped, companiesSeen}`; `ApiLane.probe/fetchBoard`), `llm.ts` (`complete(prompt, {signal})`), `notifier.ts` (digest|alert), `scheduler.ts` (`install/remove/list`), `storage.ts` (`readJson<T>(rel, schema)`/`writeJson`/`listSubdirs`/`removeTree`).
  ```

  with:

  ```markdown
  ### `src/ports/` — 8 interfaces, no implementations

  `browser.ts` (`BrowserProvider`/`BrowserHandle`/`PageHandle` — every method takes `timeoutMs`), `connector.ts` (`rebuildCache`/`syncJobs`/`archiveStale`, `ArchivePolicy`), `context.ts` (`Logger`, `RunContext { profile, signal, logger, beat() }`), `doctor.ts` (`DoctorCheck/Finding/Report`, `ok|warn|red`), `lane.ts` (`FarmingLane.source → {jobs, dropped, companiesSeen}`; `ApiLane.probe/fetchBoard`), `llm.ts` (`complete(prompt, {signal})`), `notifier.ts` (digest|alert), `storage.ts` (`readJson<T>(rel, schema)`/`writeJson`/`listSubdirs`/`removeTree`). (`scheduler.ts` — `install/remove/list` — was deleted 2026-07-27 alongside `adapters/scheduler/launchd/`; no successor port replaces it, since a live daemon isn't a `Scheduler`.)
  ```

  Replace the adapters table's `notify/telegram` row (removing the `scheduler/launchd` row that followed it):

  ```markdown
  | `notify/telegram` | Over global `fetch`. `chatId` validated at construction; **bot token read lazily from env at send time**. `botTokenCheck` hits `getMe` |
  | `scheduler/launchd` | `plist.ts` (pure XML; label `com.jobbunny.<HHMM>`, `["/bin/bash","-lc",cmd]`, `RunAtLoad: false`, logs `~/Library/Logs/JobBunny/`; embedded watchdog SIGTERM→20s→SIGKILL at `ceil(runCapMs/1000)+300`s; `DEFAULT_RUN_CAP_MS = 16_200_000`). `launchd.ts` (`install` = full **declarative reconcile** — stale plists booted+deleted; `remove` = list→drop→re-install; `list` parses profiles back from the plist command string) |
  ```

  with:

  ```markdown
  | `notify/telegram` | Over global `fetch`. `chatId` validated at construction; **bot token read lazily from env at send time**. `botTokenCheck` hits `getMe` |

  (`scheduler/launchd` — the plist/`launchctl` adapter family, ~1012 lines — was deleted wholesale 2026-07-27 once the in-process daemon replaced launchd triggering; see §2.1/§6.)
  ```

  Replace the `src/ops/` module bullet list:

  ```markdown
  ### `src/ops/`
  - `doctor/aggregate.ts` — core checks + `runChecks`; never throws — failing check = `red` finding. Adapter checks passed in by `wire()`.
  - `observability/` — `run_folder.ts` (`RunFolder(profileDataDir, date, time)`: `NN-<stage>.json`, `readLatestCheckpoint`, atomic, rooted at `runs/<date>/<time>/`; plus the folder-discovery helpers `formatRunTime` (local `HH-MM`), `latestTimeDir` (greatest existing time-subdir for a date), `nextTimeDir` (collision-avoiding fresh slot)), `result.ts` (`RunResultSchema` — `date`+`time`+outcome+per-stage funnel, `buildFunnel` — counts only *newly* dropped records, grouped by first failing rule), `logger.ts` (`JsonlLogger` → `run.log`, echoes to stdout on TTY, `flush()`), `digest.ts` (`formatDigest(RunResult)` → plaintext ✅/🔴 banner incl. date+time + funnel lines; in `ops/` because `cli/` may import `ops/**` never `adapters/**`).
  - `scheduling/run_lock.ts` — cross-process, cross-profile exclusive lock at `<root>/.jobbunny-run.lock` via `wx` create. Second run **skipped, not queued**. Stale if pid dead OR older than 4h default.
  ```

  with:

  ```markdown
  ### `src/ops/`
  - `doctor/aggregate.ts` — core checks + `runChecks`; never throws — failing check = `red` finding. 2026-07-27: gained `claudeOnPathCheck` (D13, `red` — the `claude` CLI on `PATH`) and `daemonLivenessCheck` (§6.8, `warn` — including on a missing pidfile). Adapter checks passed in by `wire()`.
  - `daemon/` (2026-07-27) — the scheduling daemon: `pidfile.ts` (heartbeat `lastTickAt`, an `attempts` ledger, synchronous atomic updates — deliberately NOT `run_lock.ts`'s 4h staleness rule below, since the daemon lives for days, not one bounded run), `daemon.ts` (the 30s tick loop — heartbeat write before the reentrancy guard, sequential per-`(slot,profile)` spawn), `scan/` (profile-schedule + run-history filesystem scanning), `logs/` (`~/.jobbunny/logs/`, asymmetric rotation), `supervise/` (the real child spawn — rotate-then-spawn, SIGTERM→20s→SIGKILL backstop at `runCapMs+300s`, a faithful port of the retired plist watchdog).
  - `observability/` — `run_folder.ts` (`RunFolder(profileDataDir, date, time)`: `NN-<stage>.json`, `readLatestCheckpoint`, atomic, rooted at `runs/<date>/<time>/`; plus the folder-discovery helpers `formatRunTime` (local `HH-MM`), `latestTimeDir` (greatest existing time-subdir for a date), `nextTimeDir` (collision-avoiding fresh slot)), `result.ts` (`RunResultSchema` — `date`+`time`+outcome+per-stage funnel, `buildFunnel` — counts only *newly* dropped records, grouped by first failing rule), `logger.ts` (`JsonlLogger` → `run.log`, echoes to stdout on TTY, `flush()`), `digest.ts` (`formatDigest(RunResult)` → plaintext ✅/🔴 banner incl. date+time + funnel lines; in `ops/` because `cli/` may import `ops/**` never `adapters/**`).
  - `scheduling/run_lock.ts` — cross-process, cross-profile exclusive lock at `<root>/.jobbunny-run.lock` via `wx` create. Second run **skipped, not queued**. Stale if pid dead OR older than 4h default. (Distinct from `ops/daemon/pidfile.ts`'s own pidfile — same directory convention, a different file, and a deliberately different staleness rule: one is a single bounded run, the other a process meant to live for days.)
  ```

  Replace the `src/cli/` bullet:

  ```markdown
  ### `src/cli/`
  `main.ts` (bin entry; `import 'dotenv/config'` **first and only here** — launchd hands a minimal env), `wire.ts`, `commands/`: run, doctor, reconcile, stage, routine, schedule, lane, profile, setup, release. Commands **return** exit codes; only the bin guard touches `process.exitCode`.
  ```

  with:

  ```markdown
  ### `src/cli/`
  `main.ts` (bin entry; `import 'dotenv/config'` **first and only here** — a daemon-spawned scheduled run hands a minimal env), `wire.ts`, `commands/`: run, doctor, reconcile, stage, routine, serve, autostart, lane, profile, setup, release. (`schedule` was deleted 2026-07-27 — see §2.1/§6.) Commands **return** exit codes; only the bin guard touches `process.exitCode`.
  ```

  Replace §6's "CLI surface" line:

  ```markdown
  **CLI surface** (`src/cli/main.ts` USAGE): run / doctor / reconcile / stage / routine / schedule install (cross-profile) / schedule remove / lane add-url / profile build|remove / setup / release. `--profile` required except `schedule install` and `release`.
  ```

  with:

  ```markdown
  **CLI surface** (`src/cli/main.ts` USAGE): run / doctor / reconcile / stage / routine / serve start|stop|status (cross-profile) / autostart enable|disable (cross-profile, darwin only) / lane add-url / profile build|remove / setup / release. `--profile` required except `serve`, `autostart`, and `release`.
  ```

  Replace §6's "Scheduling (launchd)." paragraph:

  ```markdown
  **Scheduling (launchd).** Times in `profile.json` `schedule.times`. `schedule install` enumerates every profile, hands the whole `ScheduledJob[]` set to `Scheduler.install` as one declarative reconcile. Profiles sharing a slot chain with `;` (sequential, shared Chrome). Each firing: `jobbunny run --profile <p> --headless`. Logs → `~/Library/Logs/JobBunny/`. Mac sleep: `sudo pmset repeat wakeorpoweron MTWRF <HH:MM:SS>`.
  ```

  with:

  ```markdown
  **Scheduling (in-process daemon, 2026-07-27).** Times/weekdays/grace live in `profile.json`'s `schedule` block (`times[]`, `enabled`, `weekdays[]` default Mon–Fri, `graceMinutes` default 90). `jobbunny serve start` splits into a parent (pidfile acquire, darwin legacy-plist migration refusal, detached spawn, 2s alive-confirm) and `--daemon-child` (the tick loop). Every 30s the daemon asks the pure `core/schedule/owed.ts`'s `isRunOwed(now, schedules, history)` which `(profile, slot)` pairs are owed — `history` merges real `runs/<date>/` folders with the pidfile's own `attempts` ledger, so a slot that crashed before its first checkpoint doesn't respawn every tick for the rest of its grace window. Owed slots run strictly sequentially, in `(slot, profileName)` order (one shared Chrome/CDP session), each firing `jobbunny run --profile <p> --headless` supervised by `ops/daemon/supervise/` (rotate `runs.log`, spawn, track `inFlight`, SIGTERM→20s→SIGKILL backstop at `runCapMs+300s` — a faithful port of the retired plist's embedded bash watchdog). `jobbunny serve stop` kills the daemon BEFORE any `inFlight` child (killing the child first could let the daemon spawn the next owed run before its own SIGTERM lands). `jobbunny serve status` reports liveness/uptime/wedged-heartbeat/next-fire, read-only. Darwin-only autostart: `jobbunny autostart enable` writes one `RunAtLoad`-only LaunchAgent (`com.jobbunny.autostart.plist`, no `StartCalendarInterval` — zero schedule knowledge) invoking `jobbunny serve start` at login; Windows/Linux autostart remain a documented manual step (README). Logs → `~/.jobbunny/logs/{daemon,runs}.log` (replaces the macOS-only `~/Library/Logs/JobBunny/`).
  ```

  Remove the now-deleted-test known-limitation entry, replacing:

  ```markdown
  8. dedup cache index keyed on title+company — same-title+company different-city entries overwrite.
  9. `test/invariants/run_cap_backstop.test.ts` enforces launchd `DEFAULT_RUN_CAP_MS` > derived run cap via the real `wire()`.
  ```

  with:

  ```markdown
  8. dedup cache index keyed on title+company — same-title+company different-city entries overwrite.
  ```

  (Item 9 is dropped, not renumbered — the list already has a pre-existing gap at 6 from an earlier removal, so non-contiguous numbering is the file's own established convention, not something this edit introduces. `test/invariants/run_cap_backstop.test.ts` was deleted in Task 12: its invariant is now structurally guaranteed by `createSpawnRun`'s `runCapMs + BACKSTOP_MARGIN_MS` construction rather than a separate hand-copied constant, so nothing is left for a regression test to catch.)

- [ ] **Step 4: Update `.claude/agents/executor.md`.**

  Replace the ports bullet in the placement decision tree:

  ```markdown
  - **A new capability interface** (something pipeline code needs to call but shouldn't know the concrete implementation of) → `src/ports/`. Existing ports: `browser`, `connector`, `context`, `doctor`, `lane` (`FarmingLane`/`ApiLane`), `llm`, `notifier`, `scheduler`, `storage`. Interface only, no implementation, and it may import nothing but `core`.
  ```

  with:

  ```markdown
  - **A new capability interface** (something pipeline code needs to call but shouldn't know the concrete implementation of) → `src/ports/`. Existing ports: `browser`, `connector`, `context`, `doctor`, `lane` (`FarmingLane`/`ApiLane`), `llm`, `notifier`, `storage`. Interface only, no implementation, and it may import nothing but `core`.
  ```

  Replace the adapters-family bullet:

  ```markdown
  - **An implementation of a port** — a new lane, connector, notifier, scheduler, LLM provider, or browser provider → `src/adapters/<family>/<name>/` (families: `browser/`, `db/`, `lanes/`, `llm/`, `notify/`, `scheduler/`). Wire it in **only** `src/cli/wire.ts` — no other file may import `src/adapters/**`. Example: a third ATS is one new `ApiLane` adapter under `src/adapters/lanes/<name>/`; the shared probe/fetch loop in `source` does the rest.
  ```

  with:

  ```markdown
  - **An implementation of a port** — a new lane, connector, notifier, LLM provider, or browser provider → `src/adapters/<family>/<name>/` (families: `browser/`, `db/`, `lanes/`, `llm/`, `notify/`). Wire it in **only** `src/cli/wire.ts` — no other file may import `src/adapters/**`. Example: a third ATS is one new `ApiLane` adapter under `src/adapters/lanes/<name>/`; the shared probe/fetch loop in `source` does the rest. (The scheduling daemon, `src/ops/daemon/`, is orchestration — `ops/` — not an adapter family: it spawns child processes directly rather than registering jobs with an external OS scheduler, so it has no port of its own and no `scheduler/` family exists anymore.)
  ```

- [ ] **Step 5: Update `README.md`.**

  Replace the Requirements section's macOS bullet:

  ```markdown
  - macOS (scheduling uses launchd; Chrome is expected at its standard path)
  ```

  with:

  ```markdown
  - macOS, Windows, or Linux — scheduling is a cross-platform in-process daemon, not an OS-level scheduler; see "Scheduled runs" below for autostart-at-login support per OS. Chrome discovery is still hardcoded to macOS paths pending a companion cross-platform port, so the pipeline remains macOS-only in practice today.
  ```

  Replace the Claude Code CLI requirement bullet:

  ```markdown
  - [Claude Code](https://claude.com/claude-code) CLI
  ```

  with:

  ```markdown
  - [Claude Code](https://claude.com/claude-code) CLI — the `claude` binary must resolve on `PATH`; `jobbunny doctor` checks this directly. Claude Code itself is cross-platform, so this is a prerequisite to install, not an OS blocker.
  ```

  **S1** — replace the day-2 command table's now-dead `schedule install` row:

  ```markdown
  | `jobbunny lane add-url <url> [label] --profile <name>` | Add a LinkedIn saved-search URL |
  | `/page-analyse` | Rebuild a page inventory from live DOM analysis |
  | `jobbunny schedule install` | Install launchd jobs from every profile's `schedule` in `profile.json` |
  | `jobbunny reconcile --profile <name>` | Rebuild the local cache from your Notion database |
  ```

  with:

  ```markdown
  | `jobbunny lane add-url <url> [label] --profile <name>` | Add a LinkedIn saved-search URL |
  | `/page-analyse` | Rebuild a page inventory from live DOM analysis |
  | `jobbunny serve start\|stop\|status` | Start/stop/check the in-process scheduling daemon (cross-profile) |
  | `jobbunny autostart enable\|disable` | Register/remove a login LaunchAgent that runs `serve start` at boot (darwin only) |
  | `jobbunny reconcile --profile <name>` | Rebuild the local cache from your Notion database |
  ```

  Replace the entire "Scheduled runs" section:

  ````markdown
  ## Scheduled runs

  Set times in your profile's `profile.json`:

  ```json
  "schedule": { "times": ["09:00", "14:00", "19:00"] }
  ```

  then run `jobbunny schedule install`. Each firing runs `jobbunny run --profile <name> --headless` with watchdogs for per-stage timeouts and stalls; profiles sharing a time slot are chained into one job and run strictly sequentially (they share one Chrome/CDP session). A Telegram digest is sent at the end of every run, success or failure. Mid-day reruns pick up newly posted jobs instead of redoing the day's work — farming resumes per URL (`--resume`). Per-profile run logs land in `profiles/<name>/data/runs/<date>/<HH-MM>/` (one folder per invocation, local start time); the launchd job's own stdout/stderr land in `~/Library/Logs/JobBunny/`.

  If your Mac regularly sleeps through a scheduled time, pre-wake it: `sudo pmset repeat wakeorpoweron MTWRF <HH:MM:SS>` a few minutes early (requires you to already be logged in — screen-locked is fine, logged out is not — and is most reliable on AC power with the lid closed).
  ````

  with:

  ````markdown
  ## Scheduled runs

  Set times in your profile's `profile.json`:

  ```json
  "schedule": { "times": ["09:00", "14:00", "19:00"] }
  ```

  then start the daemon once: `jobbunny serve start`. It ticks a wall clock every 30 seconds and reasons about "is a run owed right now" against local time — so a reboot or a sleeping laptop produces a *late* run within `schedule.graceMinutes` (default 90) of the missed slot, never a silently skipped one. Each firing runs `jobbunny run --profile <name> --headless` with the same per-stage timeout/stall watchdogs as any other invocation, plus an external SIGTERM/SIGKILL backstop; profiles sharing a time slot run strictly sequentially (they share one Chrome/CDP session). A Telegram digest is sent at the end of every run, success or failure. Mid-day reruns pick up newly posted jobs instead of redoing the day's work — farming resumes per URL (`--resume`). Per-profile run logs land in `profiles/<name>/data/runs/<date>/<HH-MM>/` (one folder per invocation, local start time); the daemon's own log and every spawned run's captured stdout/stderr land in `~/.jobbunny/logs/`.

  - `jobbunny serve status` reports whether the daemon is running, its uptime, whether it appears wedged, and the next scheduled slot.
  - `jobbunny serve stop` shuts it down cleanly.
  - **macOS**: `jobbunny autostart enable` registers a login LaunchAgent that runs `jobbunny serve start` at login — the LaunchAgent carries no schedule knowledge itself; the daemon's own tick loop decides when a run actually fires. `jobbunny autostart disable` removes it.
  - **Windows / Linux**: autostart-at-login isn't automated yet — run `jobbunny serve start` once after each login/boot, or register the OS-native "run at login" mechanism by hand (Task Scheduler on Windows, a systemd `--user` unit on Linux) pointing at `jobbunny serve start` with no arguments.

  Every `jobbunny` command warns to stderr when the daemon pidfile shows no live daemon, so a down daemon is loud the next time you run anything, on any platform.

  If your Mac regularly sleeps through a scheduled time, pre-wake it: `sudo pmset repeat wakeorpoweron MTWRF <HH:MM:SS>` a few minutes early (requires you to already be logged in — screen-locked is fine, logged out is not — and is most reliable on AC power with the lid closed).
  ````

- [ ] **Step 6: Run the full gate — documentation-only, but confirm nothing else broke in this final task.**

  ```bash
  npm run check
  ```

  Expected: green.

- [ ] **Step 7: Commit.**

  ```bash
  git add CLAUDE.md .claude/agents/explainer.md .claude/agents/executor.md README.md
  git commit -m "$(cat <<'EOF'
  docs: update CLAUDE.md, explainer/executor KBs, and README for the daemon (D23)

  Same-change documentation obligation for the scheduling-daemon port:
  CLAUDE.md's platform line and cross-profile exception, the
  explainer.md baked-in KB's scheduling/CLI-surface/adapter-inventory
  sections, executor.md's placement decision tree (scheduler port and
  adapter family both gone), and README's day-2 command table plus its
  Scheduled runs section (serve/autostart, the Windows/Linux manual
  alternative, and the claude CLI prerequisite) all move together. Scope is deliberately
  narrow to what Tasks 1-12 actually shipped: scheduling is now
  cross-platform, Chrome discovery is not (that is the companion
  cross-platform-foundation plan's job) — every edit says so rather
  than overclaiming.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 14: CI smoke test for the daemon lifecycle (S2)

**Files:**
- Modify: `/Users/harishamutha/Job-bunny/.github/workflows/test.yml`

**Interfaces:** N/A — this task edits a GitHub Actions workflow, not TypeScript.

**Placed here, last, deliberately:** every prior task's coverage is injected-dependency unit tests — nothing in Tasks 1–13 spawns a REAL detached child process, writes a REAL pidfile, or sends a REAL OS signal. This task is the one place that happens, on all three target OSes, closing that gap. It depends on `serve start|stop|status` (Task 9) existing and wired, so it cannot land any earlier; it depends on nothing from Tasks 1–13 beyond that CLI surface, so it is not itself part of the numbered spec-coverage table above.

**Rationale, stated once:** `.github/workflows/test.yml`'s `check` job (created by the companion `2026-07-27-cross-platform-foundation.md` plan's Task 1) already runs `npm run check`-equivalent steps (`npm run typecheck`/`lint`/`boundaries`/`npm test`) across a `macos-latest`/`ubuntu-latest`/`windows-latest` matrix. This task appends TWO more steps to that SAME job — it does not add a new job, and does not touch the matrix itself (that stays the foundation plan's concern). One `shell: bash` step is used deliberately so a single script works on all three runners — `shell: bash` resolves to Git Bash on the Windows runner, which is available there without any extra setup.

**A child run MAY be spawned during this test, and that is fine, not a defect:** `profiles/rajni/profile.json` (the committed fixture, present in every checkout) carries a real `schedule` block. If this step's few seconds of daemon uptime happen to overlap one of that schedule's slots (grace window included), the daemon WILL spawn `jobbunny run --profile rajni --headless` as a real child process on a CI runner with no Chrome, no Notion, and no `.env`. That child MUST fail fast — a red `doctor` preflight finding, or a `wire()` config throw before any stage runs — and it MUST NOT fail this job: the daemon supervises it as an ordinary nonzero-exit child (Task 8's `createSpawnRun`), logs the exit, and moves on. If it happens, treat it as a BONUS signal that the daemon correctly survives a failing child under real OS process semantics, not as something this task needs to prevent.

- [ ] **Step 1: Append the smoke-test step and its `if: always()` cleanup step to the `check` job.**

  In `/Users/harishamutha/Job-bunny/.github/workflows/test.yml`, replace the `check` job's final step:

  ```yaml
        - run: npm run boundaries
        - run: npm test

    test:
  ```

  with:

  ```yaml
        - run: npm run boundaries
        - run: npm test
        - name: daemon lifecycle smoke test (serve start/status/stop)
          shell: bash
          run: |
            node src/cli/main.ts serve start

            attempt=0
            running=""
            while [ "$attempt" -lt 10 ]; do
              if node src/cli/main.ts serve status; then
                running="1"
                break
              fi
              attempt=$((attempt + 1))
              sleep 1
            done

            if [ -z "$running" ]; then
              echo "serve status never reported a running daemon after 10 attempts (1s apart)" >&2
              exit 1
            fi

            # bash's default -e (errexit, GitHub Actions' default for
            # `shell: bash`) is the assertion here: a nonzero `serve stop`
            # exit fails this step without an explicit check.
            node src/cli/main.ts serve stop
        - name: daemon lifecycle cleanup (always)
          if: always()
          shell: bash
          # A leaked daemon from a step that failed BEFORE its own
          # `serve stop` line above must not poison the runner (or, for
          # self-hosted-style reuse, a future run) — `|| true` because a
          # cleanly-stopped daemon means this is expected to no-op.
          run: node src/cli/main.ts serve stop || true

    test:
  ```

  The existing `check` job's `strategy`/`matrix`/`runs-on: ${{ matrix.os }}` lines (foundation plan's Task 1) are untouched — both new steps run on all three OSes as part of the same job, same matrix.

- [ ] **Step 2: Verify by eye — same posture as the foundation plan's own Task 1 Step 2 (no local YAML-parsing tool in this repo).**

  ```bash
  git diff .github/workflows/test.yml
  ```

  Confirm by eye that the diff adds exactly the two new steps shown above, in that order, after the existing `npm test` step and before the `test:` job — nothing else in the file changes.

- [ ] **Step 3: Real verification, deferred to the first push — there is no local equivalent.**

  This task's actual proof is not local: the first push to a branch carrying this change must show, in each of the three `check (<os>)` runs, a green "daemon lifecycle smoke test" step (`serve start` succeeds, `serve status` reports running within 10 attempts, `serve stop` exits 0) and a green "daemon lifecycle cleanup" step that no-ops (the daemon is already stopped by the prior step in the success case). A transient spawn of `jobbunny run --profile rajni --headless` failing fast inside the daemon's own logs is expected and does not fail either step (see the rationale above) — only the daemon's own start/status/stop lifecycle is asserted.

- [ ] **Step 4: Commit.**

  ```bash
  git add .github/workflows/test.yml
  git commit -m "$(cat <<'EOF'
  ci: add a per-OS serve start/status/stop smoke test (S2)

  Every prior task's coverage is injected-dependency unit tests — none
  of them spawn a real detached child process, write a real pidfile, or
  send a real OS signal. This appends two steps to the existing `check`
  job's matrix (macOS/Linux/Windows): one shell: bash script that starts
  the daemon, polls `serve status` up to 10 times (1s apart) for a
  running report, then stops it (bash's default errexit asserts a zero
  exit); and an `if: always()` cleanup step so a step that fails before
  reaching its own `serve stop` line can't leak a daemon onto the
  runner. profiles/rajni's real `schedule` block means a run MAY
  transiently spawn during the test window — it will fail fast with no
  Chrome/Notion/.env on the runner, and must not fail the job; that is
  a bonus signal the daemon survives a failing child, not a risk this
  step needs to guard against.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Definition of done

- `npm run check` green locally and on all three CI OSes.
- `jobbunny serve start` then `serve status` shows a live daemon with a next-fire time; `serve stop` returns the tree to no daemon.
- `grep -rn "launchctl\|LaunchAgents\|StartCalendarInterval" src/` returns only Task 10's autostart code.
- `grep -rn "schedule install\|schedule remove" src/` returns nothing.
- `package.json` `dependencies` unchanged — still exactly `@notionhq/client`, `dotenv`, `playwright`, `zod`.
- A verification run against the committed fixture profile `profiles/rajni/` per the `verify` skill, never against `profiles/harish/`:

  ```bash
  node src/cli/main.ts doctor --profile rajni
  node src/cli/main.ts stage reconcile --profile rajni
  ```

  Expected: `doctor` reports the two new checks (`claude-cli-on-path`, `daemon-liveness`) alongside the existing four, with an overall status unaffected by scheduling (a `red` on `claude-cli-on-path` here would be a pre-existing environment fact — no `claude` on this machine's `PATH` — not a regression this plan introduces); `stage reconcile` still runs unmodified, since nothing in Tasks 1–13 touches the pipeline stages themselves, only what triggers `jobbunny run`.
- Task 14's CI smoke test (`serve start` → poll `serve status` → `serve stop`, plus its `if: always()` cleanup) is green on all three `check (<os>)` matrix runs — this is the end-to-end proof for the daemon lifecycle (real detached spawn, real pidfile, real OS signals) per OS, the one thing no injected-dependency unit test in Tasks 1–13 can reach.

## Self-review

Per the writing-plans skill, three checks, run against the finished Tasks 1–13 (this pass covers 8–13; Tasks 1–7 were reviewed when they were written):

**1. Spec coverage — every decision D1–D23 except D11/D12/D17 maps to a task.**

| Decision | Task(s) | Covered? |
|---|---|---|
| D1 Scope | Global Constraints / all tasks | Yes — framing only, no single task owns it |
| D2 Trigger model (daemon + darwin autostart) | 7 (daemon), 9 (`serve`), 10 (`autostart`) | Yes |
| D3 Supervisor model (child process, no in-process pipeline) | 8 (`createSpawnRun`), 9 (design note explicitly re-derives this constraint for `runCapMs`) | Yes |
| D4 No timer-to-next-fire (30s tick) | 7 (`TICK_MS`) | Yes (Task 7, pre-existing) |
| D5 Zero new runtime deps | 8/9/10 (all stdlib: `node:child_process`, `node:fs`, `node:os`, `node:url`, `node:util`) | Yes |
| D6 Cross-profile, sequential | 7 (pre-existing), 9 (`serve` takes no `--profile`) | Yes |
| D7 Failed runs count as served | 7 (pre-existing) | Yes |
| D8 Grace window | 1–3 (pre-existing) | Yes |
| D9 Slot-to-run-folder matching | 2–3 (pre-existing) | Yes |
| D10 `serve stop` daemon-first | 9 (`runServeStop`) | Yes |
| D13 `claude` CLI doctor check | 11 (`claudeOnPathCheck`) | Yes |
| D14 Deletions | 12 | Yes |
| D15 Migration scan | 9 (`serve start`'s scan), 10 (`autostart enable`'s identical scan) | Yes |
| D16 Logs to `~/.jobbunny/logs/` | 6 (pre-existing), 8/9 (consumers) | Yes |
| D18 Config schema extension | 1 (pre-existing) | Yes |
| D19 Attempts ledger | 5/7 (pre-existing), 9 (`serve status`'s own fold) | Yes |
| D20 Darwin autostart in scope; Win/Linux deferred | 10, 13 (README manual alternative) | Yes |
| D21 Daemon/run-child logging | 6 (pre-existing), 8 (rotate-then-spawn), 9 (daemon.log rotation) | Yes |
| D22 Heartbeat staleness, steal re-check | 5/7 (pre-existing), 9 (`serve start`'s 35s re-check), 11 (`daemonLivenessCheck`) | Yes |
| D23 Same-change docs | 13 | Yes |

D11 (Chrome discovery), D12 (pid-file-based Chrome ownership), D17 (CI matrix/hermetic testing) are explicitly excluded per the launching agent's own instruction — confirmed out of scope for this plan (D11/D12 belong to the companion cross-platform-foundation plan per this plan's Global Constraints; D17's CI matrix ITSELF is a foundation-plan `.github/workflows/test.yml` change, not something Tasks 8–13 touch — a later consolidated-review pass added Task 14, which appends two steps to that same file's existing `check` job without touching the matrix, still leaving matrix ownership with the foundation plan). **Gap found and fixed**: none of D1–D23 (excluding D11/D12/D17) was missing a task — the one real gap found during this pass was NOT a missing decision-to-task mapping but an internal consistency bug: `test/invariants/run_cap_backstop.test.ts` (pre-existing, outside `src/`) statically imports `DEFAULT_RUN_CAP_MS` from the file Task 12 deletes. Fixed by adding its deletion to Task 12 (Step 3) with a rationale for why the invariant it guarded is structurally subsumed by Task 8's `runCapMs + BACKSTOP_MARGIN_MS` construction, not silently dropped.

**2. Placeholder scan.**

```bash
grep -n "TBD\|TODO\|FIXME\|appropriate location\|similar to Task\|\.\.\." docs/superpowers/plans/2026-07-27-scheduling-daemon.md
```

Run mentally against every code block in Tasks 8–13 while writing them: zero hits inside a fenced code block. The string "..." appears only in prose (e.g. "SIGTERM → sleep 20 → SIGKILL", an arrow-adjacent ellipsis in running text, not a code placeholder) and inside literal bash/regex content (`git commit -m "$(cat <<'EOF' ... EOF)"` heredocs, which are real, runnable shell, not elided text). No step says "implement similarly" or defers a decision — every behavior rule listed in a task's prose is either implemented in that same task's code block or explicitly named as out of scope (e.g. Task 9's `--daemon-child` branch not getting a dedicated unit test, stated and justified, not silently skipped).

**3. Type consistency across all thirteen tasks.**

Cross-checked every interface Tasks 8–13 CONSUME against what Tasks 1–7 (and each other) PRODUCE, verbatim:

- `SpawnRun = (owed: OwedRun) => Promise<number>` (Task 7) ↔ `createSpawnRun(deps: SuperviseDeps): SpawnRun` (Task 8) — return type matches exactly; Task 9 assigns `createSpawnRun(superviseDeps)` straight into `DaemonDeps.spawnRun`, no cast needed.
- `DaemonPidfileDeps`/`DaemonPidfile`/`HEARTBEAT_STALE_MS`/`readDaemonPidfile`/`updateDaemonPidfile`/`acquireDaemonPidfile`/`releaseDaemonPidfile`/`isDaemonPidfileStale` (Task 5) — consumed identically by Task 8 (`supervise.ts`), Task 9 (`serve.ts`, both parent/child and `runServeStop`/`runServeStatus`), and Task 11 (`daemonLivenessCheck`, `main.ts`'s `defaultCheckDaemonLiveness`) — same field names (`pid`, `startedAt`, `lastTickAt`, `inFlight`, `attempts`) used consistently across all four.
- `LogDeps`/`rotateIfLarge`/`openAppendFd`/`runsLogPath`/`daemonLogPath` (Task 6) — consumed identically by Task 8 (`supervise.ts`'s per-child rotation) and Task 9 (`serve.ts`'s parent-side `daemon.log` rotation) — one asymmetry (per-spawn vs. start-only) preserved exactly as Task 6 specified it, not reinvented.
- `ScanDeps`/`scanProfileSchedules`/`scanRunHistory` (Task 4) — consumed identically by Task 9's `runServeStartChild` (via `DaemonDeps.scan`) and `runServeStatus` (folding `scanRunHistory` + the pidfile ledger, matching `daemon.ts`'s own D19 fold byte-for-byte in shape).
- `SIGKILL_GRACE_MS` (Task 8) — reused verbatim (not a second constant) by Task 9's `killAndConfirmDead`, per D10's own text ("the same `SIGKILL_GRACE_SECONDS = 20` constant").
- `computeRunCapMs(budgets?: readonly StageBudget[]): number` (`pipeline/stages/budgets.ts`, Task 8) — Task 9's `serve.ts` imports it directly and calls it with no arguments (`computeRunCapMs()`), defaulting to `STAGE_BUDGETS`; `cli/commands/run.ts` imports-and-re-exports the same function for its own call site (`computeRunCapMs(stages)`, a live wired `Array<StageDef<StagePayload, StagePayload>>`), which satisfies `readonly StageBudget[]` structurally since `StageDef` is a superset of `StageBudget`'s three fields. `STAGE_BUDGETS` itself was verified against every `pipeline/stages/*.ts` factory's real signature (`makeReconcileStage(connector: Connector)`, `makeFarmStage(lanes: FarmingLane[])`, `makeSourceStage(lanes, policy, opts)`, `makeStructureStage(llm: LlmProvider)`, `makeFilterStage(cfg: FilterConfig)`, `makeRankStage(cfg: RankConfig)`, `makeSyncStage(connector, opts)`) while writing Task 8, not assumed, and is kept honest going forward by `test/invariants/stage_budgets.test.ts`'s drift guard rather than by a one-time verification.
- `LEGACY_PLIST_REGEX`/`migrationCleanupBlock` — defined `const`/private `function` in Task 9, exported (visibility change only, same signatures) in Task 10 Step 1, consumed identically by `autostart.ts`.
- `DoctorCheck`/`DoctorFinding` (`ports/doctor.ts`, pre-existing) — Task 11's two new checks return the exact `{ check, status, detail }` shape every existing check already uses; no drift.
- `MainDeps`/`CommandOptions`/`CommandName`/`CommandFn` (pre-existing `cli/main.ts`) — Tasks 9, 10, and 11 each extend these additively (new union members, new optional fields) and Task 12 mechanically un-adds exactly Task 9's `'schedule'`-touching additions, verified line-for-line against the composed state left by the prior task rather than against the ORIGINAL pre-Task-9 file (a mistake that would have produced a diff that doesn't apply) — this is why Task 12's `main.ts` before/after blocks are reproduced against the Tasks-9-through-11-composed text, not the file's original content.

No type mismatch found across the six tasks.
