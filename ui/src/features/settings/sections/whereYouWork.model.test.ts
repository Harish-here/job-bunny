import { describe, expect, it } from 'vitest';
import { computeTimezoneConflict } from './whereYouWork.model';

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
