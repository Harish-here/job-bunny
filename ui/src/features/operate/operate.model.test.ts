import { describe, expect, it } from 'vitest';
import { scheduleWarning } from './operate.model';

describe('scheduleWarning', () => {
  it('returns the first scheduled time when the daemon is down and the schedule is enabled', () => {
    expect(
      scheduleWarning({
        daemonState: 'stopped',
        scheduleEnabled: true,
        times: ['09:00', '14:00'],
      }),
    ).toEqual({ firstTime: '09:00' });
  });

  it.each([
    ['running', true, ['09:00']],
    ['stopped', false, ['09:00']],
    ['stopped', true, []],
    ['stale', true, []],
  ] as const)(
    'returns null for daemonState=%s scheduleEnabled=%s times=%j',
    (daemonState, scheduleEnabled, times) => {
      expect(
        scheduleWarning({ daemonState, scheduleEnabled, times: [...times] }),
      ).toBeNull();
    },
  );
});
