import { describe, expect, it } from 'vitest';
import { presetFromRanges, rangesFromPreset } from './fetching.model';

describe('fetching.model', () => {
  it('presetFromRanges recognizes each named preset by its exact ms values', () => {
    expect(presetFromRanges(8_000, 18_000, 35_000, 70_000)).toBe('safe');
    expect(presetFromRanges(5_000, 12_000, 20_000, 45_000)).toBe('normal');
    expect(presetFromRanges(2_000, 5_000, 8_000, 15_000)).toBe('fast');
  });

  it('presetFromRanges returns custom for a value that matches no preset exactly', () => {
    expect(presetFromRanges(5_000, 12_000, 20_000, 45_001)).toBe('custom');
    expect(presetFromRanges(15_000, 12_000, 20_000, 45_000)).toBe('custom');
    expect(presetFromRanges(0, 0, 0, 0)).toBe('custom');
  });

  it('rangesFromPreset is the exact inverse of presetFromRanges for every named preset', () => {
    for (const preset of ['safe', 'normal', 'fast'] as const) {
      const ranges = rangesFromPreset(preset);
      expect(
        presetFromRanges(
          ranges.jitterMinMs,
          ranges.jitterMaxMs,
          ranges.interUrlDelayMinMs,
          ranges.interUrlDelayMaxMs,
        ),
      ).toBe(preset);
    }
  });

  it("normal matches core/config/linkedin_pacing's shipped defaults", () => {
    // DEFAULT_JITTER_MIN_MS/MAX_MS = 5000/12000, DEFAULT_INTER_URL_DELAY_MIN_MS/MAX_MS
    // = 20000/45000 (src/core/config/linkedin_pacing/index.ts) — copied as reference
    // numbers per this module's own doc comment, not re-imported.
    expect(rangesFromPreset('normal')).toEqual({
      jitterMinMs: 5_000,
      jitterMaxMs: 12_000,
      interUrlDelayMinMs: 20_000,
      interUrlDelayMaxMs: 45_000,
    });
  });
});
