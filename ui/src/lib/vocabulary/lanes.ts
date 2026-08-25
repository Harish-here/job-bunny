import { Building2 } from 'lucide-react';

/**
 * Display labels for the source lane a job was found through (R10 —
 * surface the lane, never a raw internal string). Falls back to the raw
 * lane string for anything unknown so the UI never throws on an
 * unrecognized lane.
 */
export const LANE_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  greenhouse: 'Greenhouse',
  keka: 'Keka',
};

export function laneLabel(lane: string): string {
  return LANE_LABELS[lane] ?? lane;
}

/**
 * Icon for a source lane. `lucide-react@1.28.0` (the pinned dependency,
 * verified at authoring time via `grep -rli "linkedin"
 * node_modules/lucide-react/`) ships no LinkedIn brand icon at all — lucide
 * dropped brand/logo icons in a past major version. Per this task's
 * resolved contradiction (no new dependency may be added), every lane,
 * including `'linkedin'`, shares one decorative icon (`Building2`); the
 * lane *label* (`laneLabel`) remains the primary, always-correct carrier of
 * which lane a job came from.
 */
export function laneIcon(_lane: string) {
  return Building2;
}
