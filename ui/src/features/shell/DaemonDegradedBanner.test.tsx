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

  it('renders the cause text with the "Cause:" label, mirroring mockup:686 / ux-notes.md T6', async () => {
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
    // Not asserting mere presence of the reason text — the label prefix is
    // the load-bearing effect (a bare sentence under a capitalised headline
    // is exactly Bug 2).
    expect(screen.getByTestId('daemon-degraded-cause').textContent).toBe(
      `Cause: ${DEGRADED_REASON}`,
    );
  });

  it('the banner root is a role="status" live region, so a screen-reader user gets an announcement once the daemon degrades (ux-notes.md §9)', async () => {
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
    const banner = await screen.findByTestId('daemon-degraded-banner');
    // getByRole, not a data-testid lookup — this fails if role="status" is
    // ever dropped from the banner root, which is the actual bug (a
    // silently-mounted banner that never announces to assistive tech).
    expect(screen.getByRole('status')).toBe(banner);
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

  // ux-notes.md §Cuts: the degraded condition is not dismissible — dismissing
  // it would re-create the exact silent outage this banner exists to
  // prevent (the schema-drift Telegram alert fires only once per daemon
  // lifetime). This pins the absence: it must fail if a dismiss/close
  // control of any kind is ever re-added to the degraded banner.
  it('has no dismiss control while degraded', async () => {
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

    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
    // Only the copy button should exist inside the banner.
    expect(
      screen.getByTestId('daemon-degraded-banner').querySelectorAll('button'),
    ).toHaveLength(1);
  });
});
