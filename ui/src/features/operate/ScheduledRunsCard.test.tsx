import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wizardApi from '../wizard/wizard.api';
import type { DaemonProfileSchedule, DaemonStatus } from '../wizard/wizard.types';
import * as operateApi from './operate.api';
import { nextSlotFor, ScheduledRunsCard, todayISODate } from './ScheduledRunsCard';

vi.mock('../wizard/wizard.api', () => ({ getDaemonStatus: vi.fn() }));
vi.mock('./operate.api', () => ({
  putSkipNext: vi.fn(),
  setScheduleEnabled: vi.fn(),
}));

function baseDaemon(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    state: 'running',
    pid: 59025,
    startedAt: null,
    lastTickAt: null,
    inFlight: null,
    profiles: [],
    ...overrides,
  };
}

function scheduleFor(
  profile: string,
  overrides: Partial<DaemonProfileSchedule> = {},
): DaemonProfileSchedule {
  return {
    profile,
    enabled: true,
    nextRunAt: new Date(2099, 0, 1, 23, 0, 0).toISOString(),
    degraded: false,
    degradedReason: null,
    schemaVersion: null,
    buildVersion: null,
    ...overrides,
  };
}

function stubDaemon(status: DaemonStatus) {
  vi.mocked(wizardApi.getDaemonStatus).mockResolvedValue(status);
}
function stubDaemonPending() {
  vi.mocked(wizardApi.getDaemonStatus).mockReturnValue(new Promise(() => {}));
}

function renderCard(profile = 'harish') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ScheduledRunsCard profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('nextSlotFor', () => {
  it("derives {date: today, slot: nextRunAt's local HH:MM}", () => {
    const nextRunAt = new Date(2099, 0, 1, 23, 5, 0).toISOString();
    expect(nextSlotFor(nextRunAt)).toEqual({ date: todayISODate(), slot: '23:05' });
  });

  it('returns null when there is no next run', () => {
    expect(nextSlotFor(null)).toBeNull();
  });

  it('pads single-digit hours and minutes', () => {
    const nextRunAt = new Date(2099, 0, 1, 9, 5, 0).toISOString();
    expect(nextSlotFor(nextRunAt)).toEqual({ date: todayISODate(), slot: '09:05' });
  });
});

describe('ScheduledRunsCard — loading and error', () => {
  it('loading: renders a skeleton, no rows', () => {
    stubDaemonPending();
    const { container } = renderCard();
    expect(screen.getByText('Scheduled runs')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="card-scheduled-runs"]')).not.toBeNull();
    expect(container.querySelector('[data-qa^="schedule-row-"]')).toBeNull();
  });

  it('api-unreachable: renders a Retry that recovers', async () => {
    vi.mocked(wizardApi.getDaemonStatus)
      .mockRejectedValueOnce(new Error('daemon probe failed'))
      .mockResolvedValue(baseDaemon({ profiles: [scheduleFor('harish')] }));
    renderCard();
    await screen.findByText("Can't reach the daemon API");
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('harish');
  });

  // B5 fix (QA settings-overhaul): an empty `profiles[]` (no profile has
  // `schedule.enabled` — including the committed `rajni` fixture's
  // default first-run state) used to render only the footer note, which
  // describes rows that don't exist.
  it('empty: renders the no-scheduled-runs line, no rows, and hides the footer note', async () => {
    stubDaemon(baseDaemon({ profiles: [] }));
    const { container } = renderCard();
    await screen.findByRole('link', { name: 'Settings → Schedule' });
    const empty = container.querySelector('[data-qa="scheduled-runs-empty"]');
    expect(empty?.textContent).toContain('No scheduled runs — enable a schedule in');
    expect(container.querySelector('[data-qa^="schedule-row-"]')).toBeNull();
    expect(
      screen.queryByText(/Pausing here removes a profile from this list/),
    ).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Settings → Schedule' });
    expect(link).toHaveAttribute('href', '#/settings/schedule');
  });
});

