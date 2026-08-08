import type { DaemonState } from '../wizard/wizard.types';
import type { DoctorFinding } from './hub.api';

export type HubCardId =
  | 'profile'
  | 'persona-filters'
  | 'search-urls'
  | 'integrations'
  | 'schedule-daemon'
  | 'pipeline-health';

export type HubCardStatus = 'ok' | 'warn' | 'red' | 'unknown';

// Every check string the doctor route can emit, mapped to its card. Any
// check NOT listed here falls back to pipeline-health in groupFindings.
export const CHECK_TO_CARD: Record<string, HubCardId> = {
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
};

export interface HubCardDef {
  id: HubCardId;
  title: string;
  blurb: string;
}

export const HUB_CARDS: HubCardDef[] = [
  {
    id: 'profile',
    title: 'Profile',
    blurb: 'Connector, enabled lanes, notifiers, and routines.',
  },
  {
    id: 'persona-filters',
    title: 'Persona & filters',
    blurb: 'The skills, seniority, and location rules that shape your matches.',
  },
  {
    id: 'search-urls',
    title: 'Search URLs',
    blurb: 'The LinkedIn saved searches this profile hunts against.',
  },
  {
    id: 'integrations',
    title: 'Integrations',
    blurb: 'Notion mirror and Telegram digest tokens.',
  },
  {
    id: 'schedule-daemon',
    title: 'Schedule & daemon',
    blurb: 'When this profile is scheduled to run, and whether the daemon is up.',
  },
  {
    id: 'pipeline-health',
    title: 'Pipeline health',
    blurb:
      'Everything else the doctor checks: Chrome, the Claude CLI, and the local database.',
  },
];

export function groupFindings(
  findings: DoctorFinding[],
): Record<HubCardId, DoctorFinding[]> {
  const grouped: Record<HubCardId, DoctorFinding[]> = {
    profile: [],
    'persona-filters': [],
    'search-urls': [],
    integrations: [],
    'schedule-daemon': [],
    'pipeline-health': [],
  };
  for (const f of findings) {
    const cardId = CHECK_TO_CARD[f.check] ?? 'pipeline-health';
    grouped[cardId].push(f);
  }
  return grouped;
}

export function cardStatus(findings: DoctorFinding[]): HubCardStatus {
  if (findings.length === 0) return 'unknown';
  if (findings.some((f) => f.status === 'red')) return 'red';
  if (findings.some((f) => f.status === 'warn')) return 'warn';
  return 'ok';
}

// Top billing (frozen): fires only when the daemon is NOT running, the
// schedule is enabled, and at least one time is set. `times[0]` is
// `string | undefined` under noUncheckedIndexedAccess — the explicit check
// is required, not an oversight.
export function scheduleWarning(input: {
  daemonState: DaemonState;
  scheduleEnabled: boolean;
  times: string[];
}): { firstTime: string } | null {
  if (input.daemonState === 'running') return null;
  if (!input.scheduleEnabled) return null;
  const firstTime = input.times[0];
  if (firstTime === undefined) return null;
  return { firstTime };
}
