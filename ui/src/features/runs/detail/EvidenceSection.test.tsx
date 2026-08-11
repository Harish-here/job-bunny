import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RunEventRow, SoftErrorSummary } from '../../../lib/api/types';
import { EvidenceSection } from './EvidenceSection';

function summary(over: Partial<SoftErrorSummary> = {}): SoftErrorSummary {
  return {
    total: 0,
    groups: [],
    breakerOpen: false,
    ...over,
  };
}

function event(over: Partial<RunEventRow> & { msg: string }): RunEventRow {
  return {
    ts: '2026-08-10T09:14:00.000Z',
    level: 'info',
    ...over,
  };
}

function noopOpenChange() {}

describe('EvidenceSection — controlled by the parent (mockup fix)', () => {
  it('open=false hides both the soft-error content and the full-log control', () => {
    render(
      <EvidenceSection
        summary={summary({ total: 3 })}
        events={[event({ msg: 'one' }), event({ msg: 'two' })]}
        open={false}
        onOpenChange={noopOpenChange}
      />,
    );
    expect(screen.getByTestId('evidence-disclosure-trigger')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByTestId('evidence-summary-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-events')).not.toBeInTheDocument();
    expect(screen.queryByText('one')).not.toBeInTheDocument();
  });

  it('open=true shows both the soft-error content and the full-log control', () => {
    render(
      <EvidenceSection
        summary={summary({ total: 3 })}
        events={[event({ msg: 'one' }), event({ msg: 'two' })]}
        open={true}
        onOpenChange={noopOpenChange}
      />,
    );
    expect(screen.getByTestId('evidence-disclosure-trigger')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByTestId('evidence-summary-line')).toBeInTheDocument();
    expect(screen.getByTestId('run-events')).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
  });

  it('clicking the trigger calls onOpenChange with the toggled value', async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <EvidenceSection
        summary={summary()}
        events={[]}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    await userEvent.click(screen.getByTestId('evidence-disclosure-trigger'));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    onOpenChange.mockClear();
    rerender(
      <EvidenceSection
        summary={summary()}
        events={[]}
        open={true}
        onOpenChange={onOpenChange}
      />,
    );
    await userEvent.click(screen.getByTestId('evidence-disclosure-trigger'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('never opens itself — a click with a no-op onOpenChange leaves it closed', async () => {
    render(
      <EvidenceSection
        summary={summary()}
        events={[]}
        open={false}
        onOpenChange={noopOpenChange}
      />,
    );
    await userEvent.click(screen.getByTestId('evidence-disclosure-trigger'));
    expect(screen.getByTestId('evidence-disclosure-trigger')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('EvidenceSection — trigger label reads "Evidence — N soft errors" (AC14)', () => {
  it('matches total=3, distinct from a larger raw events array', () => {
    const events = [
      event({ msg: 'a', level: 'warn' }),
      event({ msg: 'b', level: 'warn' }),
      event({ msg: 'c', level: 'error' }),
      event({ msg: 'd', level: 'debug' }),
      event({ msg: 'e', level: 'info' }),
    ];
    render(
      <EvidenceSection
        summary={summary({ total: 3 })}
        events={events}
        open={false}
        onOpenChange={noopOpenChange}
      />,
    );
    const trigger = screen.getByTestId('evidence-disclosure-trigger');
    expect(trigger.textContent).toContain('Evidence — 3 soft errors');
    expect(trigger.textContent).not.toContain(String(events.length));
  });

  it('singular wording for total=1', () => {
    render(
      <EvidenceSection
        summary={summary({ total: 1 })}
        events={[]}
        open={false}
        onOpenChange={noopOpenChange}
      />,
    );
    expect(screen.getByTestId('evidence-disclosure-trigger').textContent).toContain(
      'Evidence — 1 soft error',
    );
    expect(screen.getByTestId('evidence-disclosure-trigger').textContent).not.toContain(
      '1 soft errors',
    );
  });
});

describe('EvidenceSection — soft-error summary line', () => {
  it('renders a summary line reflecting SoftErrorSummary content (top group + total)', () => {
    render(
      <EvidenceSection
        summary={summary({
          total: 8,
          groups: [
            {
              key: 'source.linkedin',
              label: 'source: empty job shell (linkedin)',
              count: 6,
              sample: 'x',
            },
            {
              key: 'unknown',
              label: 'unknown: uncategorized soft error',
              count: 2,
              sample: 'y',
            },
          ],
        })}
        events={[]}
        open={true}
        onOpenChange={noopOpenChange}
      />,
    );
    const line = screen.getByTestId('evidence-summary-line');
    expect(line.textContent).toContain('8');
    expect(line.textContent).toContain('source: empty job shell (linkedin)');
  });

  it('renders a calm "no soft errors" line when total is 0', () => {
    render(
      <EvidenceSection
        summary={summary({ total: 0, groups: [] })}
        events={[]}
        open={true}
        onOpenChange={noopOpenChange}
      />,
    );
    const line = screen.getByTestId('evidence-summary-line');
    expect(line.textContent).toMatch(/no soft errors/i);
  });
});

describe('EvidenceSection — the moved EventsList, visible only while open', () => {
  it('shows event rows, the level filter, and each event message when open', () => {
    const events = [
      event({ msg: 'first event', level: 'warn' }),
      event({ msg: 'second event', level: 'info' }),
    ];
    render(
      <EvidenceSection
        summary={summary({ total: 1 })}
        events={events}
        open={true}
        onOpenChange={noopOpenChange}
      />,
    );

    expect(screen.getByTestId('run-events')).toBeInTheDocument();
    expect(screen.getAllByTestId('run-event-row')).toHaveLength(2);
    expect(screen.getByText('first event')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by level')).toBeInTheDocument();
  });
});
