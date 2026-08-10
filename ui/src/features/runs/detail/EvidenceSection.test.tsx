import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunEventRow, SoftErrorSummary } from '../../../lib/api/types';
import { EvidenceSection } from './EvidenceSection';

function summary(over: Partial<SoftErrorSummary> = {}): SoftErrorSummary {
  return {
    total: 0,
    groups: [],
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

describe('EvidenceSection — disclosure closed by default', () => {
  it('does not render the events content before any interaction', () => {
    render(
      <EvidenceSection
        summary={summary({ total: 3 })}
        events={[event({ msg: 'one' }), event({ msg: 'two' })]}
      />,
    );
    expect(screen.queryByTestId('run-events')).not.toBeInTheDocument();
  });

  it('the trigger has aria-expanded="false" before any interaction', () => {
    render(<EvidenceSection summary={summary()} events={[]} />);
    expect(screen.getByTestId('evidence-disclosure-trigger')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('EvidenceSection — trigger label count matches SoftErrorSummary.total (AC14)', () => {
  it('matches total=3, distinct from a larger raw events array', () => {
    const events = [
      event({ msg: 'a', level: 'warn' }),
      event({ msg: 'b', level: 'warn' }),
      event({ msg: 'c', level: 'error' }),
      event({ msg: 'd', level: 'debug' }),
      event({ msg: 'e', level: 'info' }),
    ];
    render(<EvidenceSection summary={summary({ total: 3 })} events={events} />);
    const trigger = screen.getByTestId('evidence-disclosure-trigger');
    expect(trigger.textContent).toContain('3');
    expect(trigger.textContent).not.toContain(String(events.length));
  });

  it('matches a different total=17', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      event({ msg: `m${i}`, level: 'info' }),
    );
    render(<EvidenceSection summary={summary({ total: 17 })} events={events} />);
    const trigger = screen.getByTestId('evidence-disclosure-trigger');
    expect(trigger.textContent).toContain('17');
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
      />,
    );
    const line = screen.getByTestId('evidence-summary-line');
    expect(line.textContent).toContain('8');
    expect(line.textContent).toContain('source: empty job shell (linkedin)');
  });

  it('renders a calm "no soft errors" line when total is 0', () => {
    render(<EvidenceSection summary={summary({ total: 0, groups: [] })} events={[]} />);
    const line = screen.getByTestId('evidence-summary-line');
    expect(line.textContent).toMatch(/no soft errors/i);
  });
});

describe('EvidenceSection — opening the disclosure reveals the moved EventsList', () => {
  it('clicking the trigger reveals events content, level filter, and event rows', () => {
    const events = [
      event({ msg: 'first event', level: 'warn' }),
      event({ msg: 'second event', level: 'info' }),
    ];
    render(<EvidenceSection summary={summary({ total: 1 })} events={events} />);

    const trigger = screen.getByTestId('evidence-disclosure-trigger');
    expect(screen.queryByTestId('run-events')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('run-events')).toBeInTheDocument();
    expect(screen.getAllByTestId('run-event-row')).toHaveLength(2);
    expect(screen.getByText('first event')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by level')).toBeInTheDocument();
  });

  it('clicking again collapses the disclosure', () => {
    render(
      <EvidenceSection summary={summary({ total: 1 })} events={[event({ msg: 'x' })]} />,
    );
    const trigger = screen.getByTestId('evidence-disclosure-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('run-events')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('run-events')).not.toBeInTheDocument();
  });
});
