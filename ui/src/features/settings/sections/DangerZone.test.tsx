import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runIntentsApi from '../../runcontrol/intents.api';
import * as runsApi from '../../runs/runs.api';
import * as configApi from '../config.api';
import { DangerZone } from './DangerZone';

vi.mock('../config.api', () => ({ deleteProfile: vi.fn() }));
vi.mock('../../runs/runs.api', () => ({ listRuns: vi.fn() }));
vi.mock('../../runcontrol/intents.api', () => ({ listRunIntents: vi.fn() }));
vi.mock('../../../lib/router', () => ({ navigate: vi.fn() }));

function stubClear() {
  vi.mocked(runsApi.listRuns).mockResolvedValue({
    rows: [],
    total: 0,
    limit: 100,
    offset: 0,
  });
  vi.mocked(runIntentsApi.listRunIntents).mockResolvedValue({ rows: [] });
}

function renderZone(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...render(<DangerZone profile={profile} />, { wrapper }) };
}

async function openDialog() {
  await userEvent.click(await screen.findByTestId('danger-open'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('DangerZone', () => {
  it('the confirm button is disabled for a wrong name and for a right name with different case', async () => {
    stubClear();
    renderZone('rajni');
    await openDialog();
    const input = screen.getByTestId('danger-confirm-input');

    await userEvent.type(input, 'not-rajni');
    expect(screen.getByTestId('danger-confirm')).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, 'RAJNI');
    expect(screen.getByTestId('danger-confirm')).toBeDisabled();
  });

  it('the confirm button enables on an exact, case-sensitive match', async () => {
    stubClear();
    renderZone('rajni');
    await openDialog();
    await userEvent.type(screen.getByTestId('danger-confirm-input'), 'rajni');
    expect(screen.getByTestId('danger-confirm')).toBeEnabled();
  });

  it('a protected_profile 409 renders the server message verbatim', async () => {
    stubClear();
    vi.mocked(configApi.deleteProfile).mockRejectedValue(
      new Error('rajni is a protected fixture profile and cannot be removed'),
    );
    renderZone('rajni');
    await openDialog();
    await userEvent.type(screen.getByTestId('danger-confirm-input'), 'rajni');
    await userEvent.click(screen.getByTestId('danger-confirm'));

    expect(await screen.findByTestId('settings-error')).toHaveTextContent(
      'rajni is a protected fixture profile and cannot be removed',
    );
  });

  it('is disabled with explanatory text while a run is running', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [
        {
          id: 1,
          date: '2026-08-08',
          timeDir: '09-00',
          kind: 'run',
          resumedFrom: null,
          status: 'running',
          startedAt: '2026-08-08T09:00:00Z',
          finishedAt: null,
          heartbeatAt: '2026-08-08T09:01:00Z',
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    });
    vi.mocked(runIntentsApi.listRunIntents).mockResolvedValue({ rows: [] });
    renderZone('rajni');
    await openDialog();

    expect(await screen.findByText(/run in progress/i)).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('danger-confirm-input'), 'rajni');
    expect(screen.getByTestId('danger-confirm')).toBeDisabled();
  });

  it('is disabled with explanatory text while an intent is pending', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.mocked(runIntentsApi.listRunIntents).mockResolvedValue({
      rows: [
        {
          id: 1,
          requestedAt: '2026-08-08T09:00:00Z',
          status: 'pending',
          claimedRunId: null,
        },
      ],
    });
    renderZone('rajni');
    await openDialog();

    expect(await screen.findByText(/run queued/i)).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('danger-confirm-input'), 'rajni');
    expect(screen.getByTestId('danger-confirm')).toBeDisabled();
  });

  it('a success invalidates the profiles query key', async () => {
    stubClear();
    vi.mocked(configApi.deleteProfile).mockResolvedValue({
      removed: true,
      name: 'p4-test',
    });
    const { qc } = renderZone('p4-test');
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    await openDialog();
    await userEvent.type(screen.getByTestId('danger-confirm-input'), 'p4-test');
    await userEvent.click(screen.getByTestId('danger-confirm'));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['profiles'] }),
      );
    });
  });
});
