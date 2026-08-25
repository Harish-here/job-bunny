/**
 * Operate's shared severity ranking (ux-notes.md §10 / mockup S7's own
 * footer note): "daemon down > session signed out > breaker open > check
 * failing." Urgency is weight, not hue — on a page where several cards are
 * in trouble at once, ONLY the single worst-ranked one carries the accent
 * border/tint; every other troubled card renders as a plain row with its
 * own status word. Frozen order — do not reorder without a design sign-off.
 *
 * Defined here (task 33, the Daemon card — `daemon-down`'s first and
 * highest-priority consumer) even though only one card exists to compare
 * against today. Task 37 is the first to actually call `worstSeverity`
 * with more than one card's severity at once, once the LinkedIn/session
 * and Setup & health cards exist to contribute `session-signed-out` /
 * `breaker-open` / `check-failing`.
 */
export type OperateSeverity =
  | 'daemon-down'
  | 'session-signed-out'
  | 'breaker-open'
  | 'check-failing';

export const SEVERITY_ORDER: readonly OperateSeverity[] = [
  'daemon-down',
  'session-signed-out',
  'breaker-open',
  'check-failing',
];

/** Given the severities the currently-visible cards report (a healthy card
 * contributes nothing), returns the single most severe one — the only
 * card that should carry the accent border/tint. `null` when every card
 * is healthy, or when `present` is empty. */
export function worstSeverity(
  present: readonly OperateSeverity[],
): OperateSeverity | null {
  for (const level of SEVERITY_ORDER) {
    if (present.includes(level)) return level;
  }
  return null;
}
