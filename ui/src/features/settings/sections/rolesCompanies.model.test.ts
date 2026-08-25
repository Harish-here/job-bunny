import { describe, expect, it } from 'vitest';
import {
  applyRolesCompaniesEditorState,
  parseRolesCompaniesDoc,
} from './rolesCompanies.model';

describe('parseRolesCompaniesDoc', () => {
  it('defaults every owned field for an empty (filter.json, profile.json) pair', () => {
    const state = parseRolesCompaniesDoc({}, {});
    expect(state.title.domain).toEqual({ match: [], reject: [], severity: 'hard' });
    expect(state.title.function).toEqual({ match: [], reject: [], severity: 'hard' });
    expect(state.title.seniority).toEqual({ match: [], reject: [], severity: 'hard' });
    expect(state.companiesAvoid).toEqual([]);
    expect(state.domainKeywords).toEqual([]);
    expect(state.seniorityTargets).toEqual([]);
  });

  it('reads filter.json.title and filter.json.companies.avoid', () => {
    const state = parseRolesCompaniesDoc(
      {
        title: { domain: { match: ['engineer'], reject: ['intern'], severity: 'hard' } },
        companies: { avoid: ['Acme Staffing'] },
      },
      {},
    );
    expect(state.title.domain).toEqual({
      match: ['engineer'],
      reject: ['intern'],
      severity: 'hard',
    });
    expect(state.companiesAvoid).toEqual(['Acme Staffing']);
  });

  it('reads profile.json.settings.rank.title.domainKeywords and .seniority.targets', () => {
    const state = parseRolesCompaniesDoc(
      {},
      {
        settings: {
          rank: {
            title: { domainKeywords: ['fintech'], maxPoints: 15, neutralPoints: 8 },
            seniority: { targets: ['Senior'], maxPoints: 15 },
          },
        },
      },
    );
    expect(state.domainKeywords).toEqual(['fintech']);
    expect(state.seniorityTargets).toEqual(['Senior']);
  });
});

describe('applyRolesCompaniesEditorState — filter target', () => {
  it('writes title with all three keys and companies.avoid, preserving locations/timezones/skills untouched', () => {
    const current: Record<string, unknown> = {
      title: {},
      companies: { avoid: ['stale'] },
      locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
      timezones: { accept: ['APAC'], severity: 'hard' },
      skills: { core: ['React'], minMatch: 1, severity: 'hard' },
    };
    const state = parseRolesCompaniesDoc(
      { title: { domain: { match: ['engineer'], reject: [], severity: 'hard' } } },
      {},
    );
    state.companiesAvoid = ['Acme Staffing'];

    applyRolesCompaniesEditorState('filter', current, state);

    expect(Object.keys(current.title as object).sort()).toEqual([
      'domain',
      'function',
      'seniority',
    ]);
    expect((current.title as Record<string, unknown>).domain).toEqual({
      match: ['engineer'],
      reject: [],
      severity: 'hard',
    });
    expect(current.companies).toEqual({ avoid: ['Acme Staffing'] });
    expect(current.locations).toEqual([
      { city: 'Chennai', country: 'India', workTypes: ['onsite'] },
    ]);
    expect(current.timezones).toEqual({ accept: ['APAC'], severity: 'hard' });
    expect(current.skills).toEqual({ core: ['React'], minMatch: 1, severity: 'hard' });
  });
});

describe('applyRolesCompaniesEditorState — profile target', () => {
  it('writes domainKeywords and seniority.targets, preserving maxPoints/neutralPoints and every sibling rank field untouched', () => {
    const current: Record<string, unknown> = {
      settings: {
        rank: {
          title: { domainKeywords: ['stale'], maxPoints: 15, neutralPoints: 8 },
          seniority: { targets: ['stale'], maxPoints: 15 },
          skills: { primary: ['React'] },
          location: { homeCities: ['Chennai'] },
        },
      },
    };
    const state = parseRolesCompaniesDoc({}, {});
    state.domainKeywords = ['fintech'];
    state.seniorityTargets = ['Senior', 'Staff'];

    applyRolesCompaniesEditorState('profile', current, state);

    const settings = current.settings as Record<string, unknown>;
    const rank = settings.rank as Record<string, unknown>;
    expect(rank.title).toEqual({
      domainKeywords: ['fintech'],
      maxPoints: 15,
      neutralPoints: 8,
    });
    expect(rank.seniority).toEqual({ targets: ['Senior', 'Staff'], maxPoints: 15 });
    expect(rank.skills).toEqual({ primary: ['React'] });
    expect(rank.location).toEqual({ homeCities: ['Chennai'] });
  });

  it('round-trips through parse -> apply -> parse for all three new fields', () => {
    const filterRaw: Record<string, unknown> = {};
    const profileRaw: Record<string, unknown> = {};
    const state = parseRolesCompaniesDoc(filterRaw, profileRaw);
    state.companiesAvoid = ['Acme Staffing'];
    state.domainKeywords = ['fintech'];
    state.seniorityTargets = ['Senior'];

    applyRolesCompaniesEditorState('filter', filterRaw, state);
    applyRolesCompaniesEditorState('profile', profileRaw, state);

    const roundTripped = parseRolesCompaniesDoc(filterRaw, profileRaw);
    expect(roundTripped.companiesAvoid).toEqual(['Acme Staffing']);
    expect(roundTripped.domainKeywords).toEqual(['fintech']);
    expect(roundTripped.seniorityTargets).toEqual(['Senior']);
  });
});
