import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wizardApi from '../../wizard/wizard.api';
import type { DaemonStatus } from '../../wizard/wizard.types';
import * as configApi from '../config.api';
import { ScheduleSection } from './ScheduleSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));
vi.mock('../../wizard/wizard.api', () => ({
  getDaemonStatus: vi.fn(),
  getPersonas: vi.fn(),
}));

const BASE_PROFILE_JSON = {
  connector: 'sqlite',
  lanes: ['linkedin'],
  notifiers: [],
  routines: [],
  settings: { rank: { skills: { primary: ['React'] } } },
  schedule: {
    times: ['09:00'],
    enabled: true,
    weekdays: [1, 2, 3, 4, 5],
    graceMinutes: 90,
  },
};

const IDLE_DAEMON: DaemonStatus = {
  state: 'running',
  pid: 1,
  startedAt: null,
  lastTickAt: null,
  inFlight: null,
  profiles: [],
};

function stubDoc(doc: Record<string, unknown> = BASE_PROFILE_JSON) {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({
    text: `${JSON.stringify(doc, null, 2)}\n`,
  });
}
function stubDaemon(status: DaemonStatus = IDLE_DAEMON) {
  vi.mocked(wizardApi.getDaemonStatus).mockResolvedValue(status);
}
/** Never resolves — pins the mockup's `schedule-daemon-status-loading`
 * state (the query genuinely in flight), rather than a resolved state
 * that merely looks like loading for a tick. */
function stubDaemonPending() {
  vi.mocked(wizardApi.getDaemonStatus).mockReturnValue(new Promise(() => {}));
}
/** `/api/daemon` itself failing — "we can't tell" (ux-notes.md callout
 * 13), distinct from a resolved, degraded=true payload ("we know, and
 * it's broken"). */
function stubDaemonUnreachable() {
  vi.mocked(wizardApi.getDaemonStatus).mockRejectedValue(
    new Error('daemon probe failed'),
  );
}
function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ScheduleSection profile={profile} />, { wrapper });
}

