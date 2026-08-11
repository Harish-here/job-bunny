import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { computeRetention, type FunnelStage } from '../runResult';
import { FunnelTable } from './FunnelTable';

function stage(over: Partial<FunnelStage> & { name: string }): FunnelStage {
  return {
    jobsIn: 0,
    jobsOut: 0,
    dropsByRule: {},
    elapsedMs: 100,
    attempts: 1,
    ...over,
  };
}

describe('FunnelTable — ordinary case', () => {
  it('renders "in → out" text and a proportional retention bar', () => {
    const stages: FunnelStage[] = [
      stage({
        name: 'structure',
        jobsIn: 214,
        jobsOut: 25,
        dropsByRule: { schema: 189 },
      }),
    ];
    render(<FunnelTable stages={stages} failedStage={null} />);

    expect(screen.getByText('214 → 25')).toBeInTheDocument();
    const bar = screen.getByTestId('retention-bar');
    expect(bar).toHaveAttribute('data-bar-direction', 'inward');
    // 25 / 214 * 100 ≈ 11.6822...%
    const width = bar.style.width;
    expect(width).toBe(`${(25 / 214) * 100}%`);
  });
});

describe('FunnelTable — farm special case', () => {
  const stages: FunnelStage[] = [
    stage({ name: 'farm', jobsIn: 0, jobsOut: 12, dropsByRule: {} }),
  ];

  it('renders — (never a literal "0") in the in-cell', () => {
    render(<FunnelTable stages={stages} failedStage={null} />);
    const row = screen.getByText('farm').closest('tr') as HTMLElement;
    expect(row.textContent).toContain('—');
  });

  it('renders an info marker with the exact accessible popover copy', () => {
    render(<FunnelTable stages={stages} failedStage={null} />);
    const marker = screen.getByTestId('funnel-farm-info');
    const accessibleText =
      marker.getAttribute('aria-label') ?? marker.getAttribute('title');
    expect(accessibleText).toBe(
      'farm is additive — it discovers companies and adds jobs, so there is no input to measure.',
    );
  });

  it('renders an OUTWARD left-anchored bar, distinguishable from the ordinary inward bar', () => {
    render(<FunnelTable stages={stages} failedStage={null} />);
    const bar = screen.getByTestId('retention-bar');
    expect(bar).toHaveAttribute('data-bar-direction', 'outward');
  });

  it('never renders the literal string "0" anywhere in the farm row', () => {
    render(<FunnelTable stages={stages} failedStage={null} />);
    const row = screen.getByText('farm').closest('tr') as HTMLElement;
    expect(row.textContent).not.toMatch(/(?<![0-9])0(?![0-9])/);
  });
});

describe('FunnelTable — reconcile special case', () => {
  it('renders the exact text "n/a · state-sync only" with no retention bar', () => {
    const stages: FunnelStage[] = [
      stage({ name: 'reconcile', jobsIn: 0, jobsOut: 0, dropsByRule: {} }),
    ];
    render(<FunnelTable stages={stages} failedStage={null} />);

    expect(screen.getByText('n/a · state-sync only')).toBeInTheDocument();
    expect(screen.queryByTestId('retention-bar')).not.toBeInTheDocument();
  });
});

describe('FunnelTable — not reached rows', () => {
  it('synthesizes "not reached" rows for STAGE_ORDER entries absent from stages', () => {
    // A run that failed at `structure` — only the first four stages ran.
    const stages: FunnelStage[] = [
      stage({ name: 'reconcile', jobsIn: 0, jobsOut: 0 }),
      stage({ name: 'farm', jobsIn: 0, jobsOut: 3 }),
      stage({ name: 'source', jobsIn: 3, jobsOut: 3 }),
      stage({ name: 'compress', jobsIn: 3, jobsOut: 3 }),
    ];
    render(<FunnelTable stages={stages} failedStage="structure" />);

    // structure, assemble, filter, dedup, rank, sync never ran.
    for (const name of ['structure', 'assemble', 'filter', 'dedup', 'rank', 'sync']) {
      const row = screen.getByText(name).closest('tr') as HTMLElement;
      expect(row.textContent).toContain('not reached');
    }
    // A row that DID run must not say "not reached".
    const ranRow = screen.getByText('compress').closest('tr') as HTMLElement;
    expect(ranRow.textContent).not.toContain('not reached');
  });
});

describe('FunnelTable — retention summary', () => {
  it('renders a summary line using computeRetention, excluding farm/reconcile', () => {
    const stages: FunnelStage[] = [
      stage({ name: 'reconcile', jobsIn: 0, jobsOut: 0 }),
      stage({ name: 'farm', jobsIn: 0, jobsOut: 50 }),
      stage({ name: 'source', jobsIn: 50, jobsOut: 50 }),
      stage({ name: 'filter', jobsIn: 50, jobsOut: 20 }),
      stage({ name: 'rank', jobsIn: 20, jobsOut: 20 }),
    ];
    render(<FunnelTable stages={stages} failedStage={null} />);

    const expected = computeRetention(stages);
    const summary = screen.getByTestId('funnel-retention-summary');
    expect(summary.textContent).toContain(String(expected.startCount));
    expect(summary.textContent).toContain(String(expected.endCount));
    expect(summary.textContent).toContain(`${Math.round(expected.retainedPct)}%`);
  });
});

describe('FunnelTable — no funnel recorded', () => {
  it('renders a fallback message when stages is null', () => {
    render(<FunnelTable stages={null} failedStage={null} />);
    expect(screen.getByText('No funnel recorded.')).toBeInTheDocument();
  });
});
