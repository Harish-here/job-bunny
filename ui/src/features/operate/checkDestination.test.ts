import { describe, expect, it } from 'vitest';
import { CHECK_TO_CARD } from '../hub/hub.model';
import { CHECK_TO_DESTINATION, groupHealthFindings } from './checkDestination';
import type { DoctorFinding } from './operate.api';

function finding(overrides: Partial<DoctorFinding> = {}): DoctorFinding {
  return { check: 'profile-parses', status: 'ok', detail: 'ok', ...overrides };
}

describe('CHECK_TO_DESTINATION', () => {
  it('covers every check hub.model.ts previously mapped to a card, one-for-one', () => {
    expect(Object.keys(CHECK_TO_DESTINATION).sort()).toEqual(
      Object.keys(CHECK_TO_CARD).sort(),
    );
  });

  it('maps notion-db-reachable to the delivery settings section (R23)', () => {
    expect(CHECK_TO_DESTINATION['notion-db-reachable']).toEqual({
      kind: 'settings-link',
      route: { name: 'settings', section: 'delivery' },
    });
  });

  it('does not invent a resume-not-parsed entry', () => {
    expect(CHECK_TO_DESTINATION['resume-parsed']).toBeUndefined();
    expect(CHECK_TO_DESTINATION['resume-not-parsed']).toBeUndefined();
  });
});

describe('groupHealthFindings', () => {
  it('puts every ok finding in the ok group regardless of destination kind', () => {
    const grouped = groupHealthFindings([
      finding({ check: 'profile-parses', status: 'ok' }),
      finding({ check: 'daemon-liveness', status: 'ok' }),
    ]);
    expect(grouped.ok.map((f) => f.check)).toEqual(['profile-parses', 'daemon-liveness']);
    expect(grouped['needs-action']).toEqual([]);
    expect(grouped['not-configured']).toEqual([]);
  });

  it('puts a non-ok settings-link finding under needs-action', () => {
    const grouped = groupHealthFindings([
      finding({ check: 'notion-db-reachable', status: 'warn', detail: 'token missing' }),
    ]);
    expect(grouped['needs-action']).toHaveLength(1);
    expect(grouped['needs-action'][0]?.check).toBe('notion-db-reachable');
    expect(grouped['not-configured']).toEqual([]);
  });

  it('puts a non-ok cli-command finding under not-configured', () => {
    const grouped = groupHealthFindings([
      finding({ check: 'daemon-liveness', status: 'warn', detail: 'daemon not running' }),
    ]);
    expect(grouped['not-configured']).toHaveLength(1);
    expect(grouped['not-configured'][0]?.check).toBe('daemon-liveness');
    expect(grouped['needs-action']).toEqual([]);
  });

  it('falls back to needs-action for an unmapped check rather than dropping it', () => {
    const grouped = groupHealthFindings([
      finding({ check: 'never-heard-of-it', status: 'red', detail: 'mystery failure' }),
    ]);
    expect(grouped['needs-action']).toHaveLength(1);
    expect(grouped['not-configured']).toEqual([]);
  });

  it('returns empty arrays for an empty finding list', () => {
    expect(groupHealthFindings([])).toEqual({
      'needs-action': [],
      'not-configured': [],
      ok: [],
    });
  });
});
