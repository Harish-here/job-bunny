import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { StartDaemonOutcome, StopDaemonOutcome } from '../../lib/api/types';
import * as configApi from '../settings/config.api';
import * as profilesApi from '../shell/profiles.api';
import * as wizardApi from '../wizard/wizard.api';
import type { DaemonStatus } from '../wizard/wizard.types';
import { DaemonCard } from './DaemonCard';
import * as operateApi from './operate.api';

vi.mock('../wizard/wizard.api', () => ({
  getDaemonStatus: vi.fn(),
  getPersonas: vi.fn(),
}));
vi.mock('../settings/config.api', () => ({ getConfigDoc: vi.fn() }));
vi.mock('../shell/profiles.api', () => ({ getProfiles: vi.fn() }));
vi.mock('./operate.api', () => ({
  stopDaemon: vi.fn(),
  startDaemon: vi.fn(),
  setAutostart: vi.fn(),
  pauseProfile: vi.fn(),
}));

/** Fresh timestamps per call — a module-level fixture would drift as the
 * suite runs, breaking the "12s ago"-shaped assertions in later tests. */
function baseDaemon(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  const now = Date.now();
  return {
    state: 'running',
    pid: 59025,
    startedAt: new Date(now - (3 * 86_400_000 + 4 * 3_600_000)).toISOString(),
    lastTickAt: new Date(now - 12_000).toISOString(),
    inFlight: null,
    profiles: [],
    ...overrides,
  };
}

function stubDaemon(status: DaemonStatus) {
  vi.mocked(wizardApi.getDaemonStatus).mockResolvedValue(status);
}
function stubDaemonPending() {
  vi.mocked(wizardApi.getDaemonStatus).mockReturnValue(new Promise(() => {}));
}
function stubConfig(text = '{}') {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text });
}
function stubProfiles(names: string[]) {
  vi.mocked(profilesApi.getProfiles).mockResolvedValue({
    profiles: names.map((name) => ({ name, connector: 'sqlite' as const, hasDb: true })),
  });
}

function renderCard(profile = 'rajni') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<DaemonCard profile={profile} />, { wrapper });
}

/** last-tick / pid / uptime — the fields `ScheduleSection.tsx` used to
 * show. The last-tick assertion is a shape regex, not a literal "12s
 * ago" — a module-fresh fixture is still subject to render/scheduling
 * jitter that could carry it into the next second bucket. */
