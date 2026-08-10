# Unified date/time display

Date: 2026-08-10
Status: approved, not yet planned

## Goal

Every human-facing date and time in Job Bunny renders in one fixed format, in the host's timezone:

```
10 Aug 2026 2:36 PM
```

The format is locale-independent. It does not vary with the host OS locale, the browser locale, or the ICU version.

## Non-goals

- No i18n or locale switching. The app is single-user and English-only.
- No date library (`date-fns`, `dayjs`, `moment`). Runtime deps stay at four.
- No change to *structural* time strings: checkpoint group names (`time_dir`, `HH-MM`), schedule slot times, and run-date partitions keep their current shapes. Reformatting them would rename directories and break resume.
- No change to duration rendering (`2m 5s`, live elapsed). A duration is not a timestamp.

## Background: three value kinds, not one

Recon established that what currently renders as "a date" is three distinct kinds:

| Kind | Fields | Storage |
|---|---|---|
| Instant | `dateFound`, `startedAt`, `finishedAt`, `heartbeatAt`, `ts`, `nextRunAt` | ISO 8601 UTC datetime |
| Date-only | `dateApplied`, `nextActionDate` | `YYYY-MM-DD` (`z.iso.date()`) |
| Duration | run elapsed, daemon uptime | computed from two instants |

A correction to earlier assumptions: `dateFound` **is a full instant**, not date-only. It is `scrapedAt`, defined `z.iso.datetime()` at `src/core/jd/schema.ts:21`, written at `src/adapters/db/sqlite/store/store.ts:63`, and stored as e.g. `2026-08-02T12:48:07.994Z`. The `.slice(0, 10)` used on job cards has been discarding a real time.

## The format primitive

Hand-rolled from local getters, not `Intl.DateTimeFormat`. This mirrors the existing idiom at `src/core/schedule/types.ts:71-83` (`formatLocalDate`, `localHhMm`) and is deterministic across ICU versions:

- `getDate()`, `getMonth()`, `getFullYear()`, `getHours()`, `getMinutes()`, `getSeconds()` — these are host-timezone by definition, which is exactly the requirement.
- A local `MONTHS` constant supplies `Jan`…`Dec`.
- Day and hour have no leading zero (`2 Aug`, `2:36 PM`). Minutes and seconds are zero-padded.
- Hour 0 renders as `12 AM`; hour 12 renders as `12 PM`.

`toLocaleString()` is removed from the codebase. Its only use is `ui/src/features/settings/sections/ScheduleSection.tsx:95`, where it currently makes the "next run" label change shape with the host OS locale.

## Public API

Module: `src/core/datetime/` — `index.ts` (public surface), `datetime.ts` (implementation), `datetime.test.ts`. Per the two-pair rule this is one implementation file, well under the split threshold.

Every function that produces relative output takes an explicit `now: Date`. No function reads the system clock internally. This matches `formatRunTime(now: Date)` at `src/ops/observability/run/time.ts:4` and makes every case testable against a frozen clock.

| Function | Input | Output |
|---|---|---|
| `formatInstant(iso: string, now: Date)` | ISO datetime | `Today 2:36 PM` / `Yesterday 9:00 AM` / `10 Aug 2026 2:36 PM` |
| `formatInstantFull(iso: string)` | ISO datetime | `10 Aug 2026 2:36:12 PM` — absolute, with seconds, never relative |
| `formatDate(ymd: string, now: Date)` | `YYYY-MM-DD` | `Today` / `Yesterday` / `Tomorrow` / `10 Aug 2026` |
| `formatRelative(iso: string, now: Date)` | ISO datetime | `just now` / `2 hours ago` / `in 3 days` |

`formatRelative` buckets: under 60s `just now`; under 60m `N minutes ago`; under 24h `N hours ago`; otherwise `N days ago`. Future instants use the `in N …` form. Singular and plural are both handled (`1 hour ago`, not `1 hours ago`).

Invalid or unparseable input returns `—` rather than throwing or rendering `Invalid Date`.

### Today / Yesterday / Tomorrow are calendar comparisons

The hint is computed by comparing local calendar days, not by a 24-hour delta. At 10 PM, an instant from 11 PM the previous night must read `Yesterday`, not `Today`. Implement by comparing `formatLocalDate()`-style Y/M/D triples in host time.

## Inline vs hover contract

Two requirements had to be reconciled: a relative hint inline for recent values, and an absolute value inline with relative on hover. The resolution:

- **Inline** = `formatInstant` — a hint when the value is recent, the absolute format otherwise.
- **Hover** = `formatInstantFull(iso) + ' · ' + formatRelative(iso, now)`, e.g. `10 Aug 2026 2:36:12 PM · 2 hours ago`.

Hover therefore always reveals what inline hides: the date behind `Today`, and the seconds behind an old absolute timestamp.

Hover uses the **native `title` attribute**. `ui/` has no tooltip component, no `TooltipProvider` mounted, and no `@radix-ui/react-tooltip` dependency. Introducing a component, a root provider, and styling in order to hint a timestamp on a localhost single-user board is not warranted.

## Call sites

### Board SPA

