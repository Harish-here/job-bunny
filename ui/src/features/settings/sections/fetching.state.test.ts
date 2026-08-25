import { describe, expect, it } from 'vitest';
import { DEFAULTS, validatePacingPairs, validateState } from './fetching.state';

describe('validatePacingPairs', () => {
  it('returns no errors when every min/max pair is in order', () => {
    expect(validatePacingPairs(DEFAULTS)).toEqual({ summary: {}, inline: {} });
  });

  // B3 fix (QA settings-overhaul): the exact ux-notes §11 named case —
  // both fields, both values, and the consequence. B12 fix (round 2): the
  // MAX field gets its OWN sentence in `summary` (not a copy of the min
  // field's), and `inline` carries mockup S8's short form.
  it('names both fields, both values, and the run-fails consequence for an inverted jitter pair — the max field with its own sentence', () => {
    const errors = validatePacingPairs({
      ...DEFAULTS,
      jitterMinMs: 15_000,
      jitterMaxMs: 12_000,
    });
    expect(errors.summary['fetching.jitterMinMs']).toBe(
      'Minimum jitter (15000 ms) is above maximum jitter (12000 ms). ' +
        'The run would fail to start.',
    );
    expect(errors.summary['fetching.jitterMaxMs']).toBe(
      'Maximum jitter (12000 ms) is below minimum jitter (15000 ms). ' +
        'The run would fail to start.',
    );
    expect(errors.inline['fetching.jitterMinMs']).toBe(
      'Above maximum jitter (12000 ms).',
    );
    expect(errors.inline['fetching.jitterMaxMs']).toBe(
      'Below minimum jitter (15000 ms).',
    );
  });

  it('carries the same shape for an inverted inter-url-delay pair', () => {
    const errors = validatePacingPairs({
      ...DEFAULTS,
      interUrlDelayMinMs: 50_000,
      interUrlDelayMaxMs: 40_000,
    });
    expect(errors.summary['fetching.interUrlDelayMinMs']).toBe(
      'Minimum time between searches (50000 ms) is above maximum time between searches ' +
        '(40000 ms). The run would fail to start.',
    );
    expect(errors.summary['fetching.interUrlDelayMaxMs']).toBe(
      'Maximum time between searches (40000 ms) is below minimum time between searches ' +
        '(50000 ms). The run would fail to start.',
    );
    expect(errors.inline['fetching.interUrlDelayMinMs']).toBe(
      'Above maximum time between searches (40000 ms).',
    );
    expect(errors.inline['fetching.interUrlDelayMaxMs']).toBe(
      'Below minimum time between searches (50000 ms).',
    );
  });

  it('flags both pairs independently when both are inverted', () => {
    const errors = validatePacingPairs({
      ...DEFAULTS,
      jitterMinMs: 15_000,
      jitterMaxMs: 12_000,
      interUrlDelayMinMs: 50_000,
      interUrlDelayMaxMs: 40_000,
    });
    const expectedKeys = [
      'fetching.interUrlDelayMaxMs',
      'fetching.interUrlDelayMinMs',
      'fetching.jitterMaxMs',
      'fetching.jitterMinMs',
    ].sort();
    expect(Object.keys(errors.summary).sort()).toEqual(expectedKeys);
    expect(Object.keys(errors.inline).sort()).toEqual(expectedKeys);
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