function expectMetaLineVisible() {
  expect(screen.getByText(/^\d+s ago$/)).toBeInTheDocument();
  expect(screen.getByText('59025')).toBeInTheDocument();
  expect(screen.getByText('3d 4h')).toBeInTheDocument();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('DaemonCard — six states', () => {
  it('loading: renders a skeleton, never a skeleton of the state word itself', () => {
    stubDaemonPending();
    stubConfig();
    const { container } = renderCard();
    expect(screen.getByText('Daemon')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="card-daemon"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="daemon-state"]')).toBeNull();
  });

  it('api-unreachable: a first-class state, distinct from degraded, with a working Retry', async () => {
    stubConfig();
    vi.mocked(wizardApi.getDaemonStatus)
      .mockRejectedValueOnce(new Error('daemon probe failed'))
      .mockResolvedValue(baseDaemon());
    renderCard();
    await screen.findByText("Can't reach the daemon API");
    expect(screen.queryByText(/Degraded/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Running');
  });

  it('degraded: the schema-drift label, attention tone, plus full markup', async () => {
    stubConfig();
    stubDaemon(
      baseDaemon({
        profiles: [
          {
            profile: 'rajni',
            enabled: true,
            nextRunAt: null,
            degraded: true,
            degradedReason: 'schema drift',
            schemaVersion: 7,
            buildVersion: 6,
          },
        ],
      }),
    );
    renderCard();
    const word = await screen.findByText('Degraded — schema v7 > daemon build v6');
    expect(word).toHaveClass('text-attention-strong');
    expect(
      screen.getByText('Fix: jobbunny serve stop && jobbunny serve start'),
    ).toBeInTheDocument();
    expectMetaLineVisible();
  });

  it('stopped: "Not running" with destructive tone, the Start label, plus full markup', async () => {
    stubConfig();
    stubDaemon(baseDaemon({ state: 'stopped' }));
    renderCard();
    const word = await screen.findByText('Not running');
    expect(word).toHaveClass('text-destructive-strong');
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expectMetaLineVisible();
  });

  it('stale: "Wedged" with attention tone, plus full markup', async () => {
    stubConfig();
    stubDaemon(baseDaemon({ state: 'stale' }));
    renderCard();
    const word = await screen.findByText('Wedged');
    expect(word).toHaveClass('text-attention-strong');
    expectMetaLineVisible();
  });

  it('running: "Running" with success tone, the Stop label, plus full markup', async () => {
    stubConfig();
    stubDaemon(baseDaemon());
    renderCard();
    const word = await screen.findByText('Running');
    expect(word).toHaveClass('text-success-strong');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expectMetaLineVisible();
  });
});

describe('daemon-start-stop — Stop', () => {
  const STOP_CASES: { name: string; outcome: StopDaemonOutcome; text: string }[] = [
    { name: 'stopped', outcome: { outcome: 'stopped' }, text: 'Daemon stopped.' },
    {
      name: 'already_stopped',
      outcome: { outcome: 'already_stopped' },
      text: 'Daemon was already stopped.',
    },
    {
      name: 'daemon_unresponsive',
      outcome: { outcome: 'daemon_unresponsive' },
      text: "The daemon didn't respond to the stop signal — check it manually.",
    },
    {
      name: 'child_unresponsive',
      outcome: { outcome: 'child_unresponsive', childPid: 4242 },
      text: "The in-flight run (pid 4242) didn't stop — check it manually.",
    },
  ];

  it.each(STOP_CASES)(
    'Stop → $name renders its own distinct, named line',
    async ({ outcome, text }) => {
      stubConfig();
      stubDaemon(baseDaemon());
      vi.mocked(operateApi.stopDaemon).mockResolvedValue(outcome);
      renderCard();
      await screen.findByText('Running');
      await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
      const line = await screen.findByText(text);
      if (outcome.outcome === 'stopped' || outcome.outcome === 'already_stopped') {
        expect(line).toHaveClass('text-success-strong');
      } else {
        expect(line).toHaveClass('text-destructive');
        expect(line).not.toHaveClass('text-success-strong');
      }
    },
  );
});

describe('daemon-start-stop — Start', () => {
  it("shows the 35s long-wait affordance while pending — not the generic 'Saving…' flip", async () => {
    stubConfig();
    stubDaemon(baseDaemon({ state: 'stopped' }));
    vi.mocked(operateApi.startDaemon).mockReturnValue(new Promise(() => {}));
    renderCard();
    await screen.findByText('Not running');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText('Starting… this can take up to 35 seconds');
    expect(screen.queryByText('Saving…')).toBeNull();
  });

  const START_CASES: { name: string; outcome: StartDaemonOutcome; text: string }[] = [
    { name: 'started', outcome: { outcome: 'started' }, text: 'Daemon started.' },
    {
      name: 'already_running',
      outcome: { outcome: 'already_running' },
      text: 'Daemon was already running.',
    },
    {
      name: 'spawn_failed',
      outcome: { outcome: 'spawn_failed' },
      text: 'Failed to start the daemon.',
    },
  ];

  it.each(START_CASES)(
    'Start → $name renders its own distinct, named line',
    async ({ outcome, text }) => {
      stubConfig();
      stubDaemon(baseDaemon({ state: 'stopped' }));
      vi.mocked(operateApi.startDaemon).mockResolvedValue(outcome);
      renderCard();
      await screen.findByText('Not running');
      await userEvent.click(screen.getByRole('button', { name: 'Start' }));
      await screen.findByText(text);
    },
  );
});

describe('daemon-pause-all', () => {
  it('reports partial failure explicitly, never a bare boolean "done"', async () => {
    stubConfig();
    stubDaemon(baseDaemon());
    stubProfiles(['alpha', 'rajni', 'beta']);
    vi.mocked(operateApi.pauseProfile).mockImplementation(async (profile: string) => {
      if (profile === 'rajni') throw new Error('write failed');
    });
    renderCard();
    await screen.findByText('Running');
    await userEvent.click(screen.getByRole('button', { name: 'Pause all' }));
    await screen.findByText('Paused 2 of 3 profiles — rajni failed: write failed');
  });
});

describe('daemon-autostart', () => {
  it('ok: clicking flips the switch to checked', async () => {
    stubConfig();
    stubDaemon(baseDaemon());
    vi.mocked(operateApi.setAutostart).mockResolvedValue({ outcome: 'ok' });
    renderCard();
    await screen.findByText('Running');
    const sw = screen.getByRole('switch', { name: 'Autostart' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(await screen.findByRole('switch', { name: 'Autostart' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(operateApi.setAutostart).toHaveBeenCalledWith(true);
  });

  it('unsupported_platform: a static disabled-look row with inline copy, not a silent no-op', async () => {
    stubConfig();
    stubDaemon(baseDaemon());
    vi.mocked(operateApi.setAutostart).mockResolvedValue({
      outcome: 'unsupported_platform',
    });
    renderCard();
    await screen.findByText('Running');
    await userEvent.click(screen.getByRole('switch', { name: 'Autostart' }));
    await screen.findByText('Autostart is darwin-only');
    expect(screen.getByRole('switch', { name: 'Autostart' })).toBeDisabled();
  });

  it('a 409 autostart_conflict renders a distinct, non-success line carrying the message, without crashing the card', async () => {
    stubConfig();
    stubDaemon(baseDaemon());
    vi.mocked(operateApi.setAutostart).mockRejectedValue(
      new ApiError(409, 'autostart_conflict', 'legacy plist present'),
    );
    renderCard();
    await screen.findByText('Running');
    const sw = screen.getByRole('switch', { name: 'Autostart' });
    await userEvent.click(sw);
    const line = await screen.findByText('Autostart error: legacy plist present');
    expect(line).toHaveClass('text-destructive');
    // Distinct from both the ok and unsupported_platform renders.
    expect(screen.queryByText('Autostart is darwin-only')).toBeNull();
    // The switch's own checked state is left untouched, not optimistically flipped.
    expect(sw).toHaveAttribute('aria-checked', 'false');
    // The rest of the card keeps rendering.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });
});

describe('severity accent', () => {
  it('healthy: carries no accent border/tint', async () => {
    stubConfig();
    stubDaemon(baseDaemon());
    const { container } = renderCard();
    await screen.findByText('Running');
    expect(container.querySelector('[data-qa="card-daemon"]')?.className).not.toMatch(
      /border-l-2/,
    );
  });

  it('stopped: takes the accent border/tint (the single worst-ranked card)', async () => {
    stubConfig();
    stubDaemon(baseDaemon({ state: 'stopped' }));
    const { container } = renderCard();
    await screen.findByText('Not running');
    expect(container.querySelector('[data-qa="card-daemon"]')?.className).toMatch(
      /border-l-2 border-destructive/,
    );
  });
});

describe('schedule banner', () => {
  it('stopped + schedule enabled: renders the scheduled-but-not-running banner', async () => {
    stubDaemon(baseDaemon({ state: 'stopped' }));
    stubConfig(JSON.stringify({ schedule: { enabled: true, times: ['09:00'] } }));
    renderCard();
    await screen.findByText('Not running');
    await screen.findByText("Scheduled for 09:00 but the daemon isn't running");
    expect(screen.getByText('jobbunny serve start')).toBeInTheDocument();
  });

  it('running + schedule enabled: no banner (only fires when the daemon is down)', async () => {
    stubDaemon(baseDaemon());
    stubConfig(JSON.stringify({ schedule: { enabled: true, times: ['09:00'] } }));
    renderCard();
    await screen.findByText('Running');
    expect(screen.queryByText(/Scheduled for/)).toBeNull();
  });
});
