import { describe, expect, it } from 'vitest';
import {
  getFailedStage,
  getFailureError,
  getFunnelStages,
  newMatchCount,
} from './runResult';

describe('getFunnelStages', () => {
  it('parses a well-formed result blob', () => {
    const result = {
      stages: [
        { name: 'filter', jobsIn: 10, jobsOut: 7, dropsByRule: { title: 3 } },
        { name: 'rank', jobsIn: 7, jobsOut: 7, dropsByRule: {} },
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
        { name: 'filter', jobsIn: 10, jobsOut: 7, dropsByRule: {} },
        { name: 'rank', jobsIn: 7, jobsOut: 4, dropsByRule: {} },
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
