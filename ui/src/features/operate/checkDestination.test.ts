import { describe, expect, it } from 'vitest';
import { CHECK_TO_DESTINATION, groupHealthFindings } from './checkDestination';
import type { DoctorFinding } from './operate.api';

function finding(overrides: Partial<DoctorFinding> = {}): DoctorFinding {
  return { check: 'profile-parses', status: 'ok', detail: 'ok', ...overrides };
}

// The frozen 14 check names `hub.model.ts`'s (now-deleted) `CHECK_TO_CARD`
// used to map one-for-one — `checkDestination.ts`'s own docstring names
// each one's new destination. Inlined here rather than imported, since
// the file that used to hold this list no longer exists.
const FROZEN_CHECKS = [
  'profile-parses',
  'sqlite-path-retired',
  'wire',
  'filter-parses',
  'empty-lanes',
  'linkedin-inventory-freshness',
  'env-tokens',
  'notion-db-reachable',
  'telegram-bot-token',
  'daemon-liveness',
  'claude-cli-on-path',
  'cdp-reachable',
  'sqlite-db-openable',
  'config-legacy-divergence',
];

describe('CHECK_TO_DESTINATION', () => {
  it('covers the frozen 14 check names one-for-one', () => {
    expect(Object.keys(CHECK_TO_DESTINATION).sort()).toEqual(FROZEN_CHECKS.sort());
  });

  it('maps notion-db-reachable to the delivery settings section (R23)', () => {
    expect(CHECK_TO_DESTINATION['notion-db-reachable']).toEqual({
      kind: 'settings-link',
      route: { name: 'settings', section: 'delivery' },
    });
  });

  // B6 (QA settings-overhaul): these two are unambiguously "a secret is
  // missing/invalid" findings — the only page that can set a secret is
  // Operate's card-secrets, not Delivery (DeliverySection.tsx renders no
  // secret value or input at all). Round 2: since `SetupHealthCard` only
  // ever renders ON Operate, a bare `navigate()` to `{name:'setup'}` is a
  // same-page no-op — `focusSelector` carries the actual remedy (scroll
  // `card-secrets` into view, focus its first action button).
  it('maps env-tokens and telegram-bot-token to Operate/card-secrets, not delivery', () => {
    expect(CHECK_TO_DESTINATION['env-tokens']).toEqual({
      kind: 'settings-link',
      route: { name: 'setup' },
      focusSelector: '[data-qa="card-secrets"] button',
    });
    expect(CHECK_TO_DESTINATION['telegram-bot-token']).toEqual({
      kind: 'settings-link',
      route: { name: 'setup' },
      focusSelector: '[data-qa="card-secrets"] button',
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
