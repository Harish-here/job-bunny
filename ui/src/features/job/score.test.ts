import { describe, expect, it } from 'vitest';
import { scoreBand, scoreSegments } from './score';

describe('scoreBand / scoreSegments — 4 worked examples from the mockup', () => {
  it('74 -> Good, 3 segments', () => {
    expect(scoreBand(74)).toBe('Good');
    expect(scoreSegments(74)).toBe(3);
  });

  it('81 -> Good, 3 segments', () => {
    expect(scoreBand(81)).toBe('Good');
    expect(scoreSegments(81)).toBe(3);
  });

  it('51 -> Fair, 2 segments', () => {
    expect(scoreBand(51)).toBe('Fair');
    expect(scoreSegments(51)).toBe(2);
  });

  it('39 -> Weak, 1 segment', () => {
    expect(scoreBand(39)).toBe('Weak');
    expect(scoreSegments(39)).toBe(1);
  });
});

describe('scoreBand — boundary values', () => {
  it('85 -> Strong (the >=85 boundary the worked examples do not exercise)', () => {
    expect(scoreBand(85)).toBe('Strong');
    expect(scoreSegments(85)).toBe(4);
  });

  it('84 -> Good (just below the Strong boundary)', () => {
    expect(scoreBand(84)).toBe('Good');
    expect(scoreSegments(84)).toBe(3);
  });

  it('70 -> Good, 69 -> Fair (the Good/Fair boundary)', () => {
    expect(scoreBand(70)).toBe('Good');
    expect(scoreBand(69)).toBe('Fair');
  });

  it('50 -> Fair, 49 -> Weak (the Fair/Weak boundary)', () => {
    expect(scoreBand(50)).toBe('Fair');
    expect(scoreBand(49)).toBe('Weak');
  });

  it('0 -> Weak, 1 segment', () => {
    expect(scoreBand(0)).toBe('Weak');
    expect(scoreSegments(0)).toBe(1);
  });

  it('100 -> Strong, 4 segments', () => {
    expect(scoreBand(100)).toBe('Strong');
    expect(scoreSegments(100)).toBe(4);
  });
});
