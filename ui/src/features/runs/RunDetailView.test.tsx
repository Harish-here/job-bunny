import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  RunDetail,
  RunEventRow,
  RunSummary,
  SoftErrorSummary,
} from '../../lib/api/types';
import { RunDetailView } from './RunDetailView';

const STAGE_NAMES = [
  'reconcile',
  'farm',
  'source',
  'compress',
  'structure',
  'assemble',
  'filter',
  'dedup',
  'rank',
  'sync',
];

function stages(count: number, lastJobsOut: number) {
  return STAGE_NAMES.slice(0, count).map((name, i) => ({
    name,
    jobsIn: 10,
    jobsOut: i === count - 1 ? lastJobsOut : 10,
    dropsByRule: {},
    elapsedMs: 100,
    attempts: 1,
  }));
}

const BASE_SUMMARY: Omit<RunSummary, 'status'> = {
  id: 1,
  date: '2026-08-05',
  timeDir: '09-00',
  kind: 'run',
  resumedFrom: null,
  startedAt: '2026-08-05T09:00:00.000Z',
  finishedAt: '2026-08-05T09:05:00.000Z',
  heartbeatAt: '2026-08-05T09:05:00.000Z',
  progress: null,
};

function detail(overrides: {
  status: RunSummary['status'];
  result?: unknown;
  failure?: unknown;
}): RunDetail {
  return {
    ...BASE_SUMMARY,
    status: overrides.status,
    result: overrides.result ?? null,
    failure: overrides.failure ?? null,
    syncDryrun: null,
  };
}

const EMPTY_SOFT_ERRORS: SoftErrorSummary = { total: 0, groups: [] };

const EVENTS: RunEventRow[] = [
  { ts: '2026-08-05T09:00:01.000Z', level: 'info', msg: 'stage started' },
];

/** The five composed-panel testids RunDetailView owns, in the fixed order
 * a non-`'unrecorded'` render must produce (blueprint §6). */
const PANEL_TESTIDS = [
  'rundetail-outcome-header',
  'rundetail-diagnosis-panel',
  'rundetail-stage-rail',
  'rundetail-funnel-table',
  'rundetail-evidence-section',
];

function panelOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="rundetail-"]'))
    .map((el) => el.getAttribute('data-testid'))
    .filter((id): id is string => id !== null && PANEL_TESTIDS.includes(id));
}

describe('RunDetailView — panel composition (B20, AC12)', () => {
  it('failing: renders outcome, diagnosis, rail, funnel, evidence — in that DOM order', () => {
    const run = detail({
      status: 'failed',
      result: null,
      failure: { stage: 'structure', error: 'boom', elapsedMs: 500 },
    });
    const { container } = render(
      <RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />,
    );

    expect(panelOrder(container)).toEqual([
      'rundetail-outcome-header',
      'rundetail-diagnosis-panel',
      'rundetail-stage-rail',
      'rundetail-funnel-table',
      'rundetail-evidence-section',
    ]);
  });

  it('crashed: renders outcome, diagnosis, rail, funnel, evidence — in that DOM order', () => {
    const run = detail({
      status: 'crashed',
      result: null,
      failure: { stage: 'source', error: 'lost contact', elapsedMs: 1000 },
    });
    const { container } = render(
      <RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />,
    );

    expect(panelOrder(container)).toEqual([
      'rundetail-outcome-header',
      'rundetail-diagnosis-panel',
      'rundetail-stage-rail',
      'rundetail-funnel-table',
      'rundetail-evidence-section',
    ]);
  });

  it('produced: renders outcome, rail, funnel, evidence — NO diagnosis panel', () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 7) } });
    const { container } = render(
      <RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />,
    );

    expect(panelOrder(container)).toEqual([
      'rundetail-outcome-header',
      'rundetail-stage-rail',
      'rundetail-funnel-table',
      'rundetail-evidence-section',
    ]);
    expect(screen.queryByTestId('rundetail-diagnosis-panel')).not.toBeInTheDocument();
  });

  it('empty: renders outcome, diagnosis, rail, funnel, evidence — in that DOM order', () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
    const { container } = render(
      <RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />,
    );

    expect(panelOrder(container)).toEqual([
      'rundetail-outcome-header',
      'rundetail-diagnosis-panel',
      'rundetail-stage-rail',
      'rundetail-funnel-table',
      'rundetail-evidence-section',
    ]);
  });

  it('unrecorded: renders ONLY the dashed telemetry-missing card — no other panel node at all', () => {
    const run = detail({ status: 'crashed', result: null, failure: null });
    render(<RunDetailView run={run} events={EVENTS} softErrors={undefined} />);

    expect(screen.getByTestId('rundetail-unrecorded-card')).toBeInTheDocument();
    expect(screen.getByText('Telemetry missing')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();

    expect(screen.queryByTestId('rundetail-outcome-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rundetail-diagnosis-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rundetail-stage-rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rundetail-funnel-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rundetail-evidence-section')).not.toBeInTheDocument();
    // No rail/funnel/events node at all, not merely hidden.
    expect(screen.queryByTestId('stage-rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diagnosis-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('evidence-summary-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-events')).not.toBeInTheDocument();
  });
});

describe('RunDetailView — panel content sanity', () => {
  it('outcome header keeps the failed-stage banner content unchanged', () => {
    const run = detail({
      status: 'failed',
      result: null,
      failure: { stage: 'structure', error: 'boom', elapsedMs: 500 },
    });
    render(<RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />);

    expect(screen.getByText(/Failed at stage: structure/)).toBeInTheDocument();
  });

  it('evidence section falls back to an empty summary when softErrors is undefined', () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 7) } });
    render(<RunDetailView run={run} events={EVENTS} softErrors={undefined} />);

    expect(screen.getByText('No soft errors recorded for this run.')).toBeInTheDocument();
  });
});
