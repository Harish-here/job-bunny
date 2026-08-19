/**
 * "Where you'll work" screen's Preferences card (blueprint.md:683-706,
 * step 11's `geo-prefs-card` half) — sibling file per the file-size
 * contingency named in the brief. Owns profile.json's
 * `settings.rank.location.{homeCities,acceptableTimezones,
 * borderlineTimezones}` and `settings.rank.workTypePreference` (via
 * whereYouWork.model.ts's `WorkTypePreferenceOption`). R8's point-weight
 * boundary is stated inline (footer link to Raw config) rather than left
 * silent.
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { ChipInput } from '../ChipInput';
import type { WorkTypePreferenceOption } from './whereYouWork.model';

export function WhereYouWorkPrefsCard({
  homeCities,
  onHomeCitiesChange,
  acceptableTimezones,
  onAcceptableTimezonesChange,
  borderlineTimezones,
  onBorderlineTimezonesChange,
  workTypePreference,
  onWorkTypePreferenceChange,
}: {
  homeCities: string[];
  onHomeCitiesChange: (next: string[]) => void;
  acceptableTimezones: string[];
  onAcceptableTimezonesChange: (next: string[]) => void;
  borderlineTimezones: string[];
  onBorderlineTimezonesChange: (next: string[]) => void;
  workTypePreference: WorkTypePreferenceOption;
  onWorkTypePreferenceChange: (next: WorkTypePreferenceOption) => void;
}) {
  return (
    <Card data-qa="geo-prefs-card">
      <CardHeader>
        <CardTitle>Preferences — these change the order, never drop anything</CardTitle>
        <CardDescription>
          Applied during <code>rank</code>. Nothing here can remove a job.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm leading-none font-medium">Home cities</span>
          <ChipInput
            ariaLabel="Home cities preference"
            values={homeCities}
            onAdd={(v) => onHomeCitiesChange([...homeCities, v])}
            onRemove={(v) => onHomeCitiesChange(homeCities.filter((c) => c !== v))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm leading-none font-medium">Acceptable timezones</span>
          <ChipInput
            ariaLabel="Acceptable timezones preference"
            data-qa="geo-timezones-acceptable"
            values={acceptableTimezones}
            onAdd={(v) => onAcceptableTimezonesChange([...acceptableTimezones, v])}
            onRemove={(v) =>
              onAcceptableTimezonesChange(acceptableTimezones.filter((t) => t !== v))
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm leading-none font-medium">Borderline timezones</span>
          <ChipInput
            ariaLabel="Borderline timezones preference"
            data-qa="geo-timezones-borderline"
            values={borderlineTimezones}
            onAdd={(v) => onBorderlineTimezonesChange([...borderlineTimezones, v])}
            onRemove={(v) =>
              onBorderlineTimezonesChange(borderlineTimezones.filter((t) => t !== v))
            }
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm">
          Work-type preference
          <select
            aria-label="Work-type preference"
            value={workTypePreference}
            onChange={(e) =>
              onWorkTypePreferenceChange(e.target.value as WorkTypePreferenceOption)
            }
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="remote-first">Remote first</option>
            <option value="no-preference">No preference</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          Point weights for these live in{' '}
          <a href="#/settings/raw-config" className="text-primary hover:underline">
            Raw config →
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
