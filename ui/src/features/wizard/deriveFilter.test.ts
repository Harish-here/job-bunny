import { describe, expect, it } from 'vitest';
import { deriveFilter } from './deriveFilter';
import type { AboutAnswers, Persona } from './wizard.types';

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

const FRONTEND_PERSONA: Persona = {
  id: 'frontend',
  label: 'Frontend',
  blurb: 'Frontend engineering roles.',
  coreSkills: ['React', 'TypeScript'],
  secondarySkills: ['Vue.js'],
  seniorityOptions: ['Staff', 'Lead', 'Principal'],
  title: {
    domain: { match: ['Frontend', 'UI', 'React'], reject: [] },
    function: { match: ['Engineer', 'Developer'], reject: ['Manager', 'Director'] },
  },
};

describe('deriveFilter', () => {
  it(
    'a persona with domain+function rules and picked seniority produces the ' +
      'full title block',
    () => {
      const result = deriveFilter({
        persona: FRONTEND_PERSONA,
        about: baseAbout({ seniority: ['Staff', 'Lead'] }),
      });
      expect(result.title).toEqual({
        domain: { match: ['frontend', 'ui', 'react'], reject: [], severity: 'hard' },
        function: {
          match: ['engineer', 'developer'],
          reject: ['manager', 'director'],
          severity: 'hard',
        },
        seniority: { match: ['staff', 'lead'], reject: [], severity: 'hard' },
      });
    },
  );

  it('a scratch/null persona with only seniority produces title.seniority only', () => {
    const result = deriveFilter({
      persona: null,
      about: baseAbout({ seniority: ['Staff'] }),
    });
    expect(result.title).toEqual({
      seniority: { match: ['staff'], reject: [], severity: 'hard' },
    });
  });

  it('no persona and no seniority produces no title key at all', () => {
    const result = deriveFilter({ persona: null, about: baseAbout() });
    expect(result).not.toHaveProperty('title');
  });

  it('empty workTypes omits locations even when cities exist', () => {
    const result = deriveFilter({
      persona: null,
      about: baseAbout({
        workTypes: [],
        locations: [{ city: 'Chennai', country: 'India' }],
      }),
    });
    expect(result).not.toHaveProperty('locations');
  });

  it('a blank city is skipped', () => {
    const result = deriveFilter({
      persona: null,
      about: baseAbout({
        workTypes: ['remote'],
        locations: [
          { city: '', country: '' },
          { city: 'Chennai', country: 'India' },
        ],
      }),
    });
    expect(result.locations).toEqual([
      { city: 'Chennai', country: 'India', workTypes: ['remote'] },
    ]);
  });

  it('country blank is omitted from the entry', () => {
    const result = deriveFilter({
      persona: null,
      about: baseAbout({
        workTypes: ['remote'],
        locations: [{ city: 'Chennai', country: '' }],
      }),
    });
    expect(result.locations).toEqual([{ city: 'Chennai', workTypes: ['remote'] }]);
    expect(Object.keys(result.locations?.[0] ?? {})).toEqual(['city', 'workTypes']);
  });

  it('seniority is lowercased and de-duplicated preserving first-seen order', () => {
    const result = deriveFilter({
      persona: null,
      about: baseAbout({ seniority: ['Staff', 'staff', 'Lead'] }),
    });
    expect(result.title?.seniority?.match).toEqual(['staff', 'lead']);
  });

  it("the output's JSON.stringify equals a literal expected string", () => {
    const result = deriveFilter({
      persona: FRONTEND_PERSONA,
      about: baseAbout({
        seniority: ['Staff'],
        workTypes: ['remote', 'hybrid'],
        locations: [{ city: 'Chennai', country: 'India' }],
      }),
    });
    expect(JSON.stringify(result)).toBe(
      '{"title":{"domain":{"match":["frontend","ui","react"],"reject":[],' +
        '"severity":"hard"},"function":{"match":["engineer","developer"],' +
        '"reject":["manager","director"],"severity":"hard"},"seniority":' +
        '{"match":["staff"],"reject":[],"severity":"hard"}},"locations":' +
        '[{"city":"Chennai","country":"India","workTypes":["remote","hybrid"]}]}',
    );
  });
});
