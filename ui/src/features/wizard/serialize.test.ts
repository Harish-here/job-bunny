import { describe, expect, it } from 'vitest';
import type { DerivedFilter } from './deriveFilter';
import { serializeFilter, serializeResume, serializeSearchUrls } from './serialize';
import type { AboutAnswers, SearchUrlEntry } from './wizard.types';

function baseAbout(overrides: Partial<AboutAnswers> = {}): AboutAnswers {
  return {
    seniority: [],
    yoe: null,
    coreSkills: [],
    secondarySkills: [],
    domainExperience: [],
    workTypes: [],
    locations: [],
    ...overrides,
  };
}

describe('serializeSearchUrls', () => {
  it('output compared against a literal multi-line string for two entries', () => {
    const entries: SearchUrlEntry[] = [
      {
        label: 'Staff Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer',
      },
      {
        label: 'Lead Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer',
      },
    ];
    expect(serializeSearchUrls(entries)).toBe(
      '# Search URLs\n' +
        '\n' +
        '## linkedin\n' +
        '### linkedin__jobs-search\n' +
        '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/' +
        'linkedin__jobs-search.json -->\n' +
        '  • Staff Frontend Engineer - ' +
        'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer\n' +
        '  • Lead Frontend Engineer - ' +
        'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer\n',
    );
  });
});

describe('serializeResume', () => {
  it('omits empty keys and compares against a literal string', () => {
    const about = baseAbout({ yoe: 9, coreSkills: ['React', 'TypeScript'] });
    expect(serializeResume(about)).toBe(
      `${JSON.stringify(
        { current_yoe: 9, core_skills: ['React', 'TypeScript'] },
        null,
        2,
      )}\n`,
    );
  });

  it('maps workTypes to display case', () => {
    const about = baseAbout({ workTypes: ['remote', 'hybrid'] });
    const result = serializeResume(about);
    expect(JSON.parse(result)).toEqual({
      preferred_work_type: ['Remote', 'Hybrid'],
    });
  });
});

describe('serializeFilter', () => {
  it('round-trips through JSON.parse and ends with a newline', () => {
    const derived: DerivedFilter = {
      title: { seniority: { match: ['staff'], reject: [], severity: 'hard' } },
    };
    const result = serializeFilter(derived);
    expect(result.endsWith('\n')).toBe(true);
    expect(JSON.parse(result)).toEqual(derived);
  });
});
