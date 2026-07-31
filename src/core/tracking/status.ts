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

/** The status ArchivePolicy.passedOlderThanDays keys on. */
export const PASSED_STATUS = 'Passed' satisfies TrackingStatus;
