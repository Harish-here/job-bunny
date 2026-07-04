// Single source of truth for the Notion DB schema and its select-option literals.
// Built from the design_v0 "Notion DB Schema" (authoritative — NOT the extraction schema).
// Strings here are byte-exact (Gate 3); sync throws if they drift from existing Notion options.

export const DB_TITLE = "Job Bunny — Jobs";
export const PARENT_PAGE_TITLE = "Job Bunny's List";

export const SENIORITY_OPTIONS = ["Staff", "Lead", "Mid", "Manager", "Senior"];
export const WORK_TYPE_OPTIONS = ["Remote", "Hybrid", "On-site"];
export const TIMEZONE_OPTIONS = ["APAC", "EMEA"];
export const EXCITEMENT_OPTIONS = [
  "Vera level",
  "Kandipa podu",
  "Try panalam",
  "Okay tha",
  "Deal la vidu",
];
export const STATUS_OPTIONS = [
  "Lead",
  "Applied",
  "Recruiter Screen",
  "Tech Round",
  "Onsite",
  "Offer",
  "Rejected",
  "Passed",
];

const select = (options) => ({ select: { options: options.map((name) => ({ name })) } });

// Notion property definitions. "Job Title" is the title property (exactly one allowed).
export const DB_PROPERTIES = {
  // --- Automated fields (populated by Job Bunny) ---
  "Job Title": { title: {} },
  Company: { rich_text: {} },
  "Seniority Level": select(SENIORITY_OPTIONS),
  "Location City": { rich_text: {} },
  "Work Type": select(WORK_TYPE_OPTIONS),
  YoE: { number: {} },
  "YoE Is Minimum": { checkbox: {} },
  "Key Skills": { rich_text: {} },
  "Job URL": { url: {} },
  "Date Found": { date: {} },
  Timezone: select(TIMEZONE_OPTIONS),
  "Source URL": { url: {} },
  Excitement: select(EXCITEMENT_OPTIONS),
  "Match Reasons": { rich_text: {} },
  // --- Manual fields (post-application tracking; Job Bunny never overwrites these) ---
  Status: select(STATUS_OPTIONS),
  "Comp Range": { rich_text: {} },
  Notes: { rich_text: {} },
  Contact: { rich_text: {} },
  "Date Applied": { date: {} },
  "Next Action": { rich_text: {} },
  "Next Action Date": { date: {} },
};

// Fields Job Bunny writes on sync — manual fields are deliberately excluded.
export const AUTOMATED_FIELDS = [
  "Job Title",
  "Company",
  "Seniority Level",
  "Location City",
  "Work Type",
  "YoE",
  "YoE Is Minimum",
  "Key Skills",
  "Job URL",
  "Date Found",
  "Timezone",
  "Source URL",
  "Excitement",
  "Match Reasons",
];