function writtenDoc(expectedDocName: string) {
  const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
    string,
    string,
    string,
  ];
  expect(call[1]).toBe(expectedDocName);
  return JSON.parse(call[2]);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ScheduleSection', () => {
  it('a failed load renders a blocking error and never a Save button', async () => {
    vi.mocked(configApi.getConfigDoc).mockRejectedValue(new Error('network error'));
    stubDaemon();
    renderSection();
    expect(await screen.findByTestId('settings-load-error')).toHaveTextContent(
      "Couldn't load profile.json: network error",
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });

  it('adding a malformed time is rejected inline before any request', async () => {
    stubDoc();
    stubDaemon();
    const user = userEvent.setup();
    renderSection();
    await screen.findByLabelText('Add a run time');
    await user.type(screen.getByLabelText('Add a run time'), '9:00');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Enter a time as HH:MM (24-hour).')).toBeInTheDocument();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });

  it('a valid time round-trips into the mutation payload, unrelated keys survive', async () => {
    stubDoc();
    stubDaemon();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
    const user = userEvent.setup();
    renderSection();
    await screen.findByLabelText('Add a run time');
    await user.type(screen.getByLabelText('Add a run time'), '18:30');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('18:30')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const written = writtenDoc('profile.json');
    expect(written.schedule.times).toEqual(['09:00', '18:30']);
    expect(written.connector).toBe('sqlite');
    expect(written.lanes).toEqual(['linkedin']);
    expect(written.settings).toEqual(BASE_PROFILE_JSON.settings);
  });

  it('toggling a weekday and enabled produce the right payload', async () => {
    stubDoc();
    stubDaemon();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('button', { name: 'Sun' });
    await user.click(screen.getByRole('button', { name: 'Sun' }));
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const written = writtenDoc('profile.json');
    expect(written.schedule.weekdays).toEqual([0, 1, 2, 3, 4, 5]);
    expect(written.schedule.enabled).toBe(false);
  });

  it("renders the daemon's next run, and a clear no-upcoming-run state when nextRunAt is null", async () => {
    stubDoc();
    stubDaemon({
      ...IDLE_DAEMON,
      profiles: [
        {
          profile: 'rajni',
          enabled: true,
          nextRunAt: '2026-08-09T09:00:00.000Z',
          degraded: false,
          degradedReason: null,
          schemaVersion: null,
          buildVersion: null,
        },
      ],
    });
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('schedule-next-run').textContent).not.toBe(
        'Next run (saved): no upcoming run',
      );
    });
    expect(screen.getByTestId('schedule-next-run')).toHaveTextContent(
      'Next run (saved):',
    );
    expect(screen.getByTestId('schedule-next-run').textContent).not.toContain(
      'no upcoming run',
    );

    stubDaemon();
    renderSection('other-profile');
    await waitFor(() => {
      expect(screen.getAllByTestId('schedule-next-run')[1]).toHaveTextContent(
        'Next run (saved): no upcoming run',
      );
    });
  });

  it("healthy daemon status shows 'Running · last tick Ns ago', computed from the fixture's lastTickAt, not a hardcoded string", async () => {
    stubDoc();
    const lastTickAt = new Date(Date.now() - 12_000).toISOString(); // 12s ago.
    stubDaemon({
      state: 'running',
      pid: 1,
      startedAt: '2026-08-13T09:00:00.000Z',
      lastTickAt,
      inFlight: null,
      profiles: [
        {
          profile: 'rajni',
          enabled: true,
          nextRunAt: '2026-08-13T11:30:00.000Z',
          degraded: false,
          degradedReason: null,
          schemaVersion: null,
          buildVersion: null,
        },
      ],
    });
    renderSection();
    const status = await screen.findByTestId('schedule-daemon-status-healthy');
    expect(status).toHaveTextContent(/Running · last tick 1[0-4]s ago/);
    // A tight range (10-14s), not an exact string match, since real
    // elapsed time between seeding lastTickAt and the assertion running
    // is a handful of milliseconds, never exactly 12000ms.
  });

  it("a stopped daemon renders 'Not running', never the healthy testid", async () => {
    stubDoc();
    stubDaemon({ ...IDLE_DAEMON, state: 'stopped', lastTickAt: null });
    renderSection();
    const status = await screen.findByTestId('schedule-daemon-status-stopped');
    expect(status).toHaveTextContent('Not running');
    expect(status).toHaveTextContent('jobbunny serve start');
    expect(
      screen.queryByTestId('schedule-daemon-status-healthy'),
    ).not.toBeInTheDocument();
  });

  it("a stale daemon renders 'Wedged', never the healthy testid", async () => {
    stubDoc();
    const lastTickAt = new Date(Date.now() - 600_000).toISOString(); // 10m ago.
    stubDaemon({ ...IDLE_DAEMON, state: 'stale', lastTickAt });
    renderSection();
    const status = await screen.findByTestId('schedule-daemon-status-stale');
    expect(status).toHaveTextContent(/Wedged · last tick 60[0-4]s ago/);
    expect(
      screen.queryByTestId('schedule-daemon-status-healthy'),
    ).not.toBeInTheDocument();
  });

  it('degraded daemon status leads with "Degraded —" in the terse version-comparison form (mockup:717), not the full reason sentence, and the remedy command in font-mono', async () => {
    stubDoc();
    const degradedReason =
      "the database schema (v8) is newer than the running daemon's build (v7). This happens after an update that changes the schema.";
    stubDaemon({
      state: 'running',
      pid: 1,
      startedAt: '2026-08-13T09:00:00.000Z',
      lastTickAt: new Date().toISOString(),
      inFlight: null,
      profiles: [
        {
          profile: 'rajni',
          enabled: true,
          nextRunAt: null,
          degraded: true,
          degradedReason,
          schemaVersion: 8,
          buildVersion: 7,
        },
      ],
    });
    renderSection();
    const status = await screen.findByTestId('schedule-daemon-status-degraded');
    // Every sibling status state (Running/Wedged/Not running) leads with a
    // status word — degraded must too, and in the terse form, not the
    // ~120-char sentence that's already on screen in the global banner.
    const label = status.querySelector('span.font-medium');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('Degraded — schema v8 > daemon build v7');
    expect(status).not.toHaveTextContent(degradedReason);
    const command = status.querySelector('code.font-mono');
    expect(command).not.toBeNull();
    expect(command?.textContent).toBe('jobbunny serve stop && jobbunny serve start');
    expect(
      screen.queryByTestId('schedule-daemon-status-healthy'),
    ).not.toBeInTheDocument();
  });

  it('a degraded entry with null schemaVersion/buildVersion (a stale pidfile from before these fields existed) falls back to the full degradedReason sentence, not a crash or "v undefined"', async () => {
    stubDoc();
    const degradedReason =
      "the database schema (v8) is newer than the running daemon's build (v7). This happens after an update that changes the schema.";
    stubDaemon({
      state: 'running',
      pid: 1,
      startedAt: '2026-08-13T09:00:00.000Z',
      lastTickAt: new Date().toISOString(),
      inFlight: null,
      profiles: [
        {
          profile: 'rajni',
          enabled: true,
          nextRunAt: null,
          degraded: true,
          degradedReason,
          schemaVersion: null,
          buildVersion: null,
        },
      ],
    });
    renderSection();
    const status = await screen.findByTestId('schedule-daemon-status-degraded');
    const label = status.querySelector('span.font-medium');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe(`Degraded — ${degradedReason}`);
  });

  it('while the daemon query is in flight, renders the loading skeleton and nothing else (mockup:702-707 loading state)', async () => {
    stubDoc();
    stubDaemonPending();
    renderSection();
    await screen.findByTestId('schedule-daemon-status-loading');
    // The loading skeleton excludes every other status render — this is
    // the effect the mockup's four-state toggle actually requires, not
    // merely that the loading id exists somewhere in the tree.
    expect(screen.queryByTestId('schedule-daemon-status-healthy')).toBeNull();
    expect(screen.queryByTestId('schedule-daemon-status-degraded')).toBeNull();
    expect(screen.queryByTestId('schedule-daemon-status-error')).toBeNull();
  });

  it("an unreachable /api/daemon renders the error state ('Can't reach the daemon API' + working Retry), never the degraded state — Degraded ≠ unreachable (ux-notes.md callout 13)", async () => {
    stubDoc();
    stubDaemonUnreachable();
    renderSection();
    const status = await screen.findByTestId('schedule-daemon-status-error');
    expect(status).toHaveTextContent("Can't reach the daemon API");
    // The distinguishing assertion: an unreachable probe must render the
    // "we can't tell" copy, never the "we know, and it's broken" degraded
    // copy — collapsing the two is the exact regression this bug guards.
    expect(screen.queryByTestId('schedule-daemon-status-degraded')).toBeNull();
    expect(screen.queryByTestId('schedule-daemon-status-healthy')).toBeNull();

    // Retry is wired, not inert: it re-invokes the query fn.
    const callsBefore = vi.mocked(wizardApi.getDaemonStatus).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(vi.mocked(wizardApi.getDaemonStatus).mock.calls.length).toBeGreaterThan(
        callsBefore,
      );
    });
  });
});
