/**
 * Landing screen's 3-row rules-in-force table (blueprint.md:602-609, step
 * 9c). Reads `filter.json`/`profile.json` via the existing `configDocQuery`
 * and reshapes them through `rulesInForce` (Part A of this same brief) — no
 * new field, no new endpoint. A plain `<table>` following `FunnelTable.tsx`'s
 * idiom, same as `LandingCapsTable.tsx` — this repo deliberately does not
 * vendor a generic `Table` primitive.
 */
import { useQuery } from '@tanstack/react-query';
import { navigate, type SettingsSection } from '../../../lib/router';
import { configDocQuery } from '../config.queries';
import { type RuleGroup, type RuleRow, rulesInForce } from './landing.model';

function parseJsonDoc(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed != null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const GROUP_LABEL: Record<RuleGroup, string> = {
  'roles-companies': 'Roles & companies',
  'where-you-work': "Where you'll work",
  skills: 'Skills',
};

// The owning Settings section each row's [Open →] navigates to. These three
// slugs (plus `fetching`, used by LandingCapsTable) join `SettingsSection`'s
// union only once the router/shell/nav switchover (task 22) lands — until
// then the literal isn't a member of the union, so the cast is required; it
// resolves to the real union member once that brief lands.
const GROUP_SECTION: Record<RuleGroup, SettingsSection> = {
  'roles-companies': 'roles-companies' as never,
  'where-you-work': 'where-you-work' as never,
  skills: 'skills' as never,
};

function ruleRowText(row: RuleRow): string {
  return `${row.activeCount} active rules, ${row.hardCount} of them hard`;
}

export function LandingRulesSummary({ profile }: { profile: string }) {
  const filterQuery = useQuery(configDocQuery(profile, 'filter.json'));
  const profileQuery = useQuery(configDocQuery(profile, 'profile.json'));

  const filterDoc = filterQuery.data ? parseJsonDoc(filterQuery.data.text) : {};
  const profileDoc = profileQuery.data ? parseJsonDoc(profileQuery.data.text) : {};
  const rows = rulesInForce(filterDoc, profileDoc);

  return (
    <table data-qa="landing-rules-summary" className="w-full text-sm">
      <tbody>
        {rows.map((row) => (
          <tr key={row.group} className="border-b last:border-b-0">
            <td className="py-1.5 pr-2 font-medium">{GROUP_LABEL[row.group]}</td>
            <td className="py-1.5 pr-2 text-muted-foreground">{ruleRowText(row)}</td>
            <td className="py-1.5">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() =>
                  navigate({ name: 'settings', section: GROUP_SECTION[row.group] })
                }
              >
                Open →
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
