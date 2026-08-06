/** Formats `now` as local `HH-MM` (zero-padded, dash separator) — matches
 * `schedule.times`'s local-clock convention so run artifacts line up with
 * the schedule that triggered them. */
export function formatRunTime(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}-${mm}`;
}
