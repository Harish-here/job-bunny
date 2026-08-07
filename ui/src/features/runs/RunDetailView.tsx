import { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import type { RunDetail, RunEventRow } from '../../lib/api/types';
import { formatDuration, formatWhen, statusLabel, statusVariant } from './runFormat';
import { getFailedStage, getFailureError, getFunnelStages } from './runResult';

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
type LevelFilter = (typeof LEVELS)[number];

function FunnelTable({ run }: { run: RunDetail }) {
  const stages = getFunnelStages(run.result);
  if (stages === null) {
    return <p className="text-sm text-muted-foreground">No funnel recorded.</p>;
  }
  if (stages.length === 0) {
    return <p className="text-sm text-muted-foreground">No stages ran.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-1 pr-2 font-medium">Stage</th>
          <th className="py-1 pr-2 font-medium">Jobs</th>
          <th className="py-1 font-medium">Drops by rule</th>
        </tr>
      </thead>
      <tbody>
        {stages.map((stage) => (
          <tr key={stage.name} className="border-b last:border-b-0">
            <td className="py-1.5 pr-2 font-medium">{stage.name}</td>
            <td className="py-1.5 pr-2 whitespace-nowrap font-heading text-muted-foreground">
              {stage.jobsIn} → {stage.jobsOut}
            </td>
            <td className="py-1.5">
              {Object.keys(stage.dropsByRule).length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(stage.dropsByRule).map(([rule, count]) => (
                    <Badge key={rule} variant="outline">
                      {rule}: {count}
                    </Badge>
                  ))}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EventsList({ events }: { events: RunEventRow[] }) {
  const [level, setLevel] = useState<LevelFilter>('all');
  const filtered = useMemo(
    () => (level === 'all' ? events : events.filter((e) => e.level === level)),
    [events, level],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Events</span>
        <Select value={level} onValueChange={(v) => setLevel(v as LevelFilter)}>
          <SelectTrigger size="sm" aria-label="Filter by level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {l === 'all' ? 'All levels' : l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events match.</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="run-events">
          {filtered.map((event) => (
            <div
              key={`${event.ts}-${event.level}-${event.msg}`}
              data-testid="run-event-row"
              data-level={event.level}
              className="flex items-start gap-2 border-b py-1 text-sm last:border-b-0"
            >
              <span className="w-40 shrink-0 font-mono text-xs text-muted-foreground">
                {event.ts}
              </span>
              <Badge variant="outline" className="shrink-0 uppercase">
                {event.level}
              </Badge>
              <span className="flex-1">{event.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RunDetailView({
  run,
  events,
}: {
  run: RunDetail;
  events: RunEventRow[];
}) {
  const failedStage = getFailedStage(run.failure);
  const failureError = getFailureError(run.failure);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold font-heading">{formatWhen(run)}</h2>
          <Badge
            variant={statusVariant(run.status)}
            className={
              run.status === 'passed'
                ? 'text-success'
                : run.status === 'running'
                  ? 'text-primary'
                  : undefined
            }
          >
            {statusLabel(run.status)}
          </Badge>
        </div>
        <div className="text-sm text-muted-foreground">
          <span className="capitalize">{run.kind}</span>
          {' · '}
          {formatDuration(run.startedAt, run.finishedAt)}
          {run.resumedFrom != null && ` · resumed from run #${run.resumedFrom}`}
        </div>
        {failedStage != null && (
          <div className="text-sm text-destructive">
            Failed at stage: {failedStage}
            {failureError != null && ` — ${failureError}`}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-sm font-medium">Funnel</div>
        <FunnelTable run={run} />
      </div>

      <EventsList events={events} />
    </div>
  );
}