| Location | Now | Becomes |
|---|---|---|
| `ui/src/features/settings/sections/ScheduleSection.tsx:95` | `new Date(nextRunAt).toLocaleString()` | `formatInstant(nextRunAt, now)` |
| `ui/src/features/tracker/KanbanCard.tsx:48-50` | `row.dateFound.slice(0, 10)` | `formatInstant(row.dateFound, now)` |
| `ui/src/features/job/JobHeader.tsx:26` | `job.dateFound.slice(0, 10)` | `formatInstant(job.dateFound, now)` |
| `ui/src/features/tracker/KanbanCard.tsx:86` | raw `nextActionDate` | `formatDate(nextActionDate, now)` |
| `ui/src/features/tracker/DueStrip.tsx:27` | raw `nextActionDate` | `formatDate(nextActionDate, now)` |
| `ui/src/features/runs/RunDetailView.tsx:97` | `{event.ts}` (raw ISO) | `formatInstantFull(event.ts)` |
| run list row (the caller of `formatWhen`) | `formatWhen(row)` → `2026-08-05 09-00` | `formatInstant(row.startedAt, now)` |

Job cards gain a time they never displayed. This is intended: the value carries a time, so the time is shown.

The run list switches its source field from `date` + `timeDir` to `startedAt`. These denote the same moment; `timeDir` is the checkpoint group name and stays untouched as a structural string.

`nextActionDate` is a forward-looking field, which is why `formatDate` carries `Tomorrow`.

### CLI

CLI output uses `formatInstantFull` — **absolute always, never `Today`/`Yesterday`**. Terminal output is pasted into issues and logs, where relative words rot.

| Location | Now | Becomes |
|---|---|---|
| `src/cli/commands/runs.ts:88` | `${row.date} ${row.timeDir ?? '-'}` | `formatInstantFull(row.startedAt)` |
| `src/cli/commands/runs.ts:94` | `${ev.ts} …` (raw ISO) | `formatInstantFull(ev.ts)` |
| `src/cli/commands/serve/status.ts:45-46` | `${file.lastTickAt}` (raw ISO) | `formatInstantFull(file.lastTickAt)` |
| `src/cli/commands/serve/status.ts:63` | `next.at.toISOString()` | `formatInstantFull(next.at.toISOString())` |

The existing `(3m ago)` heartbeat-age suffix at `serve/status.ts:45-46` stays. It is a duration, not a timestamp.

## Untouched

`formatDuration` (both copies), `formatElapsed` (`ui/src/features/runs/LiveRunHeader.tsx:17-23`), `formatLocalDate` and `localHhMm` (`src/core/schedule/types.ts:71-83`), `formatRunTime` (`src/ops/observability/run/time.ts:4`).

The last three are structural, not display, formatters. Changing them would rename checkpoint directories.

## Deleted

`formatWhen()` in `ui/src/features/runs/runFormat.ts:18-19`, and its cases in `ui/src/features/runs/runFormat.test.ts:28-35`. `formatDuration` in the same file survives.

## Module placement and the Vite question

The formatter lives in `src/core/datetime/` and the SPA imports it **at runtime**.

This is a new coupling. `ui/` currently reaches into `src/ports` **type-only** (`ui/src/lib/api/types.ts`); types erase at build, so Vite never resolves them at runtime. A value import does require resolution.

Boundary rules are not violated: `npm run boundaries` cruises `src/**` only, and `core-is-pure` constrains what `core` may import, not who may import `core`. `src/core/datetime/` imports nothing.

**Task 1 of implementation is a feasibility spike**, before any call site is touched:

1. Add the `src/core/datetime/` module with one trivial export.
2. Import it from one `ui/` file.
3. Confirm all three of: `npm run ui:check` (tsconfig must resolve the path), `npm run ui:build` (Vite must bundle TS from outside the `ui/` root — likely needs `server.fs.allow` and/or a `resolve.alias` entry in `ui/vite.config.ts`), and `npm run check` (root gate still green).

**Fallback, pre-approved if the spike fails:** two copies — `src/core/datetime/` for the CLI, `ui/src/lib/datetime.ts` for the SPA — with a single shared fixture file of `{ input, now, expected }` rows imported by *both* test suites, so any drift fails CI rather than shipping silently. Do not attempt a third approach; report the spike result and take the fallback.

## Testing

`src/core/datetime/datetime.test.ts`, table-driven against a frozen `now`, covering for each function:

- today, yesterday, tomorrow, an older date, a future date
- the calendar-boundary case: 11 PM yesterday viewed at 10 PM today must read `Yesterday`
- midnight (`12:00 AM`) and noon (`12:00 PM`)
- single-digit day and single-digit hour (no leading zeros)
- second boundaries for `formatRelative` bucket edges: 59s, 60s, 59m, 60m, 23h, 24h
- singular vs plural (`1 hour ago` vs `2 hours ago`)
- invalid input returns `—`

`ui/src/features/runs/runFormat.test.ts` loses its `formatWhen` cases and keeps its `formatDuration` cases.

No Playwright e2e assertion currently matches a date-shaped string or the words `Found`, `Next run`, or `ago` — verified. Nothing in `npm run ui:e2e` breaks.

## Risks

- **Vite cross-root resolution.** The single largest unknown; gated behind the Task 1 spike with a pre-approved fallback.
- **`now` threading.** Components that render a hint need a `now` value. Passing `new Date()` at each render is acceptable — no ticking state, no interval, and the hint only changes at a day boundary.
- **Job-card density.** Cards gain roughly eight characters on the date line. If this crowds the layout, the fix is a card-layout change, not a format change.
- **`heartbeatAt` and `tracking.updatedAt`** exist on the API surface (`src/ports/run_store.ts:23-25`, `src/ports/board.ts:79`) but are not currently rendered. If they are surfaced later, they use `formatInstant`.
