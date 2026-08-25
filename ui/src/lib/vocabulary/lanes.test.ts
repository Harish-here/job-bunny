import { Building2 } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { laneIcon, laneLabel } from './lanes.ts';

describe('laneLabel', () => {
  it('labels linkedin as LinkedIn', () => {
    expect(laneLabel('linkedin')).toBe('LinkedIn');
  });

  it('labels greenhouse as Greenhouse', () => {
    expect(laneLabel('greenhouse')).toBe('Greenhouse');
  });

  it('labels keka as Keka', () => {
    expect(laneLabel('keka')).toBe('Keka');
  });

  it('falls back to the raw string for an unknown lane, never throws', () => {
    expect(laneLabel('unknown-lane')).toBe('unknown-lane');
  });
});

describe('laneIcon', () => {
  it('returns Building2 for every lane, including linkedin (no lucide LinkedIn icon exists)', () => {
    expect(laneIcon('linkedin')).toBe(Building2);
    expect(laneIcon('greenhouse')).toBe(Building2);
    expect(laneIcon('keka')).toBe(Building2);
    expect(laneIcon('unknown-lane')).toBe(Building2);
  });
});
