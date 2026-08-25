import { describe, expect, it } from 'vitest';
import { SEVERITY_ORDER, worstSeverity } from './severityOrder';

describe('SEVERITY_ORDER', () => {
  it('is the frozen order: daemon down > session signed out > breaker open > check failing', () => {
    expect(SEVERITY_ORDER).toEqual([
      'daemon-down',
      'session-signed-out',
      'breaker-open',
      'check-failing',
    ]);
  });
});

describe('worstSeverity', () => {
  it('returns null when nothing is present', () => {
    expect(worstSeverity([])).toBeNull();
  });

  it('returns the single present severity', () => {
    expect(worstSeverity(['breaker-open'])).toBe('breaker-open');
  });

  it('picks daemon-down over every other severity, regardless of input order', () => {
    expect(
      worstSeverity([
        'check-failing',
        'breaker-open',
        'daemon-down',
        'session-signed-out',
      ]),
    ).toBe('daemon-down');
    expect(worstSeverity(['check-failing', 'daemon-down'])).toBe('daemon-down');
  });

  it('picks session-signed-out over breaker-open and check-failing', () => {
    expect(worstSeverity(['check-failing', 'session-signed-out', 'breaker-open'])).toBe(
      'session-signed-out',
    );
  });

  it('picks breaker-open over check-failing', () => {
    expect(worstSeverity(['check-failing', 'breaker-open'])).toBe('breaker-open');
  });
});
