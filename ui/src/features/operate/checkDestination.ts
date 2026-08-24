import type { Route } from '../../lib/router';
import type { DoctorFinding } from './operate.api';

export type CheckDestination =
  | { kind: 'settings-link'; route: Route }
  | { kind: 'cli-command'; command: string };

/**
 * Blueprint step 35: extends `hub.model.ts`'s (deleted by the router
 * switchover brief, still present in this tree today) `CHECK_TO_CARD`
 * check-name list one-for-one, now mapped to a DESTINATION the board can
 * act on instead of a card. Every route reuses the exact target
 * `HubPage.tsx`'s `cardAction()` already chose for that check's old card
 * (its `'ok'`-status "Edit in Settings"/"View runs" branch — the only one
 * expressible here, since `HubStepDialog`'s dialog affordance has no
 * equivalent in the two-kind `CheckDestination` union) — reusing an
 * already-shipped, already-reviewed routing decision rather than
 * inventing a new one per check:
 *   - profile (`profile-parses`, `sqlite-path-retired`, `wire`) and
 *     integrations (`env-tokens`, `notion-db-reachable`,
 *     `telegram-bot-token`) both pointed at `{section:'delivery'}`.
 *     `'notion-db-reachable'` is also the task's explicitly named case
 *     (R23): the token/mirror fields ARE board-settable there — only
 *     Notion adopt-or-create is Claude-dependent, and that is never
 *     offered as a control on this card.
 *   - persona-filters (`filter-parses`) -> `roles-companies`.
 *   - search-urls (`empty-lanes`, `linkedin-inventory-freshness`) ->
 *     `where-jobs-come-from`.
 *   - schedule-daemon's `daemon-liveness` is the one deliberate
 *     departure: its own finding `detail` already names the fix as a
 *     literal terminal command (`'jobbunny serve start'`, or the
 *     stop+start pair for a wedged/degraded daemon) — there is no
 *     Settings toggle that starts the daemon, so `cli-command` describes
 *     the real remedy better than a link to the schedule section would.
 *   - pipeline-health (`claude-cli-on-path`, `cdp-reachable`,
 *     `sqlite-db-openable`, `config-legacy-divergence`) kept its old
 *     `{name:'runs'}` "View runs" link — `route: Route` accepts any
 *     route, not only `{name:'settings', ...}`, so the `'settings-link'`
 *     kind still fits a plain board-page link.
 *
 * A resume-not-parsed row (the second Claude-dependent case the task
 * names, R23) is deliberately ABSENT from this map: verified against
 * `src/ops/doctor/aggregate.ts` (and every adapter-contributed check
 * wired in `cli/wire/compose.ts`) that no such doctor check exists today.
 * Per the task's explicit instruction, that is a BE bounce, not a check
 * name to invent here — `SetupHealthCard.tsx` renders nothing for it.
 */
export const CHECK_TO_DESTINATION: Record<string, CheckDestination> = {
  'profile-parses': {
    kind: 'settings-link',
    route: { name: 'settings', section: 'delivery' },
  },
  'sqlite-path-retired': {
    kind: 'settings-link',
    route: { name: 'settings', section: 'delivery' },
  },
  wire: { kind: 'settings-link', route: { name: 'settings', section: 'delivery' } },
  'filter-parses': {
    kind: 'settings-link',
    route: { name: 'settings', section: 'roles-companies' },
  },
  'empty-lanes': {
    kind: 'settings-link',
    route: { name: 'settings', section: 'where-jobs-come-from' },
  },
  'linkedin-inventory-freshness': {
    kind: 'settings-link',
    route: { name: 'settings', section: 'where-jobs-come-from' },
  },
  'env-tokens': {
    kind: 'settings-link',
    route: { name: 'settings', section: 'delivery' },
  },
  'notion-db-reachable': {
    kind: 'settings-link',
    route: { name: 'settings', section: 'delivery' },
  },
  'telegram-bot-token': {
    kind: 'settings-link',
    route: { name: 'settings', section: 'delivery' },
  },
  'daemon-liveness': { kind: 'cli-command', command: 'jobbunny serve start' },
  'claude-cli-on-path': { kind: 'settings-link', route: { name: 'runs' } },
  'cdp-reachable': { kind: 'settings-link', route: { name: 'runs' } },
  'sqlite-db-openable': { kind: 'settings-link', route: { name: 'runs' } },
  'config-legacy-divergence': { kind: 'settings-link', route: { name: 'runs' } },
};

export type HealthGroupId = 'needs-action' | 'not-configured' | 'ok';

/**
 * Replaces `hub.model.ts`'s deleted `cardStatus`. A finding's group is NOT
 * simply its `DoctorStatus` (`ok`/`warn`/`red`) — the mockup's own S7
 * demo (`mockup.html`'s "Needs action (2)" / "Not configured (1)" rows,
 * both amber/`warn`) groups two `warn` findings differently by what their
 * destination actually offers: a `settings-link` finding is something you
 * can act on right now from this board ("Needs action"), while a
 * `cli-command` finding hands off to a terminal step the board cannot
 * perform ("Not configured" — nothing here has been set up yet). An `ok`
 * finding always lands in `ok` regardless of its destination kind. A
 * finding whose check has no `CHECK_TO_DESTINATION` entry at all falls
 * back to `needs-action` rather than being silently dropped.
 */
export function groupHealthFindings(
  findings: DoctorFinding[],
): Record<HealthGroupId, DoctorFinding[]> {
  const grouped: Record<HealthGroupId, DoctorFinding[]> = {
    'needs-action': [],
    'not-configured': [],
    ok: [],
  };
  for (const finding of findings) {
    if (finding.status === 'ok') {
      grouped.ok.push(finding);
      continue;
    }
    const destination = CHECK_TO_DESTINATION[finding.check];
    if (destination?.kind === 'cli-command') {
      grouped['not-configured'].push(finding);
    } else {
      grouped['needs-action'].push(finding);
    }
  }
  return grouped;
}
