/**
 * "Where jobs come from"'s Lanes card — `profile.json`'s `lanes` field,
 * lifted out of `WhereJobsComeFromSection.tsx` purely to keep that
 * orchestrator under its file-size cap (no behaviour change). Dumb, fully
 * controlled, same shape as `SearchUrlsCard`/`WhereYouWorkPrefsCard`.
 */
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { laneLabel } from '../../../lib/vocabulary';

// Lifted UNCHANGED from the old (now-deleted) per-profile section's lane list.
export const LANES = ['linkedin', 'greenhouse', 'keka'] as const;

interface LanesCardProps {
  lanes: string[];
  onToggle: (lane: string) => void;
}

export function LanesCard({ lanes, onToggle }: LanesCardProps) {
  return (
    <Card data-qa="where-jobs-lanes-card">
      <CardHeader>
        <CardTitle>Lanes</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        {LANES.map((lane) => (
          <label key={lane} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={lanes.includes(lane)}
              onChange={() => onToggle(lane)}
            />
            {laneLabel(lane)}
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
