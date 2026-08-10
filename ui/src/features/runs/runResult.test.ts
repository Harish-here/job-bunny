import { describe, expect, it } from 'vitest';
import {
  computeRetention,
  type FunnelStage,
  getBiggestDrop,
  getFailedStage,
  getFailureError,
  getFunnelStages,
  newMatchCount,
} from './runResult';

describe('getFunnelStages', () => {
  it('parses a well-formed result blob', () => {
    const result = {
      stages: [
        {
          name: 'filter',
          jobsIn: 10,
          jobsOut: 7,
          dropsByRule: { title: 3 },
          elapsedMs: 120,
          attempts: 1,
        },
        {
          name: 'rank',
          jobsIn: 7,
          jobsOut: 7,
          dropsByRule: {},
          elapsedMs: 40,
          attempts: 1,
        },
      ],
    };
    expect(getFunnelStages(result)).toEqual(result.stages);
  });

  it('returns null for a missing stages array', () => {
    expect(getFunnelStages({})).toBeNull();
    expect(getFunnelStages(null)).toBeNull();
    expect(getFunnelStages(undefined)).toBeNull();
  });

  it('returns null when any stage entry is malformed', () => {
    expect(
      getFunnelStages({ stages: [{ name: 'filter', jobsIn: 10 /* jobsOut missing */ }] }),
    ).toBeNull();
  });

  it('returns null when a stage entry is missing elapsedMs or attempts', () => {
    expect(
      getFunnelStages({
        stages: [
          {
            name: 'filter',
            jobsIn: 10,
            jobsOut: 7,
            dropsByRule: {},
            attempts: 1 /* elapsedMs missing */,
          },
        ],
      }),
    ).toBeNull();
    expect(
      getFunnelStages({
        stages: [
          {
            name: 'filter',
            jobsIn: 10,
            jobsOut: 7,
            dropsByRule: {},
            elapsedMs: 120 /* attempts missing */,
          },
        ],
      }),
    ).toBeNull();
  });
});

describe('getFailedStage / getFailureError', () => {
  it('reads stage and error off a well-formed failure blob', () => {
    const failure = { stage: 'structure', error: 'boom', elapsedMs: 5 };
    expect(getFailedStage(failure)).toBe('structure');
    expect(getFailureError(failure)).toBe('boom');
  });

  it('returns null for an absent/malformed failure blob', () => {
    expect(getFailedStage(null)).toBeNull();
    expect(getFailedStage({})).toBeNull();
    expect(getFailureError(undefined)).toBeNull();
  });
});

describe('newMatchCount', () => {
  it("returns the last funnel stage's jobsOut on a good funnel", () => {
    const result = {
      stages: [
        {
          name: 'filter',
          jobsIn: 10,
          jobsOut: 7,
          dropsByRule: {},
          elapsedMs: 100,
          attempts: 1,
        },
        {
          name: 'rank',
          jobsIn: 7,
          jobsOut: 4,
          dropsByRule: {},
          elapsedMs: 30,
          attempts: 1,
        },
      ],
    };
    expect(newMatchCount(result)).toBe(4);
  });

  it('returns 0 for an empty stages array', () => {
    expect(newMatchCount({ stages: [] })).toBe(0);
  });

  it('returns 0 for a missing blob', () => {
    expect(newMatchCount(undefined)).toBe(0);
    expect(newMatchCount(null)).toBe(0);
  });

  it('returns 0 for a malformed blob', () => {
    expect(newMatchCount({ stages: [{ name: 'filter', jobsIn: 10 }] })).toBe(0);
    expect(newMatchCount('not an object')).toBe(0);
  });
});

describe('getBiggestDrop', () => {
  it('returns the single largest drop across all stages/rules', () => {
    const stages: FunnelStage[] = [
      {
        name: 'filter',
        jobsIn: 10,
        jobsOut: 5,
        dropsByRule: { title: 3, companies: 2 },
        elapsedMs: 100,
        attempts: 1,
      },
      {
        name: 'dedup',
        jobsIn: 5,
        jobsOut: 4,
        dropsByRule: { duplicate: 1 },
        elapsedMs: 20,
        attempts: 1,
      },
    ];
    expect(getBiggestDrop(stages)).toEqual({ stage: 'filter', rule: 'title', count: 3 });
  });

  it('ties break to the first-encountered stage/rule in array order', () => {
    const stages: FunnelStage[] = [
      {
        name: 'filter',
        jobsIn: 10,
        jobsOut: 8,
        dropsByRule: { title: 2 },
        elapsedMs: 100,
        attempts: 1,
      },
      {
        name: 'dedup',
        jobsIn: 8,
        jobsOut: 6,
        dropsByRule: { duplicate: 2 },
        elapsedMs: 20,
        attempts: 1,
      },
    ];
    // Both drops tie at 2 — first-encountered-in-stage-array-order wins (filter/title),
    // enforced by using `>` (not `>=`) when comparing to the running max.
    expect(getBiggestDrop(stages)).toEqual({ stage: 'filter', rule: 'title', count: 2 });
  });

  it('returns null for an empty stages array', () => {
    expect(getBiggestDrop([])).toBeNull();
  });

  it('returns null when no stage has any drops', () => {
    const stages = [
      {
        name: 'filter',
        jobsIn: 10,
        jobsOut: 10,
        dropsByRule: {},
        elapsedMs: 100,
        attempts: 1,
      },
      {
        name: 'rank',
        jobsIn: 10,
        jobsOut: 10,
        dropsByRule: {},
        elapsedMs: 20,
        attempts: 1,
      },
    ];
    expect(getBiggestDrop(stages)).toBeNull();
  });
});

describe('computeRetention', () => {
  it('excludes reconcile and farm by name from the computed numbers', () => {
    const baseStages = (farmJobsOut: number): FunnelStage[] => [
      {
        name: 'reconcile',
        jobsIn: 0,
        jobsOut: 0,
        dropsByRule: {},
        elapsedMs: 10,
        attempts: 1,
      },
      {
        name: 'farm',
        jobsIn: 0,
        jobsOut: farmJobsOut,
        dropsByRule: {},
        elapsedMs: 500,
        attempts: 1,
      },
      {
        name: 'source',
        jobsIn: 50,
        jobsOut: 50,
        dropsByRule: {},
        elapsedMs: 200,
        attempts: 1,
      },
      {
        name: 'filter',
        jobsIn: 50,
        jobsOut: 20,
        dropsByRule: { title: 30 },
        elapsedMs: 30,
        attempts: 1,
      },
      {
        name: 'rank',
        jobsIn: 20,
        jobsOut: 20,
        dropsByRule: {},
        elapsedMs: 10,
        attempts: 1,
      },
    ];

    const retentionA = computeRetention(baseStages(9999));
    const retentionB = computeRetention(baseStages(1));

    expect(retentionA).toEqual(retentionB);
    expect(retentionA).toEqual({ startCount: 50, endCount: 20, retainedPct: 40 });
  });

  it('returns a zero-retention shape for an empty (post-exclusion) stage list', () => {
    const stages: FunnelStage[] = [
      {
        name: 'reconcile',
        jobsIn: 0,
        jobsOut: 0,
        dropsByRule: {},
        elapsedMs: 10,
        attempts: 1,
      },
      {
        name: 'farm',
        jobsIn: 0,
        jobsOut: 5,
        dropsByRule: {},
        elapsedMs: 500,
        attempts: 1,
      },
    ];
    expect(computeRetention(stages)).toEqual({
      startCount: 0,
      endCount: 0,
      retainedPct: 0,
    });
  });
});
