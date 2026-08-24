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

  it('the per-row pause switch writes schedule.enabled through setScheduleEnabled', async () => {
    stubDaemon(baseDaemon({ profiles: [scheduleFor('rajni', { enabled: true })] }));
    vi.mocked(operateApi.setScheduleEnabled).mockResolvedValue(undefined);
    renderCard('harish');
    await screen.findByText('rajni');
    const sw = screen.getByRole('switch', { name: 'Schedule enabled — rajni' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    expect(operateApi.setScheduleEnabled).toHaveBeenCalledWith('rajni', false);
  });

  it('a profile with no next run disables its skip-next button', async () => {
    stubDaemon(baseDaemon({ profiles: [scheduleFor('harish', { nextRunAt: null })] }));
    renderCard('harish');
    await screen.findByText('harish');
    expect(screen.getByRole('button', { name: 'Skip next' })).toBeDisabled();
  });
});