describe('ScheduledRunsCard — rows', () => {
  it('one row per daemon.profiles[] entry, the active row bg-accent', async () => {
    stubDaemon(baseDaemon({ profiles: [scheduleFor('harish'), scheduleFor('rajni')] }));
    const { container } = renderCard('harish');
    await screen.findByText('harish');
    expect(screen.getByText('rajni')).toBeInTheDocument();
    const harishRow = container.querySelector('[data-qa="schedule-row-harish"]');
    const rajniRow = container.querySelector('[data-qa="schedule-row-rajni"]');
    expect(harishRow?.className).toMatch(/bg-accent/);
    expect(rajniRow?.className).not.toMatch(/bg-accent/);
  });

  it('shows the next run HH:MM and a footer link to Settings → schedule', async () => {
    const nextRunAt = new Date(2099, 0, 1, 21, 30, 0).toISOString();
    stubDaemon(baseDaemon({ profiles: [scheduleFor('rajni', { nextRunAt })] }));
    renderCard('rajni');
    await screen.findByText(/next run 21:30/);
    const link = screen.getByRole('link', { name: 'Edit times in Settings →' });
    expect(link).toHaveAttribute('href', '#/settings/schedule');
  });

  it("schedule-skip-next: only the active row's button carries the id, and writes {date, slot}", async () => {
    const nextRunAt = new Date(2099, 0, 1, 23, 0, 0).toISOString();
    stubDaemon(
      baseDaemon({
        profiles: [scheduleFor('harish', { nextRunAt }), scheduleFor('rajni')],
      }),
    );
    vi.mocked(operateApi.putSkipNext).mockResolvedValue(undefined);
    const { container } = renderCard('harish');
    await screen.findByText('harish');

    const taggedButtons = container.querySelectorAll('[data-qa="schedule-skip-next"]');
    expect(taggedButtons).toHaveLength(1);
    const btn = taggedButtons[0];
    if (!btn) throw new Error('expected the tagged skip-next button to exist');
    expect(btn.closest('[data-qa="schedule-row-harish"]')).not.toBeNull();

    await userEvent.click(btn);
    expect(operateApi.putSkipNext).toHaveBeenCalledWith('harish', {
      date: todayISODate(),
      slot: '23:00',
    });
    await screen.findByText('Next run skipped');
  });

  // Fix-round finding: `daemon.profiles[]` can never carry
  // `enabled: false` (`scanProfileSchedules` skips those rows entirely), so
  // a two-way switch bound to `schedule.enabled` was always stuck on
  // `true` and, worse, toggling it off made the row vanish from this card
  // with no way back in. The pause action is now one-way.
  it('schedule-pause-<profile>: writes schedule.enabled=false through setScheduleEnabled for the clicked row, and shows a Paused chip', async () => {
    stubDaemon(
      baseDaemon({
        profiles: [scheduleFor('harish'), scheduleFor('rajni')],
      }),
    );
    vi.mocked(operateApi.setScheduleEnabled).mockResolvedValue(undefined);
    const { container } = renderCard('harish');
    await screen.findByText('harish');

    const btn = container.querySelector('[data-qa="schedule-pause-harish"]');
    if (!btn) throw new Error('expected the harish row pause button to exist');
    expect(btn.closest('[data-qa="schedule-row-harish"]')).not.toBeNull();

    await userEvent.click(btn);
    expect(operateApi.setScheduleEnabled).toHaveBeenCalledWith('harish', false);
    await screen.findByText('Paused');
  });

  // Re-review finding: every row's Pause button used to share the bare
  // accessible name "Pause" and only the ACTIVE row carried a `data-qa`
  // at all — neither assistive tech nor a selector could disambiguate a
  // non-active row's own Pause button.
  it("every row's Pause button carries its own profile-scoped data-qa and accessible name", async () => {
    stubDaemon(
      baseDaemon({
        profiles: [scheduleFor('harish'), scheduleFor('rajni')],
      }),
    );
    const { container } = renderCard('harish');
    await screen.findByText('harish');
    expect(screen.getByText('rajni')).toBeInTheDocument();

    expect(container.querySelector('[data-qa="schedule-pause-harish"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="schedule-pause-rajni"]')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Pause schedule — harish' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Pause schedule — rajni' }),
    ).toBeInTheDocument();
  });

  it('the footer note points a paused profile back at Settings → Schedule to resume it', async () => {
    stubDaemon(baseDaemon({ profiles: [scheduleFor('rajni')] }));
    renderCard('rajni');
    await screen.findByText('rajni');
    expect(
      screen.getByText(/Pausing here removes a profile from this list/),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Edit times in Settings →' });
    expect(link).toHaveAttribute('href', '#/settings/schedule');
  });

  it('a profile with no next run disables its skip-next button', async () => {
    stubDaemon(baseDaemon({ profiles: [scheduleFor('harish', { nextRunAt: null })] }));
    renderCard('harish');
    await screen.findByText('harish');
    expect(screen.getByRole('button', { name: 'Skip next' })).toBeDisabled();
  });
});
