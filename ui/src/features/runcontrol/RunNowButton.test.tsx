import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunNowButton } from './RunNowButton';
import type { RunControlHandle } from './useRunControl';

function makeControl(over: Partial<RunControlHandle> = {}): RunControlHandle {
  return {
    state: { kind: 'idle' },
    label: 'Run now',
    onRun: vi.fn(),
    onCancel: vi.fn(),
    isSubmitting: false,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  window.location.hash = '';
});

describe('RunNowButton', () => {
  it('renders the current label', () => {
    render(<RunNowButton control={makeControl()} collapsed={false} />);
    expect(screen.getByTestId('run-now')).toHaveTextContent('Run now');
  });

  it('calls onRun when clicked in idle state', async () => {
    const control = makeControl();
    render(<RunNowButton control={control} collapsed={false} />);
    await userEvent.click(screen.getByTestId('run-now'));
    expect(control.onRun).toHaveBeenCalledTimes(1);
  });

  it('is disabled while submitting', () => {
    render(
      <RunNowButton control={makeControl({ isSubmitting: true })} collapsed={false} />,
    );
    expect(screen.getByTestId('run-now')).toBeDisabled();
  });

  it('is disabled while a run is in progress', () => {
    const control = makeControl({
      state: { kind: 'running', runId: 1, stage: 'filter', index: 7, total: 10 },
      label: 'Running — filter 7/10',
    });
    render(<RunNowButton control={control} collapsed={false} />);
    expect(screen.getByTestId('run-now')).toBeDisabled();
  });

  it('renders no secondary affordance in idle, running, or done', () => {
    const cases: RunControlHandle[] = [
      makeControl(),
      makeControl({
        state: { kind: 'running', runId: 1, stage: null, index: 0, total: 10 },
        label: 'Running — starting…',
      }),
      makeControl({
        state: { kind: 'done', runId: 1, newCount: 3 },
        label: 'Done: 3 new',
      }),
    ];
    for (const control of cases) {
      const { unmount } = render(<RunNowButton control={control} collapsed={false} />);
      expect(screen.queryByTestId('run-now-secondary')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('renders Cancel for queued, and calls onCancel', async () => {
    const control = makeControl({
      state: { kind: 'queued', intentId: 5 },
      label: 'Queued (waiting for daemon)',
    });
    render(<RunNowButton control={control} collapsed={false} />);
    const secondary = screen.getByTestId('run-now-secondary');
    expect(secondary).toHaveTextContent('Cancel');
    await userEvent.click(secondary);
    expect(control.onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders Queue again and the daemon hint for expired, and calls onRun', async () => {
    const control = makeControl({
      state: { kind: 'expired', intentId: 5 },
      label: "Daemon isn't running",
    });
    render(<RunNowButton control={control} collapsed={false} />);
    const secondary = screen.getByTestId('run-now-secondary');
    expect(secondary).toHaveTextContent('Queue again');
    expect(
      screen.getByText('Start the daemon with: jobbunny serve start'),
    ).toBeInTheDocument();
    await userEvent.click(secondary);
    expect(control.onRun).toHaveBeenCalledTimes(1);
  });

  it('renders View run for conflict and navigates to the runs route', async () => {
    const control = makeControl({
      state: { kind: 'conflict', runId: 9 },
      label: 'Run in progress — view it',
    });
    render(<RunNowButton control={control} collapsed={false} />);
    await userEvent.click(screen.getByTestId('run-now-secondary'));
    expect(window.location.hash).toBe('#/runs');
  });

  it('renders View run for failed', () => {
    const control = makeControl({
      state: { kind: 'failed', runId: 9 },
      label: 'Last run failed',
    });
    render(<RunNowButton control={control} collapsed={false} />);
    expect(screen.getByTestId('run-now-secondary')).toHaveTextContent('View run');
  });

  it('renders a destructive error message under the button when set', () => {
    render(
      <RunNowButton control={makeControl({ error: 'HTTP 500' })} collapsed={false} />,
    );
    expect(screen.getByTestId('run-now-error')).toHaveTextContent('HTTP 500');
  });

  it('hides the error message when the sidebar is collapsed', () => {
    render(
      <RunNowButton control={makeControl({ error: 'HTTP 500' })} collapsed={true} />,
    );
    expect(screen.queryByTestId('run-now-error')).not.toBeInTheDocument();
  });

  it('is icon-only with an aria-label when the sidebar is collapsed', () => {
    render(<RunNowButton control={makeControl()} collapsed={true} />);
    const button = screen.getByTestId('run-now');
    expect(button).toHaveAttribute('aria-label', 'Run now');
    expect(button).not.toHaveTextContent('Run now');
  });

  it('hides the secondary affordance when the sidebar is collapsed', () => {
    const control = makeControl({
      state: { kind: 'queued', intentId: 5 },
      label: 'Queued (waiting for daemon)',
    });
    render(<RunNowButton control={control} collapsed={true} />);
    expect(screen.queryByTestId('run-now-secondary')).not.toBeInTheDocument();
  });
});
