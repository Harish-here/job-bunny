import { describe, expect, it } from 'vitest';
import {
  applyWhereYouWorkFilterState,
  applyWhereYouWorkProfileState,
  computeTimezoneConflict,
  parseWhereYouWorkDoc,
  validateWhereYouWorkEditorState,
  type WhereYouWorkEditorState,
} from './whereYouWork.model';

describe('computeTimezoneConflict', () => {
  it('returns [] when filterTimezones is undefined, regardless of what the rank lists contain', () => {
    const result = computeTimezoneConflict(undefined, {
      acceptableTimezones: ['IST', 'PST'],
      borderlineTimezones: ['GMT'],
    });
    expect(result).toEqual([]);
  });

  it('emits one hard-severity entry for a rank timezone absent from a hard accept list', () => {
    const result = computeTimezoneConflict(
      { accept: ['IST'], severity: 'hard' },
      { acceptableTimezones: ['PST'], borderlineTimezones: [] },
    );
    expect(result).toEqual([{ tz: 'PST', severity: 'hard' }]);
  });

  it('emits one soft-severity entry for the same absent timezone under a soft accept list', () => {
    const result = computeTimezoneConflict(
      { accept: ['IST'], severity: 'soft' },
      { acceptableTimezones: ['PST'], borderlineTimezones: [] },
    );
    expect(result).toEqual([{ tz: 'PST', severity: 'soft' }]);
  });

  it('returns [] when every rank timezone is present in accept', () => {
    const result = computeTimezoneConflict(
      { accept: ['IST', 'PST'], severity: 'hard' },
      { acceptableTimezones: ['IST'], borderlineTimezones: ['PST'] },
    );
    expect(result).toEqual([]);
  });

  it('normalizes both sides before comparing, so casing/punctuation differences do not false-conflict', () => {
    const result = computeTimezoneConflict(
      { accept: ['Indian Standard Time'], severity: 'hard' },
      { acceptableTimezones: ['indian-standard-time'], borderlineTimezones: [] },
    );
    expect(result).toEqual([]);
  });

  it('unions acceptableTimezones and borderlineTimezones, de-duping an entry present in both', () => {
    const result = computeTimezoneConflict(
      { accept: ['IST'], severity: 'hard' },
      { acceptableTimezones: ['PST'], borderlineTimezones: ['PST'] },
    );
    expect(result).toEqual([{ tz: 'PST', severity: 'hard' }]);
  });

  it('emits one entry per conflicting timezone across both rank lists', () => {
    const result = computeTimezoneConflict(
      { accept: ['IST'], severity: 'hard' },
      { acceptableTimezones: ['PST'], borderlineTimezones: ['GMT'] },
    );
    expect(result).toEqual(
      expect.arrayContaining([
        { tz: 'PST', severity: 'hard' },
        { tz: 'GMT', severity: 'hard' },
      ]),
    );
    expect(result).toHaveLength(2);
  });
});

describe('parseWhereYouWorkDoc', () => {
  it('reads locations + timezones.accept/severity from filter.json and settings.rank.location/workTypePreference from profile.json', () => {
    const state = parseWhereYouWorkDoc(
      {
        locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
        timezones: { accept: ['APAC'], severity: 'hard' },
      },
      {
        settings: {
          rank: {
            location: {
              homeCities: ['Chennai'],
              acceptableTimezones: ['APAC'],
              borderlineTimezones: ['EMEA'],
            },
            workTypePreference: { onsite: 1, hybrid: 1, remote: 2 },
          },
        },
      },
    );
    expect(state.locations).toEqual([
      { city: 'Chennai', country: 'India', workTypes: ['onsite'] },
    ]);
    expect(state.timezonesRule).toEqual({ accept: ['APAC'], severity: 'hard' });
    expect(state.homeCities).toEqual(['Chennai']);
    expect(state.acceptableTimezones).toEqual(['APAC']);
    expect(state.borderlineTimezones).toEqual(['EMEA']);
    expect(state.workTypePreference).toBe('remote-first');
  });

  it('leaves timezonesRule undefined when filter.json has never configured one, and reads no-preference for a flat workTypePreference', () => {
    const state = parseWhereYouWorkDoc({ locations: [] }, {});
    expect(state.timezonesRule).toBeUndefined();
    expect(state.workTypePreference).toBe('no-preference');
    expect(state.homeCities).toEqual([]);
  });
});

