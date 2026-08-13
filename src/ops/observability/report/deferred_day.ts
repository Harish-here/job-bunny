/**
 * ops/observability/report/deferred_day.ts — pure text-transform: T4
 * (`tg-deferred-day` / `tg-deferred-day-no-catchup`), the deferred-day
 * Telegram summary. Sibling to `digest.ts` in the same two-pair-compliant
 * folder — not `formatDigest` itself, since T4 is not a `RunResult`-shaped
 * digest (`ops/daemon/daemon.ts`'s `runOwedBatch`, step 1.11). This same
 * function is reused by the retrospective (previous-day) sweep — a LATER
 * task (blueprint step 1.11a) — via `catchupFired: false` and a
 * `nextRunAt`; this task only wires the live (same-day) call site.
 *
 * Pure — no clock read, no I/O. `TelegramNotifier.send()` posts with no
 * `parse_mode` (ux-notes.md §0: no bold/italic/markdown available), so
 * wording IS the entire design — both variants are pinned
 * character-for-character in the colocated test against the mockup's
 * literal copy (`docs/product/pipeline-stability-hardening/mockup.html`,
 * `data-qa="tg-deferred-day"` / `data-qa="tg-deferred-day-no-catchup"`).
 */
import {
  formatLocalDate,
  hhMmToMinutes,
  localHhMm,
} from '../../../core/schedule/index.ts';

const SEPARATOR = '────────────────';

export type DeferredReasonCode =
  | 'host-asleep'
  | 'network-unreachable'
  | 'daemon-unavailable';

export interface DeferredDaySlotSummary {
  slot: string; // 'HH:MM' local
  reasonCode: DeferredReasonCode;
}

export interface DeferredDaySummaryInput {
  profile: string;
  date: string; // 'YYYY-MM-DD' local — the day being summarized.
  slots: readonly DeferredDaySlotSummary[];
  catchupFired: boolean;
  /** ISO 8601 instant of the next scheduled slot — consulted only when
   * `catchupFired` is false. `null` when there is no known next slot (e.g.
   * the profile's schedule has since been disabled). */
  nextRunAt: string | null;
}

const REASON_LABEL: Record<DeferredReasonCode, string> = {
  'host-asleep': 'host asleep',
  'network-unreachable': 'network unreachable',
  'daemon-unavailable': 'daemon unavailable',
};

/** The header sentence's own hard-coded, manually word-wrapped lines — one
 * per reasonCode, same precedent as `alert/schema_drift.ts`'s
 * `composeSchemaDriftAlertText` (no `parse_mode`, so the wrap itself is
 * part of the pinned copy, not a generic reflow). The `host-asleep` wrap
 * position matches the mockup's own literal line break exactly; the other
 * two reasonCodes have no mockup-designed copy (the mockup only shows the
 * host-asleep, 5-slot scenario) — this file's own task report records
 * that as a judgment call. */
function reasonClauseLines(reasonCode: DeferredReasonCode, count: number): string[] {
  const runWord = count === 1 ? 'run' : 'runs';
  switch (reasonCode) {
    case 'host-asleep':
      return [
        `Job Bunny declined to start ${count} ${runWord} because the host`,
        'was asleep and could not reach the network.',
      ];
    case 'network-unreachable':
      return [
        `Job Bunny declined to start ${count} ${runWord} because the`,
        'network was unreachable.',
      ];
    case 'daemon-unavailable':
      return [
        `Job Bunny declined to start ${count} ${runWord} because the`,
        "scheduler was not running during today's scheduled window.",
      ];
  }
}

/** Most-common `reasonCode` among `slots`, ties broken by earliest
 * occurrence — the header sentence names ONE reason. `undefined` for an
 * empty list (never reached in practice: the caller only invokes this
 * with at least one deferred slot for the day). */
function dominantReasonCode(
  slots: readonly DeferredDaySlotSummary[],
): DeferredReasonCode | undefined {
  const counts = new Map<DeferredReasonCode, number>();
  for (const s of slots) counts.set(s.reasonCode, (counts.get(s.reasonCode) ?? 0) + 1);
  let best: DeferredReasonCode | undefined;
  let bestCount = 0;
  for (const s of slots) {
    const c = counts.get(s.reasonCode) ?? 0;
    if (c > bestCount) {
      best = s.reasonCode;
      bestCount = c;
    }
  }
  return best;
}

/** "tomorrow 09:00." / "today 09:00." / "on 2026-08-15 09:00." — the
 * no-catchup variant's last line. Falls back to "not currently
 * scheduled." for a null/unparseable `nextRunAt` — degrade, never throw,
 * matching every other daemon-side text composer's posture. */
function formatNextRunAt(nextRunAt: string | null, today: string): string {
  if (!nextRunAt) return 'not currently scheduled.';
  const parsed = new Date(nextRunAt);
  if (Number.isNaN(parsed.getTime())) return 'not currently scheduled.';
  const hhMm = localHhMm(parsed);
  const runDateStr = formatLocalDate(parsed);
  if (runDateStr === today) return `today ${hhMm}.`;

  const [ty, tm, td] = today.split('-').map(Number);
  const todayMidnight = new Date(ty ?? 0, (tm ?? 1) - 1, td ?? 1).getTime();
  const runMidnight = new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
  ).getTime();
  const diffDays = Math.round((runMidnight - todayMidnight) / 86_400_000);
  const dayLabel = diffDays === 1 ? 'tomorrow' : `on ${runDateStr}`;
  return `${dayLabel} ${hhMm}.`;
}

export function composeDeferredDaySummary(input: DeferredDaySummaryInput): string {
  const banner = `⏸️ Job Bunny — ${input.profile} (${input.date})`;
  const sortedSlots = [...input.slots].sort(
    (a, b) => hhMmToMinutes(a.slot) - hhMmToMinutes(b.slot),
  );
  const reasonCode = dominantReasonCode(sortedSlots) ?? 'daemon-unavailable';
  const uniform = sortedSlots.every((s) => s.reasonCode === reasonCode);

  const headerLines = uniform
    ? reasonClauseLines(reasonCode, sortedSlots.length)
    : [
        `Job Bunny declined to start ${sortedSlots.length} runs across`,
        'multiple reasons — see the list below.',
      ];

  const bulletLines = sortedSlots.map(
    (s) => `  • ${s.slot} — deferred (${REASON_LABEL[s.reasonCode]})`,
  );

  const lastLine = input.catchupFired
    ? 'Catch-up run starting now — digest to follow.'
    : `Next scheduled slot: ${formatNextRunAt(input.nextRunAt, input.date)}`;

  return [
    banner,
    SEPARATOR,
    "Today's runs were deferred. Nothing failed.",
    '',
    ...headerLines,
    '',
    ...bulletLines,
    '',
    'No job data was scraped today.',
    lastLine,
  ].join('\n');
}
