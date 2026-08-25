/**
 * Landing screen's 4-row caps table (blueprint.md:586-601, step 9b). Reads
 * the four cap values off `profile.json`'s `settings` block via the
 * existing `configDocQuery`, and the `capsHit` signal off the extended
 * `GET /api/profiles/:name/runs/:id/soft-errors` response. `runId` is
 * `null` before a latest run is known (e.g. a profile with no runs yet) —
 * the soft-errors fetch is simply skipped and every hit-capable row falls
 * back to `capsInForce`'s own `hit: null` treatment (never a false "not
 * hit"). A plain `<table>` following `FunnelTable.tsx`'s idiom — this repo
 * deliberately does not vendor a generic `Table` primitive.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge } from '../../../components/ui/badge';
import { navigate } from '../../../lib/router';
import { softErrorsQuery } from '../../runs/runs.queries';
import { configDocQuery } from '../config.queries';
import { type CapRow, capsInForce, type ProfileCapSettings } from './landing.model';

const DEFAULTS: ProfileCapSettings = {
  maxNewPerLane: 40,
  maxProbesPerRun: 25,
  maxCardsPerUrl: 40,
  maxAgeDays: 30,
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

// Mirrors the backend's own resolver posture (`src/cli/wire/settings.ts`):
// anything other than a positive finite number falls back to the shipped
// default rather than showing a wrong/blank number for an unset field.
function parseCapSettings(text: string): ProfileCapSettings {
  const trimmed = text.trim();
  if (trimmed === '') return DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return DEFAULTS;
  }
  if (parsed == null || typeof parsed !== 'object') return DEFAULTS;
  const settings = (parsed as Record<string, unknown>).settings;
  const source =
    settings != null && typeof settings === 'object'
      ? (settings as Record<string, unknown>).source
      : undefined;
  const linkedin =
    settings != null && typeof settings === 'object'
      ? (settings as Record<string, unknown>).linkedin
      : undefined;
  const sourceObj =
    source != null && typeof source === 'object'
      ? (source as Record<string, unknown>)
      : {};
  const linkedinObj =
    linkedin != null && typeof linkedin === 'object'
      ? (linkedin as Record<string, unknown>)
      : {};
  return {
    maxNewPerLane: positiveNumber(sourceObj.maxNewPerLane, DEFAULTS.maxNewPerLane),
    maxProbesPerRun: positiveNumber(sourceObj.maxProbesPerRun, DEFAULTS.maxProbesPerRun),
    maxCardsPerUrl: positiveNumber(linkedinObj.maxCardsPerUrl, DEFAULTS.maxCardsPerUrl),
    maxAgeDays: positiveNumber(linkedinObj.maxAgeDays, DEFAULTS.maxAgeDays),
  };
}

const ROW_DATA_QA: Record<CapRow['name'], string> = {
  maxNewPerLane: 'landing-cap-row-max-new-per-lane',
  maxProbesPerRun: 'landing-cap-row-max-probes-per-run',
  maxCardsPerUrl: 'landing-cap-row-max-cards-per-url',
  maxAgeDays: 'landing-cap-row-max-age-days',
};

// maxAgeDays gates LinkedIn page-inventory freshness — never a yield
// limit (F10, pre-closed ruling). This copy must never say "caps jobs".
const ROW_COPY: Record<CapRow['name'], string> = {
  maxNewPerLane: 'Caps new jobs admitted per lane, per run.',
  maxProbesPerRun: 'Caps ATS probe calls per run.',
  maxCardsPerUrl: 'Caps LinkedIn cards opened per saved-search URL.',
  maxAgeDays: 'Gates LinkedIn page-inventory freshness.',
};

function HitCell({ hit }: { hit: boolean | null }) {
  if (hit === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (hit === true) {
    // Mirrors the existing `Badge` `on-primary` usage precedent
    // (RunsList.tsx, RunDetailView.tsx): `bg-accent text-primary` — the
    // mockup fragment's own `.badge.on-primary` class.
    return (
      <Badge variant="outline" className="border-transparent bg-accent text-primary">
        Hit
      </Badge>
    );
  }
  return <span className="text-muted-foreground">Not hit</span>;
}

export function LandingCapsTable({
  profile,
  runId,
}: {
  profile: string;
  runId: number | null;
}) {
  const settingsQuery = useQuery(configDocQuery(profile, 'profile.json'));
  // `softErrorsQuery` itself sets `enabled: id > 0` — passing `-1` when
  // `runId` is null therefore leaves the fetch disabled automatically, no
  // separate no-run branch needed.
  const softErrors = useQuery(softErrorsQuery(profile, runId ?? -1));

  const profileSettings = settingsQuery.data
    ? parseCapSettings(settingsQuery.data.text)
    : DEFAULTS;
  const rows = capsInForce(profileSettings, softErrors.data?.capsHit);

  return (
    <table data-qa="landing-caps-table" className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-2 font-medium">Cap</th>
          <th className="py-1.5 pr-2 font-medium">Value</th>
          <th className="py-1.5 pr-2 font-medium">Binding?</th>
          <th className="py-1.5 font-medium" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.name}
            data-qa={ROW_DATA_QA[row.name]}
            className="border-b last:border-b-0"
          >
            <td className="py-1.5 pr-2 font-medium" title={ROW_COPY[row.name]}>
              {row.name}
            </td>
            <td className="py-1.5 pr-2 font-mono">{row.value}</td>
            <td className="py-1.5 pr-2">
              <HitCell hit={row.hit} />
            </td>
            <td className="py-1.5">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() =>
                  navigate({ name: 'settings', section: 'fetching' as never })
                }
              >
                Change →
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
