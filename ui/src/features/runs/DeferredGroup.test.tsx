import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DeferredSlotRow } from '../../lib/api/types';
import { DeferredGroup } from './DeferredGroup';

function slot(over: Partial<DeferredSlotRow> = {}): DeferredSlotRow {
  return {
    runDate: '2026-08-13',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'Job Bunny declined to start this run because the host was asleep.',
    decidedAt: '2026-08-13T09:00:05.000Z',
    notifiedAt: null,
    ...over,
  };
}

const FIVE_ROWS: DeferredSlotRow[] = [
  slot({ slot: '09:00' }),
  slot({ slot: '11:30' }),
  slot({ slot: '14:00' }),
  slot({ slot: '16:30' }),
  slot({ slot: '19:00' }),
];

describe('DeferredGroup — R25 never empty by construction', () => {
  it('renders nothing for an empty rows array', () => {
    const { container } = render(<DeferredGroup rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DeferredGroup — five entries render (toHaveLength(5), not a comment)', () => {
  it('renders exactly five deferred-slot-entry elements, each with correct time/short reason', () => {
    render(<DeferredGroup rows={FIVE_ROWS} />);
    const entries = screen.getAllByTestId(/^deferred-slot-entry-\d+$/);
    expect(entries).toHaveLength(5);

    FIVE_ROWS.forEach((row, i) => {
      const n = i + 1;
      expect(screen.getByTestId(`deferred-slot-time-${n}`)).toHaveTextContent(row.slot);
      // Short label (mockup's `host asleep`), not the full `row.reason`
      // sentence — BUG 4.
      expect(screen.getByTestId(`deferred-slot-reason-${n}`)).toHaveTextContent(
        'host asleep',
      );
    });
  });
});

describe('DeferredGroup — entry reason is the short label, not the full sentence (BUG 4)', () => {
  it('renders the reasonCode short label per entry and never the long declined-to-start sentence', () => {
    const rows: DeferredSlotRow[] = [
      slot({ slot: '09:00', reasonCode: 'host-asleep' }),
      slot({
        slot: '11:30',
        reasonCode: 'network-unreachable',
        reason:
          'Job Bunny declined to start this run because the network was unreachable.',
      }),
      slot({
        slot: '13:00',
        reasonCode: 'daemon-unavailable',
        reason: "Job Bunny's scheduler was not running during this scheduled window.",
      }),
    ];
    render(<DeferredGroup rows={rows} />);

    const reason1 = screen.getByTestId('deferred-slot-reason-1');
    expect(reason1).toHaveTextContent('host asleep');
    expect(reason1.textContent).not.toContain(
      'Job Bunny declined to start this run because the host was asleep.',
    );

    const reason2 = screen.getByTestId('deferred-slot-reason-2');
    expect(reason2).toHaveTextContent('network unreachable');
    expect(reason2.textContent).not.toContain(
      'Job Bunny declined to start this run because the network was unreachable.',
    );

    const reason3 = screen.getByTestId('deferred-slot-reason-3');
    expect(reason3).toHaveTextContent('daemon unavailable');
    expect(reason3.textContent).not.toContain(
      "Job Bunny's scheduler was not running during this scheduled window.",
    );
  });
});

describe('DeferredGroup — deferred-group-reason header sentence', () => {
  it('renders the single mockup sentence when every row shares the same reasonCode', () => {
    render(<DeferredGroup rows={FIVE_ROWS} />);
    expect(screen.getByTestId('deferred-group-reason')).toHaveTextContent(
      'Job Bunny declined to start these runs because the host was asleep.',
    );
  });

  it('renders the generic fallback sentence when reasonCodes differ', () => {
    const rows: DeferredSlotRow[] = [
      slot({ slot: '09:00', reasonCode: 'host-asleep' }),
      slot({
        slot: '11:30',
        reasonCode: 'network-unreachable',
        reason: 'network unreachable',
      }),
    ];
    render(<DeferredGroup rows={rows} />);
    expect(screen.getByTestId('deferred-group-reason')).toHaveTextContent(
      'Job Bunny declined to start several runs today — see below for each reason.',
    );
  });
});

describe('DeferredGroup — toggle collapses and restores the entries', () => {
  it('clicking the toggle hides an entry, clicking again restores it', async () => {
    render(<DeferredGroup rows={FIVE_ROWS} />);
    expect(screen.getByText('09:00')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('deferred-group-toggle'));
    expect(screen.queryByText('09:00')).toBeNull();

    await userEvent.click(screen.getByTestId('deferred-group-toggle'));
    expect(screen.getByText('09:00')).toBeInTheDocument();
  });
});

describe('DeferredGroup — data-qa ids all present, each with a matching data-testid', () => {
  it('carries every id from data-qa-ids.md', () => {
    render(<DeferredGroup rows={FIVE_ROWS} />);
    for (const id of [
      'deferred-group',
      'deferred-group-header',
      'deferred-group-reason',
      'deferred-group-toggle',
      'deferred-slot-entry-1',
      'deferred-slot-time-1',
      'deferred-slot-reason-1',
    ]) {
      const el = screen.getByTestId(id);
      expect(el.getAttribute('data-qa')).toBe(id);
    }
  });
});
