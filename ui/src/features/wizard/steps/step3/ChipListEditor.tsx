import { useState } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';

/** A removable-chip list with a free-text add row. Composed from Badge +
 * Input + Button — no new `components/ui` primitive is added. */
export function ChipListEditor({
  legend,
  values,
  onAdd,
  onRemove,
}: {
  legend: string;
  values: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm leading-none font-medium">{legend}</span>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Badge key={value} variant="secondary">
            <span>{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onRemove(value)}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          aria-label={`Add to ${legend}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onAdd(draft);
            setDraft('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
