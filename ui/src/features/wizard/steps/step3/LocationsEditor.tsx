import { Button } from '../../../../components/ui/button';
import {
  Field,
  FieldControl,
  FieldError,
  FieldLabel,
} from '../../../../components/ui/form';
import { Input } from '../../../../components/ui/input';
import type { WizardLocation } from '../../wizard.types';

/** Home location (required, validated) plus any number of additional
 * locations. Lifted state — the caller owns `locations`, this component
 * only derives the home/additional split and reports whole-array patches
 * back through `onChange`. */
export function LocationsEditor({
  locations,
  onChange,
  homeCityError,
}: {
  locations: WizardLocation[];
  onChange: (locations: WizardLocation[]) => void;
  homeCityError?: string;
}) {
  const homeLocation: WizardLocation = locations[0] ?? { city: '', country: '' };
  const additionalLocations = locations.slice(1);

  function updateHome(patch: Partial<WizardLocation>) {
    const home = { ...homeLocation, ...patch };
    onChange([home, ...locations.slice(1)]);
  }

  function updateAdditional(index: number, patch: Partial<WizardLocation>) {
    const next = locations.map((loc, i) => (i === index ? { ...loc, ...patch } : loc));
    onChange(next);
  }

  function addLocation() {
    const base = locations.length > 0 ? locations : [homeLocation];
    onChange([...base, { city: '', country: '' }]);
  }

  function removeLocationAt(index: number) {
    onChange(locations.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <Field invalid={Boolean(homeCityError)} className="flex-1">
          <FieldLabel>Home city</FieldLabel>
          <FieldControl>
            <Input
              value={homeLocation.city}
              onChange={(e) => updateHome({ city: e.target.value })}
            />
          </FieldControl>
          <FieldError>{homeCityError}</FieldError>
        </Field>
        <Field className="flex-1">
          <FieldLabel>Country</FieldLabel>
          <FieldControl>
            <Input
              value={homeLocation.country}
              onChange={(e) => updateHome({ country: e.target.value })}
            />
          </FieldControl>
        </Field>
      </div>

      {additionalLocations.map((loc, i) => {
        const index = i + 1;
        return (
          <div key={index} className="flex items-end gap-3">
            <Field className="flex-1">
              <FieldLabel>{`Additional city ${index}`}</FieldLabel>
              <FieldControl>
                <Input
                  value={loc.city}
                  onChange={(e) => updateAdditional(index, { city: e.target.value })}
                />
              </FieldControl>
            </Field>
            <Field className="flex-1">
              <FieldLabel>{`Additional country ${index}`}</FieldLabel>
              <FieldControl>
                <Input
                  value={loc.country}
                  onChange={(e) => updateAdditional(index, { country: e.target.value })}
                />
              </FieldControl>
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeLocationAt(index)}
            >
              Remove
            </Button>
          </div>
        );
      })}

      <Button type="button" variant="outline" size="sm" onClick={addLocation}>
        Add another location
      </Button>
    </div>
  );
}
