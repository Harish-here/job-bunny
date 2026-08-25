import { describe, expect, it } from 'vitest';
import { TRIAGE_ACTION_LABELS } from './triageActions.ts';

describe('TRIAGE_ACTION_LABELS', () => {
  it('labels apply as Apply', () => {
    expect(TRIAGE_ACTION_LABELS.apply).toBe('Apply');
  });

  it('labels save as Lead', () => {
    expect(TRIAGE_ACTION_LABELS.save).toBe('Lead');
  });

  it('labels skip as Pass (R11 — never "Skip")', () => {
    expect(TRIAGE_ACTION_LABELS.skip).toBe('Pass');
  });
});
