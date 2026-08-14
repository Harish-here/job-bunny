/**
 * notice/failure_notice.ts — pure text-transform: `composeFailureNotice`
 * wraps `formatDigest`'s own output (`report/digest/`) with the T2/T3
 * failure-dedup copy from the mockup (`docs/product/pipeline-stability-
 * hardening/mockup.html`, `data-qa="tg-failure-reminder"` /
 * `data-qa="tg-new-signature"`; prose at `ux-notes.md` §4 T2/T3). No I/O,
 * no clock read — the caller (task 18, `cli/commands/run.ts`) supplies
 * every dynamic value.
 *
 * `report/notice/` (not `report/`) since task 1.15: `failure_notice.ts`
 * landing directly in `report/` alongside `digest.ts` and `deferred_day.ts`
 * (step 1.11) would have made a third impl file there, over the two-pair
 * cap — the blueprint's own instruction is to split into `report/digest/`
 * and `report/notice/` subfolders.
 *
 * Two judgment calls beyond the blueprint's literal 4-param signature
 * (`base, action, count, suppressedSignature?`) — both documented here
 * because task 18's own brief explicitly anticipates "reconcile against
 * task 17's actual signature if it landed differently than assumed here":
 *
 * 1. `firstSeenAt: string` was ADDED as a required 4th parameter (pushing
 *    `suppressedSignature` to 5th). The mockup's T2 line ("Same failure
 *    since {firstSeenAt}") and T3's continuation line ("(x{count}, since
 *    {firstSeenAt})") both need a timestamp that is not derivable from
 *    `base`, `action`, or `count` alone — it is `DedupState.firstSeenAt`
 *    (`ops/observability/notify/dedup.ts`), which the caller already holds
 *    via `action.nextState.firstSeenAt` at the call site the blueprint
 *    itself describes. Without this parameter the exact mockup copy is
 *    literally unproducible.
 * 2. The T3 "NOW:" line's value (the CURRENT failure's stage/error) is
 *    derived ONLY from `base`'s own `Failed at stage: X` line — i.e.
 *    `stage "X"`, no trailing `— <error text>`. `RunResult`
 *    (`ops/observability/run/result.ts`) carries no per-stage error-message
 *    field today, so no error text is available to reproduce the mockup's
 *    illustrative `— HTTP 429 from greenhouse` suffix. This is a known,
 *    documented gap, not a silent truncation — a later task could thread a
 *    richer value through if `RunResult` grows an error-message field.
 *
 * `suppressedSignature`'s contract: the caller passes ALREADY pretty-
 * printed display text for the suppressed failure (e.g.
 * `stage "farm" — stalled: no beat()`), NOT the raw `stage::normalizedError`
 * signature string `decideNotification` compares — this function prints it
 * verbatim after `STILL OPEN: `, never reformats it.
 */
import type { DedupAction } from '../../notify/dedup.ts';

const SEPARATOR = '────────────────';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD HH:MM`, 24-hour, local getters — matches the mockup's
 * literal `2026-08-11 15:49` shape exactly (distinct from every shape
 * `core/datetime` produces, none of which match this literal format). */
function formatSince(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${y}-${mo}-${day} ${h}:${mi}`;
}

/** Splices `block` immediately after `base`'s separator line — the T2
 * body's "first line after the banner+separator" placement (mockup ux-
 * notes.md §4 T2), never appended/prepended as a whole separate block. */
function spliceAfterSeparator(base: string, block: string[]): string {
  const lines = base.split('\n');
  const sepIndex = lines.indexOf(SEPARATOR);
  const insertAt = sepIndex === -1 ? lines.length : sepIndex + 1;
  lines.splice(insertAt, 0, ...block);
  return lines.join('\n');
}

/** `stage "X"` from `base`'s own `Failed at stage: X` line — see judgment
 * call 2 above for why no error text follows. */
function extractNowValue(base: string): string {
  const match = base.match(/^Failed at stage: (.+)$/m);
  return match ? `stage "${match[1]}"` : 'unknown failure';
}

/** Inserts `NEW FAILURE — ` right after the banner's leading status icon
 * (`🔴 Job Bunny — …` -> `🔴 NEW FAILURE — Job Bunny — …`), per T3's mockup
 * banner (`ux-notes.md` §4 T3). */
function prefixNewFailure(bannerLine: string): string {
  return bannerLine.replace(/^(\S+\s)/, '$1NEW FAILURE — ');
}

export function composeFailureNotice(
  base: string,
  action: DedupAction['action'],
  count: number,
  firstSeenAt: string,
  suppressedSignature?: string,
): string {
  if (action === 'suppress') {
    // Defensive-only: task 18 never calls this function when
    // `decideNotification` returns `suppress` (a suppressed failure sends
    // nothing at all). Documents the caller's contract rather than
    // throwing, since a thrown error here would be a worse failure mode
    // than a harmless pass-through for a branch that should be dead code.
    return base;
  }

  if (action === 'remind') {
    // T2 (mockup ux-notes.md §4 T2 / mockup.html `tg-failure-reminder`).
    return spliceAfterSeparator(base, [
      `STILL FAILING (x${count}) — no new problem.`,
      `Same failure since ${formatSince(firstSeenAt)}.`,
      'This is the once-a-day reminder, not a new alert.',
    ]);
  }

  // action === 'send'
  if (suppressedSignature === undefined) {
    // T1 — plain first failure of a signature: unchanged from today.
    return base;
  }

  // T3 (mockup ux-notes.md §4 T3 / mockup.html `tg-new-signature`): a
  // DIFFERENT signature broke through while an OLD one was suppressed.
  // Replaces base's body entirely (no funnel, no `Failed at stage:` line)
  // — the mockup's literal message has none of those.
  const lines = base.split('\n');
  const banner = lines[0] ?? '';
  const nowValue = extractNowValue(base);
  return [
    prefixNewFailure(banner),
    SEPARATOR,
    'This is a DIFFERENT failure from the one already reported.',
    '',
    `  NOW:        ${nowValue}`,
    `  STILL OPEN: ${suppressedSignature}`,
    `              (x${count}, since ${formatSince(firstSeenAt)})`,
  ].join('\n');
}
