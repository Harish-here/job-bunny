import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wizardApi from '../wizard/wizard.api';
import type { DaemonStatus } from '../wizard/wizard.types';
import { DaemonDegradedBanner } from './DaemonDegradedBanner';

vi.mock('../wizard/wizard.api', () => ({
  getDaemonStatus: vi.fn(),
  getPersonas: vi.fn(),
}));

const DEGRADED_REASON =
  "the database schema (v7) is newer than the running daemon's build (v6). This happens after an update that changes the schema.";

const IDLE_DAEMON: DaemonStatus = {
  state: 'running',
  pid: 1,
  startedAt: null,
  lastTickAt: null,
  inFlight: null,
  profiles: [],
};

function daemonWith(entry: DaemonStatus['profiles'][number]): DaemonStatus {
  return { ...IDLE_DAEMON, profiles: [entry] };
}

function stubDaemon(status: DaemonStatus) {
  vi.mocked(wizardApi.getDaemonStatus).mockResolvedValue(status);
}

function renderBanner(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<DaemonDegradedBanner profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('DaemonDegradedBanner', () => {
  it('renders nothing when entry is undefined', async () => {
    stubDaemon(IDLE_DAEMON);
    renderBanner();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('daemon-degraded-banner')).toBeNull();
  });

  it('renders nothing when entry.degraded is false', async () => {
    stubDaemon(
      daemonWith({
        profile: 'rajni',
        enabled: true,
        nextRunAt: null,
        degraded: false,
        degradedReason: null,
      }),
    );
    renderBanner();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('daemon-degraded-banner')).toBeNull();
  });

  it('renders the cause text verbatim from entry.degradedReason when degraded', async () => {
    stubDaemon(
      daemonWith({
        profile: 'rajni',
        enabled: true,
        nextRunAt: null,
        degraded: true,
        degradedReason: DEGRADED_REASON,
      }),
    );
    renderBanner();
    expect(await screen.findByTestId('daemon-degraded-banner')).toBeInTheDocument();
    expect(screen.getByTestId('daemon-degraded-cause').textContent).toBe(DEGRADED_REASON);
  });

  it('clicking the copy button writes the exact restart command and flips to Copied', async () => {
    stubDaemon(
      daemonWith({
        profile: 'rajni',
        enabled: true,
        nextRunAt: null,
        degraded: true,
        degradedReason: DEGRADED_REASON,
      }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderBanner();
    await screen.findByTestId('daemon-degraded-banner');
    const copyButton = screen.getByTestId('daemon-degraded-copy-button');
    expect(copyButton).toHaveTextContent('Copy');

    await userEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('jobbunny serve stop && jobbunny serve start');
    expect(copyButton).toHaveTextContent('Copied');
  });

  it('clicking dismiss unmounts the banner in the same render', async () => {
    stubDaemon(
      daemonWith({
        profile: 'rajni',
        enabled: true,
        nextRunAt: null,
        degraded: true,
        degradedReason: DEGRADED_REASON,
      }),
    );
    renderBanner();
    await screen.findByTestId('daemon-degraded-banner');

    await userEvent.click(
      screen.getByRole('button', { name: 'Dismiss for this session' }),
    );

    expect(screen.queryByTestId('daemon-degraded-banner')).toBeNull();
  });

  it('does not invent a data-qa/data-testid for the dismiss button', async () => {
    stubDaemon(
      daemonWith({
        profile: 'rajni',
        enabled: true,
        nextRunAt: null,
        degraded: true,
        degradedReason: DEGRADED_REASON,
      }),
    );
    renderBanner();
    const dismissButton = await screen.findByRole('button', {
      name: 'Dismiss for this session',
    });
    expect(dismissButton).not.toHaveAttribute('data-qa');
    expect(dismissButton).not.toHaveAttribute('data-testid');
  });
});
