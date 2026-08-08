import { describe, expect, it } from 'vitest';
import {
  applyFilterEditorState,
  parseFilterDoc,
  validateFilterEditorState,
} from './filters.model';

describe('parseFilterDoc', () => {
  it('defaults every owned field for an empty document', () => {
    const state = parseFilterDoc({});
    expect(state.title.domain).toEqual({ match: [], reject: [], severity: 'hard' });
    expect(state.title.function).toEqual({ match: [], reject: [], severity: 'hard' });
    expect(state.title.seniority).toEqual({ match: [], reject: [], severity: 'hard' });
    expect(state.locations).toEqual([]);
    expect(state.skills).toEqual({ core: [], minMatch: 1, severity: 'hard' });
  });

  it('reads a partial document that only sets title.domain, and defaults a missing severity to hard', () => {
    const state = parseFilterDoc({
      title: { domain: { match: ['frontend'], reject: [], severity: 'soft' } },
    });
    expect(state.title.domain).toEqual({
      match: ['frontend'],
      reject: [],
      severity: 'soft',
    });
    expect(state.title.function).toEqual({ match: [], reject: [], severity: 'hard' });

    const noSeverity = parseFilterDoc({
      title: { function: { match: ['engineer'], reject: [] } },
    });
    expect(noSeverity.title.function.severity).toBe('hard');
  });

  it('defaults skills.severity to hard and preserves an explicit minMatch', () => {
    const state = parseFilterDoc({ skills: { core: ['React'], minMatch: 3 } });
    expect(state.skills).toEqual({ core: ['React'], minMatch: 3, severity: 'hard' });
  });
});

describe('validateFilterEditorState', () => {
  it('rejects a location with an empty workTypes array', () => {
    const state = parseFilterDoc({});
    state.locations = [{ city: 'Chennai', country: '', workTypes: [] }];
    expect(validateFilterEditorState(state)['locations.0.workTypes']).toBe(
      'Pick at least one work type.',
    );
  });

  it('rejects a location with an empty city', () => {
    const state = parseFilterDoc({});
    state.locations = [{ city: '', country: '', workTypes: ['remote'] }];
    expect(validateFilterEditorState(state)['locations.0.city']).toBe('Enter a city.');
  });

  it('rejects a minMatch below 1, and accepts a fully valid state with no errors', () => {
    const bad = parseFilterDoc({});
    bad.skills.minMatch = 0;
    expect(validateFilterEditorState(bad)['skills.minMatch']).toBe(
      'Minimum skill matches must be a whole number of 1 or more.',
    );

    const good = parseFilterDoc({});
    good.locations = [{ city: 'Chennai', country: 'India', workTypes: ['remote'] }];
    good.skills.minMatch = 2;
    expect(validateFilterEditorState(good)).toEqual({});
  });
});

describe('applyFilterEditorState', () => {
  it('preserves companies and timezones untouched, and writes title with all three keys', () => {
    const current: Record<string, unknown> = {
      title: {},
      companies: { avoid: ['Chargebee'] },
      locations: [],
      timezones: { accept: ['APAC'], severity: 'hard' },
      skills: {},
    };
    const state = parseFilterDoc({
      title: { domain: { match: ['frontend'], reject: [], severity: 'hard' } },
    });
    state.locations = [{ city: 'Chennai', country: 'India', workTypes: ['remote'] }];

    applyFilterEditorState(current, state);

    expect(current.companies).toEqual({ avoid: ['Chargebee'] });
    expect(current.timezones).toEqual({ accept: ['APAC'], severity: 'hard' });
    expect(current.locations).toEqual([
      { city: 'Chennai', country: 'India', workTypes: ['remote'] },
    ]);
    expect(Object.keys(current.title as object).sort()).toEqual([
      'domain',
      'function',
      'seniority',
    ]);
  });
});
