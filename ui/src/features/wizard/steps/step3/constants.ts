import type { WorkType } from '../../wizard.types';

export const WORK_TYPES: WorkType[] = ['onsite', 'hybrid', 'remote'];
export const WORK_TYPE_LABEL: Record<WorkType, string> = {
  onsite: 'Onsite',
  hybrid: 'Hybrid',
  remote: 'Remote',
};
// Fallback pool when no persona is picked (the 'scratch' persona pre-fills
// nothing, and the catalog may still be loading) — a generic seniority
// ladder, not tied to any one persona.
export const DEFAULT_SENIORITY_OPTIONS = [
  'Junior',
  'Mid',
  'Senior',
  'Staff',
  'Lead',
  'Principal',
];

export type ChipListKey = 'coreSkills' | 'secondarySkills' | 'domainExperience';

/** A doc counts as "real pre-existing config" once its trimmed text is
 * neither empty nor the seeded `'{}'` placeholder — shared by the
 * never-clobber guard's filter.json AND resume.json reads so a
 * /setup-seeded resume.json with real content blocks the save exactly
 * like a hand-edited filter.json would. */
export function hasExistingContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== '' && trimmed !== '{}';
}
