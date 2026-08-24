import { describe, expect, it } from 'vitest';
import { DEFAULTS, validatePacingPairs, validateState } from './fetching.state';

describe('validatePacingPairs', () => {
  it('returns no errors when every min/max pair is in order', () => {
    expect(validatePacingPairs(DEFAULTS)).toEqual({});
  });

  // B3 fix (QA settings-overhaul): the exact ux-notes §11 named case —
  // both fields, both values, and the consequence.
  it('names both fields, both values, and the run-fails consequence for an inverted jitter pair', () => {
    const errors = validatePacingPairs({
      ...DEFAULTS,
      jitterMinMs: 15_000,
      jitterMaxMs: 12_000,
    });
    const expected =
      'Minimum jitter (15000 ms) is above maximum jitter (12000 ms). ' +
      'The run would fail to start.';
    expect(errors['fetching.jitterMinMs']).toBe(expected);
    expect(errors['fetching.jitterMaxMs']).toBe(expected);
  });

  it('carries the same shape for an inverted inter-url-delay pair', () => {
    const errors = validatePacingPairs({
      ...DEFAULTS,
      interUrlDelayMinMs: 50_000,
      interUrlDelayMaxMs: 40_000,
    });
    const expected =
      'Minimum time between searches (50000 ms) is above maximum time between searches ' +
      '(40000 ms). The run would fail to start.';
    expect(errors['fetching.interUrlDelayMinMs']).toBe(expected);
    expect(errors['fetching.interUrlDelayMaxMs']).toBe(expected);
  });

  it('flags both pairs independently when both are inverted', () => {
    const errors = validatePacingPairs({
      ...DEFAULTS,
      jitterMinMs: 15_000,
      jitterMaxMs: 12_000,
      interUrlDelayMinMs: 50_000,
      interUrlDelayMaxMs: 40_000,
    });
    expect(Object.keys(errors).sort()).toEqual(
      [
        'fetching.interUrlDelayMaxMs',
        'fetching.interUrlDelayMinMs',
        'fetching.jitterMaxMs',
        'fetching.jitterMinMs',
      ].sort(),
    );
  });
});

describe('validateState', () => {
  it('returns no errors for the shipped defaults', () => {
    expect(validateState(DEFAULTS)).toEqual({});
  });

  it('flags a cap field outside its bounds, keyed fetching.<field>', () => {
    const errors = validateState({ ...DEFAULTS, maxNewPerLane: 0 });
    expect(errors['fetching.maxNewPerLane']).toContain('between 1 and 500');
  });
});
