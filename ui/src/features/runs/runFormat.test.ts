import { describe, expect, it } from 'vitest';
import { formatDuration, formatWhen, statusLabel, statusVariant } from './runFormat';

describe('formatDuration', () => {
  it('returns em dash when the run has not finished', () => {
    expect(formatDuration('2026-08-05T09:00:00.000Z', null)).toBe('—');
  });

  it('renders seconds only under a minute', () => {
    expect(formatDuration('2026-08-05T09:00:00.000Z', '2026-08-05T09:00:42.000Z')).toBe(
      '42s',
    );
  });

  it('renders minutes and seconds at or over a minute', () => {
    expect(formatDuration('2026-08-05T09:00:00.000Z', '2026-08-05T09:02:05.000Z')).toBe(
      '2m 5s',
    );
  });

  it('returns em dash for a negative/malformed span', () => {
    expect(formatDuration('2026-08-05T09:02:00.000Z', '2026-08-05T09:00:00.000Z')).toBe(
      '—',
    );
  });
});

describe('formatWhen', () => {
  it('joins date and timeDir', () => {
    expect(formatWhen({ date: '2026-08-05', timeDir: '09-00' })).toBe('2026-08-05 09-00');
  });

  it('falls back to date alone when timeDir is null', () => {
    expect(formatWhen({ date: '2026-08-05', timeDir: null })).toBe('2026-08-05');
  });
});

describe('statusVariant/statusLabel', () => {
  it('maps every status to a badge variant and a capitalized label', () => {
    expect(statusVariant('passed')).toBe('default');
    expect(statusVariant('failed')).toBe('destructive');
    expect(statusVariant('crashed')).toBe('destructive');
    expect(statusVariant('running')).toBe('secondary');
    expect(statusLabel('running')).toBe('Running');
    expect(statusLabel('crashed')).toBe('Crashed');
  });
});
