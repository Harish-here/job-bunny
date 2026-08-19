/**
 * "Where you'll work" screen's Rules card (blueprint.md:683-706, step 11's
 * `geo-rules-card` half) — sibling file per the file-size contingency
 * named in the brief. Owns filter.json's `locations[]` (via FiltersSection's
 * own unchanged `LocationRow`, reused not duplicated) and `timezones`
 * (`data-qa="geo-timezones-rule"` `ChipInput` + severity select).
 *
 * **Empty state (ux-notes §12:490):** when locations AND the timezone rule
 * are both empty, a blank list would read ambiguously as either "no rule at
 * all" or "a permissive rule with nothing typed in yet" — those mean
 * opposite things on a config surface, so the card renders explicit copy
 * instead, with an inline `[Add]` seeding one empty `LocationRow`.
 */
import { Button } from '../../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { ChipInput } from '../ChipInput';
import { LocationRow } from './FiltersSection';
import type { FilterLocation } from './filters.model';
import type { FilterTimezones, TimezoneSeverity } from './whereYouWork.model';

export function WhereYouWorkRulesCard({
  locations,
  onLocationsChange,
  timezonesRule,
  onTimezonesRuleChange,
  errors,
}: {
  locations: FilterLocation[];
  onLocationsChange: (next: FilterLocation[]) => void;
  timezonesRule: FilterTimezones | undefined;
  onTimezonesRuleChange: (next: FilterTimezones | undefined) => void;
  errors: Record<string, string>;
}) {
  const tzAccept = timezonesRule?.accept ?? [];
  const tzSeverity: TimezoneSeverity = timezonesRule?.severity ?? 'hard';
  const isEmpty = locations.length === 0 && tzAccept.length === 0;

  function updateLocation(index: number, next: FilterLocation) {
    onLocationsChange(locations.map((l, i) => (i === index ? next : l)));
  }
  function removeLocation(index: number) {
    onLocationsChange(locations.filter((_, i) => i !== index));
  }
  function addLocation() {
    onLocationsChange([...locations, { city: '', country: '', workTypes: [] }]);
  }
  function addTimezone(value: string) {
    onTimezonesRuleChange({ accept: [...tzAccept, value], severity: tzSeverity });
  }
  function removeTimezone(value: string) {
    onTimezonesRuleChange({
      accept: tzAccept.filter((v) => v !== value),
      severity: tzSeverity,
    });
  }
  function changeSeverity(severity: TimezoneSeverity) {
    onTimezonesRuleChange({ accept: tzAccept, severity });
  }

  return (
    <Card data-qa="geo-rules-card">
      <CardHeader>
        <CardTitle>Rules — a job that fails these is dropped</CardTitle>
        <CardDescription>
          Applied during <code>filter</code>. A dropped job never reaches your board.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isEmpty ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
            <span className="text-sm text-muted-foreground">
              No rules — nothing is dropped for this reason
            </span>
            <Button type="button" variant="outline" size="sm" onClick={addLocation}>
              Add
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-sm leading-none font-medium">Cities / countries</span>
              {locations.map((location, i) => (
                <LocationRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: FilterLocation carries no stable id in the model
                  key={i}
                  location={location}
                  onChange={(next) => updateLocation(i, next)}
                  onRemove={() => removeLocation(i)}
                  cityError={errors[`where-you-work-locations.${i}.city`]}
                  workTypesError={errors[`where-you-work-locations.${i}.workTypes`]}
                />
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addLocation}>
                Add location
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm leading-none font-medium">Timezones</span>
              <ChipInput
                ariaLabel="Allowed timezones rule"
                data-qa="geo-timezones-rule"
                values={tzAccept}
                onAdd={addTimezone}
                onRemove={removeTimezone}
              />
            </div>
          </>
        )}
        <label className="flex items-center gap-1.5 text-sm">
          Severity
          <select
            aria-label="Timezone rule severity"
            value={tzSeverity}
            onChange={(e) => changeSeverity(e.target.value as TimezoneSeverity)}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="hard">Hard — drops the job</option>
            <option value="soft">Soft — flags only</option>
          </select>
        </label>
      </CardContent>
    </Card>
  );
}
