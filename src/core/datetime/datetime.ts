/**
 * core/datetime/datetime.ts — the one hand-rolled local-time formatter
 * shared by the CLI and (at runtime, across the src/ui boundary) the board
 * SPA. Zero imports on purpose: this file is bundled directly into the
 * browser (see the unified-datetime-display spec,
 * docs/superpowers/specs/2026-08-10-unified-datetime-display-design.md), so
 * it can rely on nothing but the language runtime — no `node:` builtin, no
 * other `src/` module, no npm package. `datetime.test.ts` guards this by
 * reading this file's own source and asserting it has no `import` line.
 *
 * Local getters only — `getDate`/`getMonth`/`getFullYear`/`getHours`/
 * `getMinutes`/`getSeconds`, never `getUTC*`, never `toLocaleString`/
 * `Intl` — so output is deterministic across ICU versions and always
 * renders in the host's timezone. Mirrors the existing idiom at
 * `src/core/schedule/types.ts` (`formatLocalDate`/`localHhMm`).
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Returned for any unparseable/invalid input — never throw, never render
 * `Invalid Date`. */
const INVALID = '—';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** No leading zero on the hour; hour 0 -> 12 AM, hour 12 -> 12 PM. */
function hour12(hours: number): { h: number; meridiem: 'AM' | 'PM' } {
  const meridiem = hours < 12 ? 'AM' : 'PM';
  const h = hours % 12 === 0 ? 12 : hours % 12;
  return { h, meridiem };
}

function formatTime(d: Date): string {
  const { h, meridiem } = hour12(d.getHours());
  return `${h}:${pad2(d.getMinutes())} ${meridiem}`;
}

function formatTimeWithSeconds(d: Date): string {
  const { h, meridiem } = hour12(d.getHours());
  return `${h}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${meridiem}`;
}

/** No leading zero on the day. */
function formatCalendar(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function parseInstant(iso: string): Date | undefined {
  if (typeof iso !== 'string' || iso.length === 0) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Local calendar-day offset (`a` minus `b`, in whole days) — Today/
 * Yesterday/Tomorrow compare local calendar-day triples, never a 24h
 * delta, so 11 PM yesterday viewed at 10 PM today reads Yesterday rather
 * than "23 hours ago, not a day yet". Both dates are re-anchored to local
 * midnight before subtracting, which also makes this DST-safe. */
function dayOffset(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da.getTime() - db.getTime()) / 86_400_000);
}

/** `YYYY-MM-DD` parsed as a LOCAL calendar date — never
 * `new Date('YYYY-MM-DD')`, which JS parses as UTC midnight and which a
 * negative-offset host timezone would then read back one day early. Splits
 * the string manually and validates the three parts are integers whose
 * constructed Date round-trips to the same Y/M/D, which rejects
 * out-of-range dates like `2026-02-31` (JS's Date constructor would
 * otherwise silently roll it over to Mar 3). */
function parseLocalDate(ymd: string): Date | undefined {
  if (typeof ymd !== 'string') return undefined;
  const parts = ymd.split('-');
  if (parts.length !== 3) return undefined;
  const [ys, ms, ds] = parts;
  if (
    ys === undefined ||
    ms === undefined ||
    ds === undefined ||
    !/^\d+$/.test(ys) ||
    !/^\d+$/.test(ms) ||
    !/^\d+$/.test(ds)
  ) {
    return undefined;
  }
  const year = Number(ys);
  const month = Number(ms);
  const day = Number(ds);
  const d = new Date(year, month - 1, day);
  const roundTrips =
    d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
  return roundTrips ? d : undefined;
}

function pluralize(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** `Today 2:36 PM` / `Yesterday 9:00 AM` / `10 Aug 2026 2:36 PM` — the
 * inline form: a relative hint for a recent value, the absolute form
 * otherwise. */
export function formatInstant(iso: string, now: Date): string {
  const d = parseInstant(iso);
  if (d === undefined) return INVALID;
  const offset = dayOffset(d, now);
  if (offset === 0) return `Today ${formatTime(d)}`;
  if (offset === -1) return `Yesterday ${formatTime(d)}`;
  return `${formatCalendar(d)} ${formatTime(d)}`;
}

/** `10 Aug 2026 2:36:12 PM` — always absolute, always with seconds, never
 * relative. */
export function formatInstantFull(iso: string): string {
  const d = parseInstant(iso);
  if (d === undefined) return INVALID;
  return `${formatCalendar(d)} ${formatTimeWithSeconds(d)}`;
}

/** `Today` / `Yesterday` / `Tomorrow` / `10 Aug 2026` — never has a time;
 * `ymd` is date-only (`YYYY-MM-DD`, e.g. `dateApplied`/`nextActionDate`). */
export function formatDate(ymd: string, now: Date): string {
  const d = parseLocalDate(ymd);
  if (d === undefined) return INVALID;
  const offset = dayOffset(d, now);
  if (offset === 0) return 'Today';
  if (offset === -1) return 'Yesterday';
  if (offset === 1) return 'Tomorrow';
  return formatCalendar(d);
}

/** `just now` / `2 hours ago` / `in 3 days` — bucket edges: <60s just now;
 * <60min minutes; <24h hours; else days. Singular when the count is 1. */
export function formatRelative(iso: string, now: Date): string {
  const d = parseInstant(iso);
  if (d === undefined) return INVALID;
  const diffMs = now.getTime() - d.getTime();
  const past = diffMs >= 0;
  const absSeconds = Math.floor(Math.abs(diffMs) / 1000);
  if (absSeconds < 60) return 'just now';
  const minutes = Math.floor(absSeconds / 60);
  if (minutes < 60) {
    return past
      ? `${pluralize(minutes, 'minute')} ago`
      : `in ${pluralize(minutes, 'minute')}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return past ? `${pluralize(hours, 'hour')} ago` : `in ${pluralize(hours, 'hour')}`;
  }
  const days = Math.floor(hours / 24);
  return past ? `${pluralize(days, 'day')} ago` : `in ${pluralize(days, 'day')}`;
}

/** Hover form: `formatInstantFull(iso) + ' · ' + formatRelative(iso, now)`,
 * e.g. `10 Aug 2026 2:36:12 PM · 2 hours ago` — always reveals what the
 * inline `formatInstant` hides: the date behind `Today`, the seconds
 * behind an old absolute timestamp. Separator is space, U+00B7 MIDDLE DOT,
 * space. */
export function formatInstantTitle(iso: string, now: Date): string {
  return `${formatInstantFull(iso)} · ${formatRelative(iso, now)}`;
}
