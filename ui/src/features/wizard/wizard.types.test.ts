import { describe, expect, it } from 'vitest';
import type { DaemonProfileSchedule } from './wizard.types';

describe('DaemonProfileSchedule', () => {
  it('accepts degraded and degradedReason fields (compile-time mirror of ports/board.ts)', () => {
    const healthy: DaemonProfileSchedule = {
      profile: 'harish',
      enabled: true,
      nextRunAt: '2026-08-13T09:00:00.000Z',
      degraded: false,
      degradedReason: null,
    };
    const degraded: DaemonProfileSchedule = {
      profile: 'rajni',
      enabled: true,
      nextRunAt: null,
      degraded: true,
      degradedReason:
        "the database schema (v8) is newer than the running daemon's build (v7).",
    };
    expect(healthy.degraded).toBe(false);
    expect(healthy.degradedReason).toBeNull();
    expect(degraded.degraded).toBe(true);
    expect(degraded.degradedReason).toContain('v8');
  });
});