describe('validateWhereYouWorkEditorState', () => {
  const base: WhereYouWorkEditorState = {
    locations: [],
    timezonesRule: undefined,
    homeCities: [],
    acceptableTimezones: [],
    borderlineTimezones: [],
    workTypePreference: 'no-preference',
  };

  it('returns no errors for an empty locations list', () => {
    expect(validateWhereYouWorkEditorState(base)).toEqual({});
  });

  it('flags a location missing a city or a work type', () => {
    const errors = validateWhereYouWorkEditorState({
      ...base,
      locations: [{ city: '', country: '', workTypes: [] }],
    });
    expect(errors['where-you-work-locations.0.city']).toBe('Enter a city.');
    expect(errors['where-you-work-locations.0.workTypes']).toBe(
      'Pick at least one work type.',
    );
  });
});

describe('applyWhereYouWorkFilterState', () => {
  it('writes locations and timezones, preserving title/companies/skills untouched', () => {
    const current: Record<string, unknown> = {
      title: { domain: { match: ['x'], reject: [], severity: 'hard' } },
      companies: { avoid: ['Chargebee'] },
      skills: { core: ['React'], minMatch: 1, severity: 'hard' },
    };
    applyWhereYouWorkFilterState(current, {
      locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
      timezonesRule: { accept: ['APAC'], severity: 'soft' },
      homeCities: [],
      acceptableTimezones: [],
      borderlineTimezones: [],
      workTypePreference: 'no-preference',
    });
    expect(current.locations).toEqual([
      { city: 'Chennai', country: 'India', workTypes: ['onsite'] },
    ]);
    expect(current.timezones).toEqual({ accept: ['APAC'], severity: 'soft' });
    expect(current.title).toEqual({
      domain: { match: ['x'], reject: [], severity: 'hard' },
    });
    expect(current.companies).toEqual({ avoid: ['Chargebee'] });
    expect(current.skills).toEqual({ core: ['React'], minMatch: 1, severity: 'hard' });
  });

  it('deletes timezones when timezonesRule is undefined (never configured)', () => {
    const current: Record<string, unknown> = {
      timezones: { accept: ['APAC'], severity: 'hard' },
    };
    applyWhereYouWorkFilterState(current, {
      locations: [],
      timezonesRule: undefined,
      homeCities: [],
      acceptableTimezones: [],
      borderlineTimezones: [],
      workTypePreference: 'no-preference',
    });
    expect(current.timezones).toBeUndefined();
  });
});

describe('applyWhereYouWorkProfileState', () => {
  it('writes settings.rank.location + workTypePreference, preserving sibling rank fields untouched', () => {
    const current: Record<string, unknown> = {
      notion_db_id: '',
      settings: {
        rank: {
          skills: { primary: ['React'] },
          location: { bonus: 20, partial: 10, homeCities: ['Old'] },
        },
      },
    };
    applyWhereYouWorkProfileState(current, {
      locations: [],
      timezonesRule: undefined,
      homeCities: ['Chennai'],
      acceptableTimezones: ['APAC'],
      borderlineTimezones: ['EMEA'],
      workTypePreference: 'remote-first',
    });
    const settings = current.settings as Record<string, unknown>;
    const rank = settings.rank as Record<string, unknown>;
    expect(rank.location).toEqual({
      bonus: 20,
      partial: 10,
      homeCities: ['Chennai'],
      acceptableTimezones: ['APAC'],
      borderlineTimezones: ['EMEA'],
    });
    expect(rank.workTypePreference).toEqual({ onsite: 1, hybrid: 1, remote: 2 });
    expect(rank.skills).toEqual({ primary: ['React'] });
    expect(current.notion_db_id).toBe('');
  });
});
