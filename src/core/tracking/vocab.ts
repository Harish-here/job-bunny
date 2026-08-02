/**
 * Tracking-status vocabulary (local-DB spec §5 "vocabulary relocation",
 * first slice): the single authority for the human tracking status
 * strings. The Notion adapter re-sources its byte-exact select options
 * from here; the sqlite connector's archive policy keys on PASSED_STATUS.
 * Strings are byte-exact against the live Notion DB's select options —
 * never edit one without updating the live DB first (CLAUDE.md hard rule).
 */
export const STATUS_OPTIONS = [
  'Lead',
  'Applied',
  'Recruiter Screen',
  'Tech Round',
  'Onsite',
  'Offer',
  'Rejected',
  'Passed',
] as const;

export type TrackingStatus = (typeof STATUS_OPTIONS)[number];

/**
 * The status ArchivePolicy.passedOlderThanDays keys on.
 * Mirrored by ui/src/features/tracker/grouping.ts TERMINAL_STATUSES — update both together.
 */
export const PASSED_STATUS = 'Passed' satisfies TrackingStatus;

/** Excitement vocabulary — single authority (local-DB spec §5). Producers
 * (core/rank) and projections (notion select, board meta) all import from
 * here; the strings are byte-exact Notion select options. */
export const EXCITEMENT_OPTIONS = ['Vera level', 'Kandipa podu', 'Try panalam'] as const;
export type ExcitementLevel = (typeof EXCITEMENT_OPTIONS)[number];
