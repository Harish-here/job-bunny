import { describe, expect, it } from 'vitest';
import type { DaemonStatus } from '../wizard/wizard.types';
import { daemonStatusWord } from './daemonState';

const BASE_PROFILE = {
  profile: 'rajni',
  enabled: true,
  nextRunAt: null,
  degraded: false,
  degradedReason: null,
  schemaVersion: null,
  buildVersion: null,
};

function daemon(overrides: Partial<DaemonStatus>): DaemonStatus {
  return {
    state: 'running',
    pid: 1,
    startedAt: '2026-08-13T09:00:00.000Z',
    lastTickAt: null,
    inFlight: null,
    profiles: [BASE_PROFILE],
    ...overrides,
  };
}

// Expected text substrings ported byte-for-byte from
// ScheduleSection.test.tsx's per-state assertions, proving this extraction
// changed no observable text.

describe('daemonStatusWord', () => {
  it('degraded — terse version-comparison form, attention tone', () => {
    const degradedReason =
      "the database schema (v8) is newer than the running daemon's build (v7). This happens after an update that changes the schema.";
    const status = daemonStatusWord(
      daemon({
        lastTickAt: new Date().toISOString(),
        profiles: [
          {
            ...BASE_PROFILE,
            degraded: true,
            degradedReason,
            schemaVersion: 8,
            buildVersion: 7,
          },
        ],
      }),
      'rajni',
    );
    expect(status.word).toBe('Degraded — schema v8 > daemon build v7');
    expect(status.tone).toBe('attention');
    expect(status.word).not.toContain(degradedReason);
    expect(status.detail).toContain('jobbunny serve stop && jobbunny serve start');
  });

  it('stopped — "Not running", destructive tone', () => {
    const status = daemonStatusWord(
      daemon({ state: 'stopped', lastTickAt: null }),
      'rajni',
    );
    expect(status.word).toBe('Not running');
    expect(status.tone).toBe('destructive');
    expect(status.detail).toContain('jobbunny serve start');
  });

  it('stale — "Wedged · last tick Ns ago", attention tone', () => {
    const lastTickAt = new Date(Date.now() - 600_000).toISOString(); // 10m ago.
    const status = daemonStatusWord(daemon({ state: 'stale', lastTickAt }), 'rajni');
    expect(status.word).toBe('Wedged');
    expect(status.tone).toBe('attention');
    expect(status.detail).toMatch(/· last tick 60[0-4]s ago/);
  });

  it('running (healthy) — "Running · last tick Ns ago", success tone', () => {
    const lastTickAt = new Date(Date.now() - 12_000).toISOString(); // 12s ago.
    const status = daemonStatusWord(daemon({ state: 'running', lastTickAt }), 'rajni');
    expect(status.word).toBe('Running');
    expect(status.tone).toBe('success');
    expect(status.detail).toMatch(/· last tick 1[0-4]s ago/);
  });
});
