import { describe, expect, it } from 'vitest';
import type { RunEventRow } from '../../lib/api/types';
import { formatRetryIn, readBreakerRetryAt } from './diagnosisActions';

function event(msg: string, data?: Record<string, unknown>): RunEventRow {
  return { ts: '2026-08-11T21:00:00.000Z', level: 'warn', msg, data };
}

describe('readBreakerRetryAt', () => {
  it('returns data.reopenAt from the real breaker-open-skip warn shape (adapters/lanes/linkedin/lane.ts:154-157)', () => {
    const events: RunEventRow[] = [
      event(
        'linkedin lane: throttle breaker is open — skipping this fire without launching a browser',
        { reopenAt: '2026-08-11T21:40:00.000Z', tripCount: 12 },
      ),
    ];
    expect(readBreakerRetryAt(events)).toBe('2026-08-11T21:40:00.000Z');
  });

  it('returns undefined when no event carries the breaker-open-skip message', () => {
    const events: RunEventRow[] = [
      event('some other unrelated warn'),
      event('linkedin lane: opening the breaker after N trips', { tripCount: 3 }),
    ];
    expect(readBreakerRetryAt(events)).toBeUndefined();
  });

  it('returns undefined when the matching event carries no reopenAt', () => {
    const events: RunEventRow[] = [
      event('linkedin lane: throttle breaker is open — skipping this fire', {
        tripCount: 5,
      }),
    ];
    expect(readBreakerRetryAt(events)).toBeUndefined();
  });

  it('returns undefined for malformed data (non-object, or reopenAt not a string)', () => {
    const events: RunEventRow[] = [
      event('linkedin lane: throttle breaker is open — skipping this fire', {
        reopenAt: 12345,
      }),
    ];
    expect(readBreakerRetryAt(events)).toBeUndefined();
  });

  it('returns undefined for events with no data at all', () => {
    const events: RunEventRow[] = [
      event('linkedin lane: throttle breaker is open — skipping this fire'),
    ];
    expect(readBreakerRetryAt(events)).toBeUndefined();
  });

  it('returns undefined for an undefined events array', () => {
    expect(readBreakerRetryAt(undefined)).toBeUndefined();
  });

  it('returns the LAST matching event when multiple breaker-open events are present', () => {
    const events: RunEventRow[] = [
      event('linkedin lane: throttle breaker is open — skipping this fire', {
        reopenAt: '2026-08-11T21:00:00.000Z',
      }),
      event('linkedin lane: throttle breaker is open — skipping this fire', {
        reopenAt: '2026-08-11T22:00:00.000Z',
      }),
    ];
    expect(readBreakerRetryAt(events)).toBe('2026-08-11T22:00:00.000Z');
  });
});

describe('formatRetryIn', () => {
  const now = Date.parse('2026-08-11T21:00:00.000Z');

  it('formats a future retryAt in whole minutes', () => {
    const retryAt = new Date(now + 34 * 60_000).toISOString();
    expect(formatRetryIn(retryAt, now)).toBe('Retry in 34m');
  });

  it('formats a sub-minute remainder as <1m', () => {
    const retryAt = new Date(now + 30_000).toISOString();
    expect(formatRetryIn(retryAt, now)).toBe('Retry in <1m');
  });

  it('returns null for a retryAt in the past', () => {
    const retryAt = new Date(now - 1000).toISOString();
    expect(formatRetryIn(retryAt, now)).toBeNull();
  });

  it('returns null for a retryAt exactly at now (remaining <= 0)', () => {
    const retryAt = new Date(now).toISOString();
    expect(formatRetryIn(retryAt, now)).toBeNull();
  });

  it('returns null for an unparseable retryAt', () => {
    expect(formatRetryIn('not-a-date', now)).toBeNull();
  });
});
