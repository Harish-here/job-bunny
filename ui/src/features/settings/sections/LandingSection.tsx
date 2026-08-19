/**
 * Landing screen's default `#/settings` view — "What decides your board"
 * (blueprint.md:610-638, step 9d's component half). Composes, in order: the
 * thin-run hero card (this file, via `thinRunSummary` from 9a's
 * `landing.model.ts`), `LandingCapsTable` (9b) and `LandingRulesSummary`
 * (9c) unchanged, and the machine-scope footer. Route wiring (the
 * `'landing'` `SectionBody` case, `#/settings` bare-route default) is task
 * 22's atomic switchover — this component is not mounted anywhere yet.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Card, CardContent } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { runQuery, runsQuery } from '../../runs/runs.queries';
import { ErrorRetry } from '../../shared/ErrorRetry';
import { LandingCapsTable } from './LandingCapsTable';
import { LandingRulesSummary } from './LandingRulesSummary';
import { thinRunSummary } from './landing.model';

/** The one visually distinct element on the whole screen (Von Restorff,
 * blueprint.md:611) — `text-2xl font-heading` on the hero number only;
 * everything else in this component stays at `text-sm`. */
function ThinRunSentence({
  onBoard,
  scraped,
  biggestDrop,
}: ReturnType<typeof thinRunSummary>) {
  return (
    <p className="text-sm">
      Your last run put <span className="text-2xl font-heading">{onBoard}</span> jobs on
      the board.
      {scraped !== null ? ` ${scraped} were scraped;` : ''}
      {biggestDrop ? (
        <>
          {' '}
          <code>{biggestDrop.stage}</code> dropped {biggestDrop.count} — biggest rule:{' '}
          <code>{biggestDrop.rule}</code>.
        </>
      ) : null}
    </p>
  );
}

export function LandingSection({ profile }: { profile: string }) {
  const runs = useQuery(runsQuery(profile));
  const runsData = runs.data;
  const rows = runsData?.rows ?? [];
  const latestRunId = rows[0]?.id ?? null;
  const detail = useQuery(runQuery(profile, latestRunId ?? -1));
  const detailData = detail.data;

  let thinRunBody: ReactNode;
  if (runs.isError) {
    thinRunBody = (
      <ErrorRetry message="Couldn't load your last run." onRetry={() => runs.refetch()} />
    );
  } else if (!runsData) {
    thinRunBody = <Skeleton data-qa="landing-thin-run-loading" className="h-8 w-full" />;
  } else if (rows.length === 0) {
    thinRunBody = (
      <p data-qa="landing-thin-run-empty" className="text-sm text-muted-foreground">
        No run recorded yet
      </p>
    );
  } else if (detail.isError) {
    thinRunBody = (
      <ErrorRetry
        message="Couldn't load your last run."
        onRetry={() => detail.refetch()}
      />
    );
  } else if (!detailData) {
    thinRunBody = <Skeleton data-qa="landing-thin-run-loading" className="h-8 w-full" />;
  } else {
    thinRunBody = <ThinRunSentence {...thinRunSummary(detailData.result)} />;
  }

  return (
    <div>
      <Card data-qa="landing-thin-run">
        <CardContent>{thinRunBody}</CardContent>
      </Card>

      <h3 className="mt-4 mb-2 text-sm font-medium">Limits in force</h3>
      <LandingCapsTable profile={profile} runId={latestRunId} />

      <h3 className="mt-4 mb-2 text-sm font-medium">Rules in force</h3>
      <LandingRulesSummary profile={profile} />

      <p data-qa="landing-scope-footer" className="mt-4 text-sm text-muted-foreground">
        Daemon, LinkedIn session and secrets are machine-wide — see{' '}
        <a href="#/setup" className="text-primary hover:underline">
          Operate →
        </a>
      </p>
    </div>
  );
}
