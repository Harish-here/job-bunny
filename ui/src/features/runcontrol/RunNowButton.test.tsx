import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunNowButton } from './RunNowButton';
import type { RunControlHandle } from './useRunControl';

function makeControl(over: Partial<RunControlHandle> = {}): RunControlHandle {
  return {
    state: { kind: 'idle' },
    label: 'Run now',
    lastRunStatus: null,
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

  describe('daemon-down (S8/ux-notes §8)', () => {
    function daemonDownControl(over: Partial<RunControlHandle> = {}) {
      return makeControl({
        state: { kind: 'daemon-down', intentId: 5 },
        label: "Daemon isn't running",
        ...over,
      });
    }

    it('renders a destructive-outline treatment, a copy-command button, and both Keep queued and Cancel', () => {
      render(<RunNowButton control={daemonDownControl()} collapsed={false} />);

      const button = screen.getByTestId('run-now');
      expect(button).toHaveAttribute('data-variant', 'outline');
      expect(button).toHaveClass('border-destructive');

      expect(screen.getByTestId('run-now-copy')).toBeInTheDocument();

      const secondary = screen.getAllByTestId('run-now-secondary');
      expect(secondary.map((el) => el.textContent)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Keep queued'),
          expect.stringContaining('Cancel'),
        ]),
      );
    });

    it('writes exactly "jobbunny serve start" to the clipboard when the copy button is clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      render(<RunNowButton control={daemonDownControl()} collapsed={false} />);
      await userEvent.click(screen.getByTestId('run-now-copy'));

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith('jobbunny serve start');
    });

    it('calls onCancel when Cancel is clicked', async () => {
      const control = daemonDownControl();
      render(<RunNowButton control={control} collapsed={false} />);

      const cancel = screen
        .getAllByTestId('run-now-secondary')
        .find((el) => el.textContent?.includes('Cancel'));
      expect(cancel).toBeDefined();
      await userEvent.click(cancel as HTMLElement);

      expect(control.onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('daemon-unknown (S8/ux-notes §8, C16)', () => {
    it('renders an amber-outline treatment distinct from daemon-down, with the "queued anyway" copy', () => {
      const control = makeControl({
        state: { kind: 'daemon-unknown', intentId: 5 },
        label: "Can't reach the daemon — queued anyway",
      });
      render(<RunNowButton control={control} collapsed={false} />);

      const button = screen.getByTestId('run-now');
      expect(button).toHaveAttribute('data-variant', 'outline');
      expect(button).toHaveClass('border-amber');
      expect(button).not.toHaveClass('border-destructive');
      expect(button).toHaveTextContent("Can't reach the daemon — queued anyway");
    });
  });

  describe('persistent last-run status line (C15, decoupled from DONE_WINDOW_MS)', () => {
    it('renders even when the last run finished well outside any 10-minute window', () => {
      const control = makeControl({
        state: { kind: 'idle' },
        label: 'Run now',
        lastRunStatus: {
          kind: 'done',
          runId: 9,
          newCount: 7,
          finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        },
      });
      render(<RunNowButton control={control} collapsed={false} />);

      const line = screen.getByTestId('run-now-last-status');
      expect(line).toHaveTextContent('7 new');
      expect(line).toHaveTextContent(/hour/);
    });

    it('is absent when no run has ever completed', () => {
      render(<RunNowButton control={makeControl()} collapsed={false} />);
      expect(screen.queryByTestId('run-now-last-status')).not.toBeInTheDocument();
    });

    it('navigates to the runs page when clicked', async () => {
      const control = makeControl({
        lastRunStatus: {
          kind: 'failed',
          runId: 3,
          finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        },
      });
      render(<RunNowButton control={control} collapsed={false} />);

      await userEvent.click(screen.getByTestId('run-now-last-status'));
      expect(window.location.hash).toBe('#/runs');
    });
  });
});
