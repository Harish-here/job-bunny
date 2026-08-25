import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

export function ChipInput({
  values,
  onAdd,
  onRemove,
  ariaLabel,
  'data-qa': dataQa,
}: {
  values: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  ariaLabel: string;
  /** Optional passthrough onto the outer wrapper, for a caller (e.g.
   * WhereYouWorkSection's rule/acceptable/borderline timezone instances)
   * that needs a stable `data-qa` id on its own ChipInput instance. */
  'data-qa'?: string;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex flex-col gap-1.5" data-qa={dataQa}>
      <div className="flex flex-wrap gap-1.5" role="listbox" aria-label={ariaLabel}>
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
          aria-label={ariaLabel}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const trimmed = draft.trim();
            if (trimmed !== '' && !values.includes(trimmed)) onAdd(trimmed);
            setDraft('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
