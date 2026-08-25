import { Card } from '../../components/ui/card';

type EligibilityGridProps = { [k: string]: string | null };

/**
 * Zone 3 (`ux-notes.md` §5) — the eligibility grid always renders exactly
 * 4 cells; a missing value shows `—` in `text-muted-foreground` rather
 * than removing the cell, so the grid never reflows.
 */
export function EligibilityGrid({
  locationCity,
  workType,
  seniority,
  timezone,
}: EligibilityGridProps) {
  const cells: Array<{ label: string; value: string | null }> = [
    { label: 'LOCATION', value: locationCity ?? null },
    { label: 'WORK TYPE', value: workType ?? null },
    { label: 'SENIORITY', value: seniority ?? null },
    { label: 'TIMEZONE', value: timezone ?? null },
  ];

  return (
    <Card size="sm" data-qa="eligibility">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cells.map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-micro text-muted-foreground">{label}</span>
            <span
              className={
                value
                  ? 'text-sm font-medium'
                  : 'text-sm font-medium text-muted-foreground'
              }
            >
              {value || '—'}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
