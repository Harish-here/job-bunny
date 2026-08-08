import type { DerivedFilter } from './deriveFilter';
import type { AboutAnswers, SearchUrlEntry, WorkType } from './wizard.types';

/** `${JSON.stringify(d, null, 2)}\n` — always ends with a trailing newline,
 * matching every other config doc this profile writes. */
export function serializeFilter(d: DerivedFilter): string {
  return `${JSON.stringify(d, null, 2)}\n`;
}

const WORK_TYPE_LABEL: Record<WorkType, string> = {
  onsite: 'Onsite',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

/** snake_case document matching the shape /setup and the tracked
 * profiles/rajni/resume.json already use. Key order is fixed:
 * current_yoe, target_seniority, core_skills, secondary_skills,
 * preferred_work_type, location, domain_experience — each omitted when
 * its source is empty or null. usp and full_resume are never written;
 * those come from the /setup PDF path, out of scope here. */
export function serializeResume(about: AboutAnswers): string {
  const doc: Record<string, unknown> = {};
  if (about.yoe != null) doc.current_yoe = about.yoe;
  if (about.seniority.length > 0) doc.target_seniority = about.seniority;
  if (about.coreSkills.length > 0) doc.core_skills = about.coreSkills;
  if (about.secondarySkills.length > 0) {
    doc.secondary_skills = about.secondarySkills;
  }
  if (about.workTypes.length > 0) {
    doc.preferred_work_type = about.workTypes.map((wt) => WORK_TYPE_LABEL[wt]);
  }
  const cities = about.locations
    .map((loc) => loc.city.trim())
    .filter((city) => city !== '');
  if (cities.length > 0) doc.location = cities;
  if (about.domainExperience.length > 0) {
    doc.domain_experience = about.domainExperience;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** One `  • <label> - <url>` line per entry, in order, under the single
 * linkedin__jobs-search page header — the one page type the wizard files
 * URLs under. URLs are stored trimmed, as typed: the wizard does not strip
 * ephemeral query params (`lane add-url` does that CLI-side; duplicating
 * the rule here would drift). */
export function serializeSearchUrls(entries: SearchUrlEntry[]): string {
  const lines = [
    '# Search URLs',
    '',
    '## linkedin',
    '### linkedin__jobs-search',
    '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/' +
      'linkedin__jobs-search.json -->',
    ...entries.map((entry) => `  • ${entry.label} - ${entry.url}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Fallback used by task 3's patchProfileConfig when GET
 * config/profile.json returns empty text (a freshly created profile). */
export const SEED_PROFILE_CONFIG = {
  lanes: [] as string[],
  connector: 'sqlite' as const,
  notifiers: [] as string[],
  routines: [] as string[],
  settings: {} as Record<string, unknown>,
};
