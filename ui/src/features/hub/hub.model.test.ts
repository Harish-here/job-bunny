import { describe, expect, it } from 'vitest';
import type { DoctorFinding } from './hub.api';
import {
  CHECK_TO_CARD,
  cardStatus,
  groupFindings,
  HUB_CARDS,
  scheduleWarning,
} from './hub.model';

function finding(
  check: string,
  status: DoctorFinding['status'],
  detail?: string,
): DoctorFinding {
  return { check, status, detail: detail ?? check };
}

describe('CHECK_TO_CARD', () => {
  it('maps every frozen check string to its card', () => {
    expect(CHECK_TO_CARD).toEqual({
      'profile-parses': 'profile',
      'sqlite-path-retired': 'profile',
      wire: 'profile',
      'filter-parses': 'persona-filters',
      'empty-lanes': 'search-urls',
      'linkedin-inventory-freshness': 'search-urls',
      'env-tokens': 'integrations',
      'notion-db-reachable': 'integrations',
      'telegram-bot-token': 'integrations',
      'daemon-liveness': 'schedule-daemon',
      'claude-cli-on-path': 'pipeline-health',
      'cdp-reachable': 'pipeline-health',
      'sqlite-db-openable': 'pipeline-health',
      'config-legacy-divergence': 'pipeline-health',
    });
  });
});

describe('HUB_CARDS', () => {
  it('lists the six cards in the frozen order', () => {
    expect(HUB_CARDS.map((c) => c.id)).toEqual([
      'profile',
      'persona-filters',
      'search-urls',
      'integrations',
      'schedule-daemon',
      'pipeline-health',
    ]);
  });
});

describe('groupFindings', () => {
  it('groups a finding for every mapped check under its own card', () => {
    const findings = Object.keys(CHECK_TO_CARD).map((check) => finding(check, 'ok'));
    const grouped = groupFindings(findings);
    for (const [check, cardId] of Object.entries(CHECK_TO_CARD)) {
      expect(grouped[cardId].some((f) => f.check === check)).toBe(true);
    }
  });

  it('falls an unrecognized check back to pipeline-health', () => {
    const grouped = groupFindings([finding('some-future-check', 'ok')]);
    expect(grouped['pipeline-health']).toHaveLength(1);
    expect(grouped['pipeline-health'][0]?.check).toBe('some-future-check');
  });

  it('leaves a card with no matching findings empty', () => {
    const grouped = groupFindings([finding('filter-parses', 'ok')]);
    expect(grouped.profile).toEqual([]);
  });
});

describe('cardStatus', () => {
  it.each([
    [[], 'unknown'],
    [['ok', 'ok'], 'ok'],
    [['ok', 'warn'], 'warn'],
    [['warn', 'red', 'ok'], 'red'],
  ] as const)('%j → %s', (statuses, expected) => {
    expect(cardStatus(statuses.map((s, i) => finding(String(i), s)))).toBe(expected);
  });
});

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
