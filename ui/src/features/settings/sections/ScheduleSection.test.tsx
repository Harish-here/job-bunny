import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../../lib/router';
import * as wizardApi from '../../wizard/wizard.api';
import type { DaemonStatus } from '../../wizard/wizard.types';
import * as configApi from '../config.api';
import {
  SettingsSaveProvider,
  useSettingsSaveGuardState,
} from '../save/SettingsSaveContext';
import { ScheduleSection } from './ScheduleSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));
vi.mock('../../wizard/wizard.api', () => ({
  getDaemonStatus: vi.fn(),
  getPersonas: vi.fn(),
}));
vi.mock('../../../lib/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/router')>();
  return { ...actual, navigate: vi.fn() };
});

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
/** Never resolves — a query genuinely in flight, not merely resolved fast
 * enough to look pending. */
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

  // The daemon bridge line (blueprint.md:798-812, step 18) — the compact
  // isLoading/isError/word treatment that replaced the six-branch
  // full-markup block. Full-markup state coverage moved to
  // DaemonCard.test.tsx (a later Operate brief); these assert only the
  // word text `daemonStatusWord()` (task 16) derives per state, ported
  // byte-for-byte from the removed tests' own substrings (proving the
  // extraction changed no observable text).
  describe('the compact daemon bridge line', () => {
    it('loading — "Loading…"', async () => {
      stubDoc();
      stubDaemonPending();
      renderSection();
      await screen.findByText('Loading…');
    });

    it('unreachable — "Can\'t reach the daemon API"', async () => {
      stubDoc();
      stubDaemonUnreachable();
      renderSection();
      await screen.findByText("Can't reach the daemon API");
    });

    it('running (healthy) — "Running"', async () => {
      stubDoc();
      const lastTickAt = new Date(Date.now() - 12_000).toISOString();
      stubDaemon({
        ...IDLE_DAEMON,
        lastTickAt,
        profiles: [
          {
            profile: 'rajni',
            enabled: true,
            nextRunAt: null,
            degraded: false,
            degradedReason: null,
            schemaVersion: null,
            buildVersion: null,
          },
        ],
      });
      renderSection();
      await screen.findByText(/Running/);
    });

    it('stopped — "Not running"', async () => {
      stubDoc();
      stubDaemon({ ...IDLE_DAEMON, state: 'stopped', lastTickAt: null });
      renderSection();
      await screen.findByText('Not running');
    });

    it('stale — "Wedged"', async () => {
      stubDoc();
      const lastTickAt = new Date(Date.now() - 600_000).toISOString();
      stubDaemon({ ...IDLE_DAEMON, state: 'stale', lastTickAt });
      renderSection();
      await screen.findByText('Wedged');
    });

    it('degraded — the terse "Degraded — schema vN > daemon build vM" form', async () => {
      stubDoc();
      const degradedReason =
        "the database schema (v8) is newer than the running daemon's build (v7).";
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
      await screen.findByText('Degraded — schema v8 > daemon build v7');
    });

    it('clicking "Manage the daemon on Operate →" navigates to #/setup', async () => {
      stubDoc();
      stubDaemon();
      const user = userEvent.setup();
      renderSection();
      await user.click(
        await screen.findByRole('button', { name: 'Manage the daemon on Operate →' }),
      );
      expect(vi.mocked(navigate)).toHaveBeenCalledWith({ name: 'setup' });
    });
  });

  // Re-review finding: this section previously never registered into
  // `SettingsSaveContext` at all, so the dirty-nav guard was inert for it
  // — a nav click or profile switch could silently unmount an unsaved
  // schedule edit. Minimal fix: a locally-computed `isDirty` via
  // `useRegisterSettingsSave` (see the component's own doc comment).
  describe('SettingsSaveContext registration', () => {
    function GuardProbe() {
      const { isDirty } = useSettingsSaveGuardState();
      return <span data-testid="guard-isDirty">{String(isDirty)}</span>;
    }

    function renderWithGuard(profile = 'rajni') {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={qc}>
          <SettingsSaveProvider>
            <GuardProbe />
            <ScheduleSection profile={profile} />
          </SettingsSaveProvider>
        </QueryClientProvider>,
      );
    }

    it('registers isDirty as the schedule draft changes, and clears it after a successful save', async () => {
      stubDoc();
      stubDaemon();
      vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
      const user = userEvent.setup();
      renderWithGuard();

      await screen.findByRole('button', { name: 'Sun' });
      expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('false');

      await user.click(screen.getByRole('switch'));
      expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('true');

      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('false'),
      );
    });

    // Fix-round-2 residual (finding 1): `DaemonBridgeLine`'s "Manage the
    // daemon on Operate →" button used the raw app-wide `navigate` even
    // though this section registers via `useRegisterSettingsSave` above —
    // a dirty schedule draft was silently discarded on click, no dialog.
    // Now wired through `useGuardedNavigate()`, same as
    // `RawConfigSection`/`RolesCompaniesSection`/`WhereYouWorkPrefsCard`.
    // This also closes finding 2 (no test anywhere exercised a
    // `DirtyNavGuard` instance actually intercepting, inside a real
    // `SettingsSaveProvider`).
    it('dirtying the schedule then clicking "Manage the daemon on Operate →" opens the dirty-nav dialog and does not navigate', async () => {
      stubDoc();
      stubDaemon();
      const user = userEvent.setup();
      renderWithGuard();

      await user.click(await screen.findByRole('switch'));
      expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('true');

      await user.click(
        screen.getByRole('button', { name: 'Manage the daemon on Operate →' }),
      );

      expect(await screen.findByTestId('dirty-nav-dialog')).toBeInTheDocument();
      expect(vi.mocked(navigate)).not.toHaveBeenCalled();
    });
  });
});
