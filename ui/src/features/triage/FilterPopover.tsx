import { Filter } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import type { ListQuery } from '../../lib/api/types';

const ANY = '__any__';

/**
 * The remaining filters after the header's always-mounted company search
 * (status, excitement, dateFrom/dateTo, archived) — ports old FilterBar
 * semantics: an empty selection patches the field back to `undefined`.
 */
export function FilterPopover({
  query,
  statusOptions,
  excitementOptions,
  onChange,
}: {
  query: ListQuery;
  statusOptions: string[];
  excitementOptions: string[];
  onChange: (patch: Partial<ListQuery>) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label="Filters">
          <Filter />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Status</span>
            <Select
              value={query.status ?? ANY}
              onValueChange={(v) =>
                onChange({ status: v === ANY ? undefined : (v as ListQuery['status']) })
              }
            >
              <SelectTrigger className="w-full" aria-label="Status">
                <SelectValue placeholder="Any status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {statusOptions.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Excitement</span>
            <Select
              value={query.excitement ?? ANY}
              onValueChange={(v) =>
                onChange({
                  excitement: v === ANY ? undefined : (v as ListQuery['excitement']),
                })
              }
            >
              <SelectTrigger className="w-full" aria-label="Excitement">
                <SelectValue placeholder="Any excitement" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any excitement</SelectItem>
                {excitementOptions.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
              From
              <input
                type="date"
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={query.dateFrom ?? ''}
                onChange={(e) => onChange({ dateFrom: e.target.value || undefined })}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
              To
              <input
                type="date"
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={query.dateTo ?? ''}
                onChange={(e) => onChange({ dateTo: e.target.value || undefined })}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={query.archived === 'true'}
              onChange={(e) =>
                onChange({ archived: e.target.checked ? 'true' : 'false' })
              }
            />
            Show archived
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
