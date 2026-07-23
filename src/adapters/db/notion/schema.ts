/**
 * Notion DB schema pin (P7 Task 3). Property names and select-option strings
 * are byte-exact copies of v0's single source of truth
 * (scripts/notion/schema.js) — Notion select options are matched by exact
 * string against the live database, so one dropped/renamed character here
 * makes sync throw against a real DB. schema.test.ts reads v0's values at
 * test time and asserts byte-equality against the exports below, so drift
 * between the two trees (which coexist until cutover) is structurally
 * impossible rather than merely documented.
 *
 * Deliberately excludes v0's DB_TITLE/PARENT_PAGE_TITLE (DB-provisioning
 * concerns, not read/write schema) and the `select()` builder / nested
 * `DB_PROPERTIES` shape used for `ensureSchema`'s live-DB migration — this
 * task only needs a flat property-name/type pin for the client surface Task
 * 4 builds on; a future task can port ensureSchema if the v2 sync stage
 * needs it.
 */

/** The Notion property types actually used by DB_PROPERTIES in v0. */
export type NotionPropertyType =
  | 'title'
  | 'rich_text'
  | 'select'
  | 'number'
  | 'checkbox'
  | 'url'
  | 'date';

export interface PropertyDescriptor {
  /** Byte-exact Notion property name (the column header in the live DB). */
  readonly name: string;
  readonly type: NotionPropertyType;
}

// ---- Automated fields (populated by Job Bunny; v0 schema.js lines 32-46) ----
// ---- Manual fields (post-application tracking, never overwritten; lines 48-54) ----
export const PROPERTIES = {
  jobTitle: { name: 'Job Title', type: 'title' },
  company: { name: 'Company', type: 'rich_text' },
  seniorityLevel: { name: 'Seniority Level', type: 'select' },
  locationCity: { name: 'Location City', type: 'rich_text' },
  workType: { name: 'Work Type', type: 'select' },
  yoe: { name: 'YoE', type: 'number' },
  yoeIsMinimum: { name: 'YoE Is Minimum', type: 'checkbox' },
  keySkills: { name: 'Key Skills', type: 'rich_text' },
  jobUrl: { name: 'Job URL', type: 'url' },
  dateFound: { name: 'Date Found', type: 'date' },
  timezone: { name: 'Timezone', type: 'select' },
  sourceUrl: { name: 'Source URL', type: 'url' },
  excitement: { name: 'Excitement', type: 'select' },
  matchReasons: { name: 'Match Reasons', type: 'rich_text' },
  reviewFlags: { name: 'Review Flags', type: 'rich_text' },
  status: { name: 'Status', type: 'select' },
  compRange: { name: 'Comp Range', type: 'rich_text' },
  notes: { name: 'Notes', type: 'rich_text' },
  contact: { name: 'Contact', type: 'rich_text' },
  dateApplied: { name: 'Date Applied', type: 'date' },
  nextAction: { name: 'Next Action', type: 'rich_text' },
  nextActionDate: { name: 'Next Action Date', type: 'date' },
} as const satisfies Record<string, PropertyDescriptor>;

/** Fields Job Bunny writes on sync — manual fields deliberately excluded
 * (v0 schema.js AUTOMATED_FIELDS, lines 58-74). */
export const AUTOMATED_FIELDS = [
  PROPERTIES.jobTitle.name,
  PROPERTIES.company.name,
  PROPERTIES.seniorityLevel.name,
  PROPERTIES.locationCity.name,
  PROPERTIES.workType.name,
  PROPERTIES.yoe.name,
  PROPERTIES.yoeIsMinimum.name,
  PROPERTIES.keySkills.name,
  PROPERTIES.jobUrl.name,
  PROPERTIES.dateFound.name,
  PROPERTIES.timezone.name,
  PROPERTIES.sourceUrl.name,
  PROPERTIES.excitement.name,
  PROPERTIES.matchReasons.name,
  PROPERTIES.reviewFlags.name,
] as const;

// ---- Select/multi-select option groups (v0 schema.js lines 8-25) ----
export const SENIORITY_OPTIONS = ['Staff', 'Lead', 'Mid', 'Manager', 'Senior'] as const;
export const WORK_TYPE_OPTIONS = ['Remote', 'Hybrid', 'On-site'] as const;
export const TIMEZONE_OPTIONS = ['APAC', 'EMEA'] as const;
export const EXCITEMENT_OPTIONS = ['Vera level', 'Kandipa podu', 'Try panalam'] as const;
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

/** Keyed by the PROPERTIES logical name each group belongs to. */
export const OPTIONS = {
  seniorityLevel: SENIORITY_OPTIONS,
  workType: WORK_TYPE_OPTIONS,
  timezone: TIMEZONE_OPTIONS,
  excitement: EXCITEMENT_OPTIONS,
  status: STATUS_OPTIONS,
} as const satisfies Record<string, readonly string[]>;
