import { render, screen, within } from '@testing-library/react';
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

const EMPTY_SOFT_ERRORS: SoftErrorSummary = { total: 0, groups: [], breakerOpen: false };

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

// Fix-round finding #2: two REAL degraded shapes — a 10-stage zero-yield
// run with soft errors over threshold, and a 9-stage zero-yield run (the
// exact fixture RunsList.test.tsx uses) — both used to classify as
// `'degraded'` (classifyOutcome) yet have NO registry entry able to match
// (every entry read `errorText(run)`, which is `''` for a `status:
// 'passed'` run), so both fell through to the generic fallback verdict and
// rendered "Failed at `unknown stage`" with a destructive-red tint on a run
// whose recorded status is `'passed'`.
describe("RunDetailView — 'degraded' never reads as a whole-run failure (fix-round finding #2)", () => {
  it('a 9-stage zero-yield passed run (missing-stage-count degraded) renders the diagnosis panel with amber tint, never destructive, and never "Failed at"', () => {
    const run = detail({ status: 'passed', result: { stages: stages(9, 0) } });
    const { container } = render(
      <RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />,
    );

    expect(screen.queryByText(/^Failed at/)).not.toBeInTheDocument();
    const iconWrapper = container.querySelector('.rounded-full');
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper?.className).toContain('bg-amber');
    expect(iconWrapper?.className).not.toContain('bg-destructive');
    expect(screen.getByTestId('diagnosis-line-1')).toHaveTextContent(
      /ran with warnings/i,
    );
  });

  it('a 10-stage zero-yield passed run with soft errors over threshold (soft-error-rate degraded) renders the same amber, non-destructive treatment', () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
    const softErrors: SoftErrorSummary = { total: 12, groups: [], breakerOpen: false };
    const { container } = render(
      <RunDetailView run={run} events={EVENTS} softErrors={softErrors} />,
    );

    expect(screen.queryByText(/^Failed at/)).not.toBeInTheDocument();
    const iconWrapper = container.querySelector('.rounded-full');
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper?.className).toContain('bg-amber');
    expect(iconWrapper?.className).not.toContain('bg-destructive');
    expect(screen.getByTestId('diagnosis-line-1')).toHaveTextContent(
      /ran with warnings/i,
    );
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

describe('RunDetailView — outcome-driven header (blueprint §6)', () => {
  it('produced: headline is the yield number and "New jobs on your board", not the timestamp', () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 7) } });
    render(<RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />);

    const header = within(screen.getByTestId('rundetail-outcome-header'));
    expect(header.getByText('7')).toBeInTheDocument();
    expect(header.getByText('New jobs on your board')).toBeInTheDocument();
  });

  it('empty: headline reads "Ran clean" at the zero-yield number slot', () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
    render(<RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />);

    const header = within(screen.getByTestId('rundetail-outcome-header'));
    expect(header.getByText('0')).toBeInTheDocument();
    expect(header.getByText('Ran clean')).toBeInTheDocument();
  });

  it('degraded: headline reads "Ran with warnings"', () => {
    const run = detail({ status: 'passed', result: { stages: stages(9, 0) } });
    render(<RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />);

    const header = within(screen.getByTestId('rundetail-outcome-header'));
    expect(header.getByText('Ran with warnings')).toBeInTheDocument();
  });

  it('failed: the timestamp moves out of the headline into the meta cluster, and the status chip stays present', () => {
    const run = detail({
      status: 'failed',
      result: null,
      failure: { stage: 'structure', error: 'boom', elapsedMs: 500 },
    });
    render(<RunDetailView run={run} events={EVENTS} softErrors={EMPTY_SOFT_ERRORS} />);

    const header = within(screen.getByTestId('rundetail-outcome-header'));
    expect(header.getByText(/Failed at stage: structure/)).toBeInTheDocument();
    expect(header.getByText('Failed')).toBeInTheDocument();
  });
});
