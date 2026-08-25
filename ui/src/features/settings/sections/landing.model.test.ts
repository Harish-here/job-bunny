import { describe, expect, it } from 'vitest';
import type { FunnelStage } from '../../runs/runResult';
import { capsInForce, rulesInForce, thinRunSummary } from './landing.model';

function stage(
  name: string,
  jobsIn: number,
  jobsOut: number,
  dropsByRule: Record<string, number> = {},
): FunnelStage {
  return { name, jobsIn, jobsOut, dropsByRule, elapsedMs: 0, attempts: 1 };
}

describe('thinRunSummary', () => {
  it('names the biggest single drop across stages, proving delegation to getBiggestDrop', () => {
    const result = {
      stages: [
        stage('source', 200, 190, { badUrl: 3 }),
        stage('filter', 190, 20, { locations: 150, companies: 20 }),
        stage('rank', 20, 4, {}),
      ],
    };
    const summary = thinRunSummary(result);
    expect(summary.biggestDrop).toEqual({
      stage: 'filter',
      rule: 'locations',
      count: 150,
    });
    expect(summary.scraped).toBe(200);
    expect(summary.onBoard).toBe(4);
  });

  it('degrades to scraped: null, onBoard: 0, biggestDrop: null for an absent result', () => {
    expect(thinRunSummary(undefined)).toEqual({
      scraped: null,
      onBoard: 0,
      biggestDrop: null,
    });
  });
});

describe('capsInForce', () => {
  const settings = {
    maxNewPerLane: 40,
    maxProbesPerRun: 25,
    maxCardsPerUrl: 40,
    maxAgeDays: 30,
  };

  it('renders the binding hit signal on exactly the maxNewPerLane row, and null for maxProbesPerRun', () => {
    const rows = capsInForce(settings, { maxNewPerLane: true, maxCardsPerUrl: false });
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get('maxNewPerLane')?.hit).toBe(true);
    expect(byName.get('maxProbesPerRun')?.hit).toBeNull();
  });

  it('maxAgeDays is always hit: null, regardless of capsHit content', () => {
    const withTrue = capsInForce(settings, {
      maxNewPerLane: true,
      maxCardsPerUrl: true,
    });
    const withUndefined = capsInForce(settings, undefined);
    expect(withTrue.find((r) => r.name === 'maxAgeDays')?.hit).toBeNull();
    expect(withUndefined.find((r) => r.name === 'maxAgeDays')?.hit).toBeNull();
  });

  it('returns exactly four rows in the fixed order', () => {
    const rows = capsInForce(settings, undefined);
    expect(rows.map((r) => r.name)).toEqual([
      'maxNewPerLane',
      'maxProbesPerRun',
      'maxCardsPerUrl',
      'maxAgeDays',
    ]);
  });
});

describe('rulesInForce', () => {
  it('a 2-hard + 1-soft title fixture yields roles-companies: activeCount 3, hardCount 2', () => {
    const filterDoc = {
      title: {
        domain: { match: ['fintech'], reject: [], severity: 'hard' },
        function: { match: ['engineering'], reject: [], severity: 'hard' },
        seniority: { match: ['staff'], reject: [], severity: 'soft' },
      },
      locations: [{ city: 'Bengaluru', country: 'IN', workTypes: ['remote'] }],
      skills: { core: ['typescript', 'react'], minMatch: 1, severity: 'hard' },
    };
    const rows = rulesInForce(filterDoc, {});
    const roles = rows.find((r) => r.group === 'roles-companies');
    expect(roles).toEqual({ group: 'roles-companies', activeCount: 3, hardCount: 2 });
  });

  it('locations-derived where-you-work: hardCount equals activeCount (no per-entry severity)', () => {
    const filterDoc = {
      title: {},
      locations: [
        { city: 'Bengaluru', country: 'IN', workTypes: ['remote'] },
        { city: 'Pune', country: 'IN', workTypes: ['hybrid'] },
      ],
      skills: { core: [], minMatch: 1, severity: 'hard' },
    };
    const rows = rulesInForce(filterDoc, {});
    expect(rows.find((r) => r.group === 'where-you-work')).toEqual({
      group: 'where-you-work',
      activeCount: 2,
      hardCount: 2,
    });
  });

  it('skills: hardCount is 0 when severity is soft even with core entries present', () => {
    const filterDoc = {
      title: {},
      locations: [],
      skills: { core: ['sql', 'python'], minMatch: 1, severity: 'soft' },
    };
    const rows = rulesInForce(filterDoc, {});
    expect(rows.find((r) => r.group === 'skills')).toEqual({
      group: 'skills',
      activeCount: 2,
      hardCount: 0,
    });
  });

  it('an empty title key with an empty match/reject pair does not count as active', () => {
    const filterDoc = {
      title: { domain: { match: [], reject: [], severity: 'hard' } },
      locations: [],
      skills: { core: [], minMatch: 1, severity: 'hard' },
    };
    const rows = rulesInForce(filterDoc, {});
    expect(rows.find((r) => r.group === 'roles-companies')).toEqual({
      group: 'roles-companies',
      activeCount: 0,
      hardCount: 0,
    });
  });
});
