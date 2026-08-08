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
        { profile: 'rajni', enabled: true, nextRunAt: '2026-08-09T09:00:00.000Z' },
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
});
